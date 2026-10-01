"""KIRO campaigns: visual, graph-based Telegram campaigns with limits, promo codes and conversion reports.

Admin API: /api/admin/kiro-campaigns/*   (Core admin middleware resolves the role)
Only Telegram delivery. A background job runs the engine once a minute while the master switch is on.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
from datetime import UTC, datetime
from typing import Any

from aiohttp import web
from sqlalchemy import text

from bot.app.web.context import get_session_factory
from bot.plugins.extensions.contracts import ExtensionContributions, JobHandler, OperationContext
from bot.plugins.spec import WEB_SCOPE_WEBAPP, Plugin, PluginContext

from . import graph as g
from . import reports
from .audience import FILTER_FIELDS
from .core import CoreHost, html_error, shortcode_names, unknown_codes
from .engine import Engine, jload
from .presets import PRESETS, blank_graph
from .storage import MIGRATIONS, PLUGIN_ID, clean_settings, load_settings, save_settings

logger = logging.getLogger(__name__)

ADMIN = f"/api/admin/{PLUGIN_ID}"
IMAGE_TYPES = {b"\x89PNG": "image/png", b"\xff\xd8\xff": "image/jpeg"}
MAX_IMAGE_BYTES = 1024 * 1024
RUNTIME: dict[str, PluginContext] = {}


class CampaignError(Exception):
    def __init__(self, code: str, status: int = 400, **extra: Any) -> None:
        super().__init__(code)
        self.code, self.status, self.extra = code, status, extra


def _ok(payload: dict[str, Any] | None = None) -> web.Response:
    return web.json_response({"ok": True, **(payload or {})}, dumps=lambda v: json.dumps(v, ensure_ascii=False, default=str))


def _err(code: str, status: int = 400, **extra: Any) -> web.Response:
    return web.json_response({"ok": False, "error": code, **extra}, status=status)


def _admin(request: web.Request) -> None:
    if not request.get("admin_authorized", False):
        raise CampaignError("forbidden", 403)


async def _body(request: web.Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise CampaignError("invalid_json") from None
    if not isinstance(body, dict):
        raise CampaignError("invalid_json")
    return body


def _guard(handler):
    async def wrapped(request: web.Request) -> web.Response:
        try:
            _admin(request)
            return await handler(request)
        except CampaignError as exc:
            return _err(exc.code, exc.status, **exc.extra)
        except g.GraphError as exc:
            return _err(str(exc), 400)
        except web.HTTPException:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("kiro-campaigns: %s %s failed", request.method, request.path)
            return _err("internal_error", 500)

    return wrapped


def _runtime(request: web.Request) -> PluginContext:
    ctx = RUNTIME.get("ctx")
    if ctx is None:
        raise CampaignError("not_ready", 503)
    return ctx


def _factory(request: web.Request):
    return get_session_factory(request)


async def _campaign(session: Any, campaign_id: int) -> dict[str, Any]:
    row = (
        await session.execute(
            text(
                "select id, name, status, graph, live_version, options, last_run_key, created_at, updated_at, started_at, finished_at "
                "from ext_kiro_campaigns where id = :i"
            ),
            {"i": campaign_id},
        )
    ).mappings().first()
    if row is None:
        raise CampaignError("not_found", 404)
    data = dict(row)
    data["graph"] = jload(data["graph"])
    data["options"] = jload(data["options"]) or {}
    return data


def _issues(graph: dict[str, Any]) -> list[dict[str, str]]:
    return g.validate_graph(graph, html_error=html_error, unknown_codes=unknown_codes)


def _clean_options(raw: Any, current: dict[str, Any] | None = None) -> dict[str, Any]:
    options = dict(current or {})
    if isinstance(raw, dict) and "exit_on_payment" in raw:
        options["exit_on_payment"] = bool(raw["exit_on_payment"])
    options.setdefault("exit_on_payment", True)
    return options


def _cid(request: web.Request) -> int:
    try:
        return int(request.match_info["cid"])
    except (KeyError, ValueError):
        raise CampaignError("not_found", 404) from None


async def _resolve_user(session: Any, ref: str) -> int:
    ref = str(ref or "").strip()
    if not ref:
        raise CampaignError("user_required")
    if ref.startswith("@") or not ref.lstrip("-").isdigit():
        uid = await session.scalar(text("select user_id from users where lower(username) = lower(:r)"), {"r": ref.lstrip("@")})
    else:
        uid = await session.scalar(text("select user_id from users where user_id = :r or telegram_id = :r limit 1"), {"r": int(ref)})
    if uid is None:
        raise CampaignError("user_not_found", 404)
    return int(uid)


# ------------------------------------------------------------------------- meta / settings


async def meta(request: web.Request) -> web.Response:
    async with _factory(request)() as session:
        settings = await load_settings(session)
    return _ok({
        "catalog": g.catalog_meta(),
        "presets": [{"id": k, "title": v["title"], "description": v["description"]} for k, v in PRESETS.items()],
        "settings": settings,
        "filter_fields": FILTER_FIELDS,
        "shortcodes": shortcode_names(),
    })


async def get_settings(request: web.Request) -> web.Response:
    async with _factory(request)() as session:
        return _ok({"settings": await load_settings(session)})


async def put_settings(request: web.Request) -> web.Response:
    body = await _body(request)
    async with _factory(request)() as session:
        try:
            data = clean_settings(body, await load_settings(session))
        except ValueError as exc:
            raise CampaignError(str(exc)) from None
        await save_settings(session, data)
        await session.commit()
    return _ok({"settings": data})


# ------------------------------------------------------------------------- campaigns CRUD


async def list_campaigns(request: web.Request) -> web.Response:
    async with _factory(request)() as session:
        settings = await load_settings(session)
        rows = (
            await session.execute(
                text(
                    "select id, name, status, live_version, created_at, updated_at, started_at, "
                    "(select count(*) from jsonb_array_elements(graph->'nodes')) as nodes, "
                    "(select n->>'type' from jsonb_array_elements(graph->'nodes') n where n->>'type' like 'trg_%' limit 1) as trigger "
                    "from ext_kiro_campaigns where status <> 'archived' or :all order by id desc"
                ),
                {"all": request.query.get("archived") == "1"},
            )
        ).mappings().all()
        stats = await reports.overview(session, int(settings["attribution_days"]))
    items = [{**dict(r), "stats": stats.get(r["id"], {})} for r in rows]
    return _ok({"campaigns": items, "engine_enabled": settings["engine_enabled"], "window_days": settings["attribution_days"]})


async def create_campaign(request: web.Request) -> web.Response:
    body = await _body(request)
    name = str(body.get("name") or "").strip()[:120]
    preset = str(body.get("preset") or "")
    if preset and preset not in PRESETS:
        raise CampaignError("unknown_preset")
    graph = g.clean_graph(PRESETS[preset]["graph"] if preset else blank_graph())
    name = name or (PRESETS[preset]["title"] if preset else "Новая кампания")
    async with _factory(request)() as session:
        cid = await session.scalar(
            text("insert into ext_kiro_campaigns (name, status, graph, options) values (:n, 'draft', cast(:g as jsonb), cast(:o as jsonb)) returning id"),
            {"n": name, "g": json.dumps(graph, ensure_ascii=False), "o": json.dumps(_clean_options({}))},
        )
        await session.commit()
    return _ok({"id": cid})


async def get_campaign(request: web.Request) -> web.Response:
    async with _factory(request)() as session:
        camp = await _campaign(session, _cid(request))
        live = None
        if camp["live_version"]:
            raw = await session.scalar(
                text("select graph from ext_kiro_campaigns_versions where campaign_id = :c and version = :v"),
                {"c": camp["id"], "v": camp["live_version"]},
            )
            live = jload(raw)
    camp["live_graph"] = live
    camp["unpublished"] = live != camp["graph"]
    camp["issues"] = _issues(camp["graph"])
    return _ok({"campaign": camp})


async def save_campaign(request: web.Request) -> web.Response:
    body = await _body(request)
    cid = _cid(request)
    async with _factory(request)() as session:
        camp = await _campaign(session, cid)
        graph = g.clean_graph(body["graph"]) if "graph" in body else camp["graph"]
        name = str(body.get("name") or camp["name"]).strip()[:120] or camp["name"]
        options = _clean_options(body.get("options"), camp["options"])
        await session.execute(
            text("update ext_kiro_campaigns set name = :n, graph = cast(:g as jsonb), options = cast(:o as jsonb), updated_at = now() where id = :i"),
            {"n": name, "g": json.dumps(graph, ensure_ascii=False), "o": json.dumps(options), "i": cid},
        )
        await session.commit()
    return _ok({"issues": _issues(graph)})


async def publish_campaign(request: web.Request) -> web.Response:
    cid = _cid(request)
    async with _factory(request)() as session:
        camp = await _campaign(session, cid)
        issues = _issues(camp["graph"])
        if g.has_errors(issues):
            raise CampaignError("graph_invalid", issues=issues)
        version = int(camp["live_version"]) + 1
        await session.execute(
            text("insert into ext_kiro_campaigns_versions (campaign_id, version, graph) values (:c, :v, cast(:g as jsonb))"),
            {"c": cid, "v": version, "g": json.dumps(camp["graph"], ensure_ascii=False)},
        )
        await session.execute(text("update ext_kiro_campaigns set live_version = :v, updated_at = now() where id = :c"), {"v": version, "c": cid})
        await session.commit()
    return _ok({"version": version, "issues": issues})


_TRANSITIONS = {
    "start": ({"draft", "finished"}, "active"),
    "pause": ({"active"}, "paused"),
    "resume": ({"paused"}, "active"),
    "stop": ({"active", "paused"}, "finished"),
    "archive": ({"draft", "finished", "paused"}, "archived"),
    "restore": ({"archived"}, "draft"),
}


async def campaign_action(request: web.Request) -> web.Response:
    action = request.match_info["action"]
    if action not in _TRANSITIONS:
        raise CampaignError("unknown_action", 404)
    cid = _cid(request)
    allowed, target = _TRANSITIONS[action]
    async with _factory(request)() as session:
        camp = await _campaign(session, cid)
        if camp["status"] not in allowed:
            raise CampaignError("bad_state", 409, status=camp["status"])
        if action == "start":
            if not camp["live_version"]:
                raise CampaignError("not_published")
            await session.execute(
                text("update ext_kiro_campaigns set status = 'active', started_at = now(), finished_at = null, last_run_key = null, updated_at = now() where id = :i"),
                {"i": cid},
            )
        elif action == "resume":
            # Shift waits by the length of the pause so a long pause does not release everybody at once.
            await session.execute(
                text(
                    "update ext_kiro_campaigns_enrollments set wait_until = greatest(wait_until, now()) + "
                    "(now() - (select updated_at from ext_kiro_campaigns where id = :i)) "
                    "where campaign_id = :i and status = 'active'"
                ),
                {"i": cid},
            )
            await session.execute(text("update ext_kiro_campaigns set status = 'active', updated_at = now() where id = :i"), {"i": cid})
        elif action == "stop":
            await session.execute(
                text("update ext_kiro_campaigns_enrollments set status = 'exited', exit_reason = 'stopped', finished_at = now() where campaign_id = :i and status = 'active'"),
                {"i": cid},
            )
            await session.execute(text("update ext_kiro_campaigns set status = 'finished', finished_at = now(), updated_at = now() where id = :i"), {"i": cid})
        else:
            await session.execute(text("update ext_kiro_campaigns set status = :s, updated_at = now() where id = :i"), {"s": target, "i": cid})
        settings = await load_settings(session)
        await session.commit()
    return _ok({"status": target, "engine_enabled": settings["engine_enabled"]})


async def delete_campaign(request: web.Request) -> web.Response:
    cid = _cid(request)
    async with _factory(request)() as session:
        camp = await _campaign(session, cid)
        if camp["status"] not in ("draft", "archived"):
            raise CampaignError("bad_state", 409, status=camp["status"])
        await session.execute(text("delete from ext_kiro_campaigns_events where campaign_id = :i"), {"i": cid})
        await session.execute(text("delete from ext_kiro_campaigns where id = :i"), {"i": cid})
        await session.commit()
    return _ok()


async def duplicate_campaign(request: web.Request) -> web.Response:
    cid = _cid(request)
    async with _factory(request)() as session:
        camp = await _campaign(session, cid)
        new_id = await session.scalar(
            text("insert into ext_kiro_campaigns (name, status, graph, options) values (:n, 'draft', cast(:g as jsonb), cast(:o as jsonb)) returning id"),
            {"n": f"{camp['name']} (копия)"[:120], "g": json.dumps(camp["graph"], ensure_ascii=False), "o": json.dumps(camp["options"])},
        )
        await session.commit()
    return _ok({"id": new_id})


# ------------------------------------------------------------------------- safety tools


def _engine(request: web.Request, factory: Any = None) -> Engine:
    ctx = _runtime(request)
    return Engine(factory or ctx.require_session_factory(), CoreHost(ctx))


async def dry_run(request: web.Request) -> web.Response:
    body = await _body(request)
    cid = _cid(request)
    async with _factory(request)() as session:
        camp = await _campaign(session, cid)
        graph = g.clean_graph(body["graph"]) if "graph" in body else camp["graph"]
        settings = await load_settings(session)
        result = await _engine(request).count_candidates(session, graph, settings, camp_id=cid)
        await session.commit()
    return _ok(result)


async def simulate(request: web.Request) -> web.Response:
    body = await _body(request)
    cid = _cid(request)
    async with _factory(request)() as session:
        camp = await _campaign(session, cid)
        graph = g.clean_graph(body["graph"]) if "graph" in body else camp["graph"]
        uid = await _resolve_user(session, body.get("user"))
        settings = await load_settings(session)
        path = await _engine(request).simulate(session, graph, uid, settings, campaign_id=cid)
        await session.rollback()
    return _ok({"user_id": uid, "path": path})


async def send_test(request: web.Request) -> web.Response:
    body = await _body(request)
    cid = _cid(request)
    node_id = str(body.get("node_id") or "")
    admin_tg = request.get("admin_telegram_id")
    if not admin_tg:
        raise CampaignError("admin_telegram_unavailable", 403)
    async with _factory(request)() as session:
        camp = await _campaign(session, cid)
        graph = g.clean_graph(body["graph"]) if "graph" in body else camp["graph"]
        node = next((n for n in graph["nodes"] if n["id"] == node_id and n["type"] == "send_message"), None)
        if node is None:
            raise CampaignError("node_not_found", 404)
        uid = await session.scalar(text("select user_id from users where telegram_id = :t"), {"t": int(admin_tg)})
        host = CoreHost(_runtime(request))
        result = await host.send_test(session, chat_id=int(admin_tg), user_id=int(uid or admin_tg), params=node["params"])
        await session.rollback()
    if result.status != "sent":
        raise CampaignError("test_failed", 502, detail=result.error)
    return _ok()


async def exclude_user(request: web.Request) -> web.Response:
    body = await _body(request)
    cid = _cid(request)
    async with _factory(request)() as session:
        uid = await _resolve_user(session, body.get("user"))
        result = await session.execute(
            text(
                "update ext_kiro_campaigns_enrollments set status = 'exited', exit_reason = 'manual', finished_at = now() "
                "where campaign_id = :c and user_id = :u and status = 'active'"
            ),
            {"c": cid, "u": uid},
        )
        await session.commit()
    return _ok({"removed": result.rowcount or 0})


async def tick_now(request: web.Request) -> web.Response:
    stats = await _engine(request).tick(budget_seconds=40)
    return _ok({"stats": stats})


# ------------------------------------------------------------------------- reports / journal


async def report(request: web.Request) -> web.Response:
    cid = _cid(request)
    async with _factory(request)() as session:
        settings = await load_settings(session)
        await _campaign(session, cid)
        window = int(request.query.get("window") or settings["attribution_days"])
        data = await reports.campaign_report(session, cid, max(1, min(window, 90)))
    return _ok({"report": data})


async def journal(request: web.Request) -> web.Response:
    cid = _cid(request)
    limit = max(1, min(int(request.query.get("limit") or 50), 200))
    offset = max(0, int(request.query.get("offset") or 0))
    kind = request.query.get("kind") or ""
    user = request.query.get("user") or ""
    where, args = ["e.campaign_id = :c", "e.kind <> 'visit'"], {"c": cid, "l": limit, "o": offset}
    if kind:
        where.append("e.kind = :k")
        args["k"] = kind
    if user.strip().lstrip("-").isdigit():
        where.append("e.user_id = :u")
        args["u"] = int(user)
    async with _factory(request)() as session:
        rows = (
            await session.execute(
                text(
                    "select e.id, e.user_id, e.node_id, e.node_type, e.kind, e.detail, e.created_at, u.username, u.first_name "
                    f"from ext_kiro_campaigns_events e left join users u on u.user_id = e.user_id where {' and '.join(where)} "
                    "order by e.id desc limit :l offset :o"
                ),
                args,
            )
        ).mappings().all()
    return _ok({"events": [{**dict(r), "detail": jload(r["detail"])} for r in rows]})


async def analytics(request: web.Request) -> web.Response:
    days = max(7, min(int(request.query.get("days") or 30), 180))
    async with _factory(request)() as session:
        settings = await load_settings(session)
        data = await reports.analytics(session, days, int(settings["attribution_days"]), int(settings["tz_offset_hours"]))
    return _ok({"analytics": data})


# ------------------------------------------------------------------------- images


def _image_type(raw: bytes) -> str | None:
    for magic, content_type in IMAGE_TYPES.items():
        if raw.startswith(magic):
            return content_type
    return None


async def upload_image(request: web.Request) -> web.Response:
    body = await _body(request)
    try:
        raw = base64.b64decode(str(body.get("data") or ""), validate=True)
    except ValueError:
        raise CampaignError("invalid_image") from None
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise CampaignError("image_too_large")
    content_type = _image_type(raw)
    if content_type is None:
        raise CampaignError("unsupported_image")
    image_id = hashlib.sha256(raw).hexdigest()[:40]
    async with _factory(request)() as session:
        await session.execute(
            text("insert into ext_kiro_campaigns_images (id, content_type, body) values (:i, :t, :b) on conflict (id) do nothing"),
            {"i": image_id, "t": content_type, "b": raw},
        )
        await session.commit()
    return _ok({"image_id": image_id, "url": f"{ADMIN}/img/{image_id}"})


async def get_image(request: web.Request) -> web.Response:
    image_id = request.match_info["image_id"]
    if not image_id.isalnum():
        raise CampaignError("not_found", 404)
    async with _factory(request)() as session:
        row = (await session.execute(text("select content_type, body from ext_kiro_campaigns_images where id = :i"), {"i": image_id})).first()
    if row is None:
        raise CampaignError("not_found", 404)
    return web.Response(body=bytes(row[1]), content_type=row[0], headers={"Cache-Control": "private, max-age=3600"})


# ------------------------------------------------------------------------- engine job


async def _tick(op: OperationContext, payload: dict[str, Any]) -> dict[str, Any]:
    ctx = op.runtime
    RUNTIME["ctx"] = ctx
    op.assert_current()
    engine = Engine(ctx.require_session_factory(), CoreHost(ctx))
    # Leave the worker free for other plugins' durable jobs (payment alerts, wheel spins).
    stats = await engine.tick(budget_seconds=30)
    return {"at": datetime.now(UTC).isoformat(), **stats}


class KiroCampaignsPlugin(Plugin):
    name = PLUGIN_ID
    version = "0.1.0"
    plugin_api_min_version = 1
    plugin_api_max_version = 1

    def setup(self, ctx: PluginContext) -> None:
        RUNTIME["ctx"] = ctx

    def migrations(self):
        return MIGRATIONS

    def extensions(self, ctx: PluginContext) -> ExtensionContributions:
        return ExtensionContributions(
            jobs=(JobHandler(id="tick", run=_tick, timeout_seconds=55, max_attempts=1, interval_seconds=60),),
        )

    def setup_web(self, ctx: PluginContext, app: web.Application, *, scope: str) -> None:
        if scope != WEB_SCOPE_WEBAPP:
            return
        RUNTIME["ctx"] = ctx
        r = app.router
        r.add_get(f"{ADMIN}/meta", _guard(meta))
        r.add_get(f"{ADMIN}/settings", _guard(get_settings))
        r.add_put(f"{ADMIN}/settings", _guard(put_settings))
        r.add_get(f"{ADMIN}/campaigns", _guard(list_campaigns))
        r.add_post(f"{ADMIN}/campaigns", _guard(create_campaign))
        r.add_get(ADMIN + "/campaigns/{cid:\\d+}", _guard(get_campaign))
        r.add_put(ADMIN + "/campaigns/{cid:\\d+}", _guard(save_campaign))
        r.add_delete(ADMIN + "/campaigns/{cid:\\d+}", _guard(delete_campaign))
        r.add_post(ADMIN + "/campaigns/{cid:\\d+}/publish", _guard(publish_campaign))
        r.add_post(ADMIN + "/campaigns/{cid:\\d+}/duplicate", _guard(duplicate_campaign))
        r.add_post(ADMIN + "/campaigns/{cid:\\d+}/dry-run", _guard(dry_run))
        r.add_post(ADMIN + "/campaigns/{cid:\\d+}/simulate", _guard(simulate))
        r.add_post(ADMIN + "/campaigns/{cid:\\d+}/test", _guard(send_test))
        r.add_post(ADMIN + "/campaigns/{cid:\\d+}/exclude", _guard(exclude_user))
        r.add_get(ADMIN + "/campaigns/{cid:\\d+}/report", _guard(report))
        r.add_get(ADMIN + "/campaigns/{cid:\\d+}/journal", _guard(journal))
        r.add_post(ADMIN + "/campaigns/{cid:\\d+}/{action:start|pause|resume|stop|archive|restore}", _guard(campaign_action))
        r.add_get(f"{ADMIN}/analytics", _guard(analytics))
        r.add_post(f"{ADMIN}/images", _guard(upload_image))
        r.add_get(ADMIN + "/img/{image_id}", _guard(get_image))
        r.add_post(f"{ADMIN}/engine/tick", _guard(tick_now))


plugin = KiroCampaignsPlugin()
