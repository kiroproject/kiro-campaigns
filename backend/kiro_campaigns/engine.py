"""Campaign engine: discovers entrants, walks the graph per enrollment, enforces limits.

Everything that needs Core (sending a Telegram message, issuing a promo code, notifying admins,
reading the user's consent) goes through the `Host` adapter, so the logic here can be exercised on a
plain PostgreSQL schema.

Delivery is at-most-once per (enrollment, node): the 'sent' event is written in the same
transaction that advances the enrollment, and a failed batch is rolled back before anything is sent
only for the failing enrollment (each one runs in its own savepoint).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .audience import ACTIVE, BASE_FROM, candidates_sql, eligible_sql
from .graph import TRIGGERS, next_node, trigger_of
from .storage import load_settings

logger = logging.getLogger(__name__)

MAX_NODE_STEPS = 25
DISCOVERY_LIMIT = 2000
BATCH = 100
RETRY_DELAYS = (300, 900, 3600)  # seconds before the 2nd, 3rd and 4th attempt of a failed send


@dataclass
class SendResult:
    status: str  # sent | blocked | failed
    error: str = ""
    message_id: int | None = None


class Host(Protocol):
    async def send_message(
        self, session: AsyncSession, *, user: dict[str, Any], params: dict[str, Any], ctx: dict[str, Any], campaign: str
    ) -> SendResult: ...

    async def issue_promo(self, session: AsyncSession, *, user_id: int, params: dict[str, Any]) -> str: ...

    async def notify_admins(self, text_: str) -> None: ...

    async def allows(self, session: AsyncSession, *, user_id: int, category: str, respect: bool) -> bool: ...


@dataclass
class Outcome:
    kind: str  # next | park | end
    port: str = "out"
    until: datetime | None = None
    status: str = "done"
    reason: str = ""
    detail: dict[str, Any] = field(default_factory=dict)
    logged: bool = True  # False for deferrals: they must not count as a node visit


def jload(value: Any) -> Any:
    if isinstance(value, (dict, list)) or value is None:
        return value
    return json.loads(value)


def local_time(now: datetime, settings: dict[str, Any]) -> datetime:
    return now + timedelta(hours=int(settings["tz_offset_hours"]))


def in_quiet(now: datetime, settings: dict[str, Any]) -> bool:
    if not settings["quiet_enabled"]:
        return False
    start, end = int(settings["quiet_from"]), int(settings["quiet_to"])
    if start == end:
        return False
    hour = local_time(now, settings).hour
    return (start <= hour < end) if start < end else (hour >= start or hour < end)


def next_local_hour(now: datetime, hour: int, settings: dict[str, Any]) -> datetime:
    """The next moment (UTC) at which the local clock shows `hour`:00."""
    local = local_time(now, settings)
    target = local.replace(hour=hour, minute=0, second=0, microsecond=0)
    if target <= local:
        target += timedelta(days=1)
    return target - timedelta(hours=int(settings["tz_offset_hours"]))


def split_bucket(campaign_id: int, node_id: str, user_id: int) -> int:
    digest = hashlib.sha256(f"{campaign_id}:{node_id}:{user_id}".encode()).hexdigest()
    return int(digest[:8], 16) % 100


class RenderCache:
    """Placeholder for per-tick caches (graphs by version)."""

    def __init__(self) -> None:
        self.graphs: dict[tuple[int, int], dict[str, Any]] = {}


class Engine:
    def __init__(
        self,
        session_factory: Callable[[], AsyncSession],
        host: Host,
        *,
        clock: Callable[[], datetime] | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.session_factory = session_factory
        self.host = host
        self.clock = clock or (lambda: datetime.now(UTC))
        self.sleep = sleep

    # ------------------------------------------------------------------ tick

    async def tick(self, budget_seconds: float = 45.0) -> dict[str, int]:
        started = asyncio.get_event_loop().time()
        stats = {"entered": 0, "processed": 0, "sent": 0}
        async with self.session_factory() as session:
            # One engine at a time, even if two workers wake up together.
            locked = await session.scalar(text("select pg_try_advisory_xact_lock(hashtext('kiro-campaigns-tick'))"))
            if not locked:
                return stats
            settings = await load_settings(session)
            if not settings["engine_enabled"]:
                await session.rollback()
                return stats
            campaigns = await self._active_campaigns(session)
            for camp in campaigns:
                try:
                    stats["entered"] += await self.discover(session, camp, settings)
                except Exception:  # noqa: BLE001
                    logger.exception("kiro-campaigns: discovery failed for campaign %s", camp["id"])
            await self._finish_one_shots(session)
            await session.commit()
        cache = RenderCache()
        while asyncio.get_event_loop().time() - started < budget_seconds:
            done = await self._process_batch(settings, cache, stats)
            if done == 0:
                break
        async with self.session_factory() as session:
            await self._finish_one_shots(session)
            await session.commit()
        return stats

    async def _finish_one_shots(self, session: AsyncSession) -> None:
        """A 'now'/'at' broadcast is finished once it has entered everyone and nobody is left in flight."""
        await session.execute(
            text(
                "update ext_kiro_campaigns c set status = 'finished', finished_at = now(), updated_at = now() "
                "where c.status = 'active' and c.last_run_key is not null "
                "and exists (select 1 from ext_kiro_campaigns_versions v where v.campaign_id = c.id and v.version = c.live_version "
                "  and exists (select 1 from jsonb_array_elements(v.graph->'nodes') n "
                "     where n->>'type' = 'trg_broadcast' and n->'params'->>'mode' in ('now','at'))) "
                "and not exists (select 1 from ext_kiro_campaigns_enrollments e where e.campaign_id = c.id and e.status = 'active')"
            )
        )

    async def _active_campaigns(self, session: AsyncSession) -> list[dict[str, Any]]:
        rows = (
            await session.execute(
                text(
                    "select c.id, c.name, c.options, c.live_version, c.last_run_key, c.started_at, v.graph "
                    "from ext_kiro_campaigns c "
                    "join ext_kiro_campaigns_versions v on v.campaign_id = c.id and v.version = c.live_version "
                    "where c.status = 'active' order by c.id"
                )
            )
        ).mappings().all()
        return [
            {**dict(r), "graph": jload(r["graph"]), "options": jload(r["options"]) or {}} for r in rows
        ]

    # ------------------------------------------------------------- discovery

    def broadcast_run_key(self, camp: dict[str, Any], params: dict[str, Any], settings: dict[str, Any]) -> str | None:
        now = self.clock()
        local = local_time(now, settings)
        mode = params["mode"]
        if mode == "now":
            started = camp["started_at"] or now
            key = "n" + started.astimezone(UTC).strftime("%Y%m%d%H%M")
        elif mode == "at":
            try:
                at_local = datetime.fromisoformat(params["at"])
            except ValueError:
                return None
            at_utc = at_local.replace(tzinfo=None) - timedelta(hours=int(settings["tz_offset_hours"]))
            if now.replace(tzinfo=None) < at_utc:
                return None
            key = "a" + at_local.strftime("%Y%m%d%H%M")
        elif mode in ("daily", "weekly"):
            hh, mm = (int(x) for x in params["time"].split(":"))
            if (local.hour, local.minute) < (hh, mm):
                return None
            if mode == "weekly" and local.weekday() not in params["weekdays"]:
                return None
            key = ("d" if mode == "daily" else "w") + local.strftime("%Y%m%d")
        else:
            return None
        return None if camp["last_run_key"] == key else key

    async def discover(self, session: AsyncSession, camp: dict[str, Any], settings: dict[str, Any]) -> int:
        graph = camp["graph"]
        trigger = trigger_of(graph)
        if trigger is None:
            return 0
        first = next_node(graph, trigger["id"])
        if first is None:
            return 0
        params, run_key = trigger["params"], ""
        if trigger["type"] == "trg_broadcast":
            run_key = self.broadcast_run_key(camp, params, settings) or ""
            if not run_key:
                return 0
        cand_sql, args = candidates_sql(trigger["type"], params, run_key=run_key)
        guard = (
            "e.entry_key = c.entry_key"
            if trigger["type"] == "trg_broadcast"
            else "(e.entry_key = c.entry_key OR e.entered_at > now() - (cast(:cooldown as integer) * interval '1 day'))"
        )
        sql = f"""
            WITH ins AS (
                INSERT INTO ext_kiro_campaigns_enrollments (campaign_id, version, user_id, entry_key, node_id, wait_until)
                SELECT :cid, :ver, c.user_id, c.entry_key, :first, now()
                FROM ({cand_sql}) c
                WHERE NOT EXISTS (
                    SELECT 1 FROM ext_kiro_campaigns_enrollments e
                    WHERE e.campaign_id = :cid AND e.user_id = c.user_id AND {guard}
                )
                LIMIT :lim
                ON CONFLICT (campaign_id, user_id, entry_key) DO NOTHING
                RETURNING id, user_id
            )
            INSERT INTO ext_kiro_campaigns_events (campaign_id, version, enrollment_id, user_id, node_id, node_type, kind)
            SELECT :cid, :ver, id, user_id, :tid, :ttype, 'visit' FROM ins
        """
        limit = 1_000_000 if trigger["type"] == "trg_broadcast" else DISCOVERY_LIMIT
        result = await session.execute(
            text(sql),
            {
                **args,
                "cid": camp["id"], "ver": camp["live_version"], "first": first, "lim": limit,
                "cooldown": int(settings["cooldown_days"]), "tid": trigger["id"], "ttype": trigger["type"],
            },
        )
        entered = result.rowcount or 0
        if run_key:
            await session.execute(
                text("update ext_kiro_campaigns set last_run_key = :k, updated_at = now() where id = :id"),
                {"k": run_key, "id": camp["id"]},
            )
        return entered

    async def count_candidates(self, session: AsyncSession, graph: dict[str, Any], settings: dict[str, Any], *, camp_id: int = 0) -> dict[str, Any]:
        """Dry run: how many users would enter right now, with a few sample ids."""
        trigger = trigger_of(graph)
        if trigger is None:
            return {"count": 0, "sample": []}
        run_key = "dry" if trigger["type"] == "trg_broadcast" else ""
        cand_sql, args = candidates_sql(trigger["type"], trigger["params"], run_key=run_key)
        total = await session.scalar(text(f"select count(*) from ({cand_sql}) c"), args)
        sample = (await session.execute(text(f"select user_id from ({cand_sql}) c order by user_id limit 5"), args)).scalars().all()
        scheduled = trigger["type"] == "trg_broadcast" and trigger["params"]["mode"] in ("daily", "weekly", "at")
        return {"count": int(total or 0), "sample": [int(x) for x in sample], "scheduled": scheduled}

    # ------------------------------------------------------------- processing

    async def _graph(self, session: AsyncSession, cache: RenderCache, campaign_id: int, version: int) -> dict[str, Any] | None:
        key = (campaign_id, version)
        if key not in cache.graphs:
            raw = await session.scalar(
                text("select graph from ext_kiro_campaigns_versions where campaign_id = :c and version = :v"),
                {"c": campaign_id, "v": version},
            )
            cache.graphs[key] = jload(raw)
        return cache.graphs[key]

    async def _process_batch(self, settings: dict[str, Any], cache: RenderCache, stats: dict[str, int]) -> int:
        async with self.session_factory() as session:
            rows = (
                await session.execute(
                    text(
                        "select e.id, e.campaign_id, e.version, e.user_id, e.node_id, e.holdout, e.ctx, "
                        "e.entered_at, e.deferred_since, c.name, c.options "
                        "from ext_kiro_campaigns_enrollments e "
                        "join ext_kiro_campaigns c on c.id = e.campaign_id and c.status = 'active' "
                        "where e.status = 'active' and e.wait_until <= now() "
                        "order by e.wait_until limit :n for update of e skip locked"
                    ),
                    {"n": BATCH},
                )
            ).mappings().all()
            for row in rows:
                enr = dict(row)
                enr["ctx"] = jload(enr["ctx"]) or {}
                enr["options"] = jload(enr["options"]) or {}
                graph = await self._graph(session, cache, enr["campaign_id"], enr["version"])
                try:
                    async with session.begin_nested():
                        await self.advance(session, enr, graph, settings, stats)
                except Exception:  # noqa: BLE001
                    logger.exception("kiro-campaigns: enrollment %s failed", enr["id"])
                    await session.execute(
                        text(
                            "update ext_kiro_campaigns_enrollments set status = 'error', exit_reason = 'exception', "
                            "finished_at = now(), updated_at = now() where id = :id"
                        ),
                        {"id": enr["id"]},
                    )
                stats["processed"] += 1
            await session.commit()
            return len(rows)

    async def _event(
        self, session: AsyncSession, enr: dict[str, Any], node: dict[str, Any] | None, kind: str, detail: dict[str, Any] | None = None
    ) -> None:
        await session.execute(
            text(
                "insert into ext_kiro_campaigns_events (campaign_id, version, enrollment_id, user_id, node_id, node_type, kind, detail) "
                "values (:c, :v, :e, :u, :n, :t, :k, cast(:d as jsonb))"
            ),
            {
                "c": enr["campaign_id"], "v": enr["version"], "e": enr["id"], "u": enr["user_id"],
                "n": node["id"] if node else None, "t": node["type"] if node else None, "k": kind,
                "d": json.dumps(detail, ensure_ascii=False) if detail else None,
            },
        )

    async def _save(self, session: AsyncSession, enr: dict[str, Any], **fields: Any) -> None:
        sets, args = ["updated_at = now()"], {"id": enr["id"]}
        for key, value in fields.items():
            if key == "ctx":
                sets.append("ctx = cast(:ctx as jsonb)")
                args["ctx"] = json.dumps(value, ensure_ascii=False)
            elif key == "finished":
                sets.append("finished_at = now()")
            else:
                sets.append(f"{key} = :{key}")
                args[key] = value
        await session.execute(text(f"update ext_kiro_campaigns_enrollments set {', '.join(sets)} where id = :id"), args)

    async def advance(
        self, session: AsyncSession, enr: dict[str, Any], graph: dict[str, Any] | None, settings: dict[str, Any], stats: dict[str, int]
    ) -> None:
        if graph is None:
            await self._save(session, enr, status="error", exit_reason="no_graph", finished=True)
            return
        nodes = {n["id"]: n for n in graph["nodes"]}
        trigger = trigger_of(graph)
        enr["trigger_type"] = trigger["type"] if trigger else ""
        for _ in range(MAX_NODE_STEPS):
            node = nodes.get(enr["node_id"] or "")
            if node is None:
                await self._finish(session, enr, None, "done", "end")
                return
            outcome = await self.execute(session, enr, node, graph, settings, stats)
            if outcome.logged:
                await self._event(session, enr, node, "visit", outcome.detail or None)
            if outcome.kind == "end":
                await self._finish(session, enr, node, outcome.status, outcome.reason)
                return
            target = next_node(graph, node["id"], outcome.port)
            if outcome.kind == "park":
                if outcome.logged and target is None:
                    await self._finish(session, enr, node, "done", "end")
                    return
                fields: dict[str, Any] = {"wait_until": outcome.until, "ctx": enr["ctx"]}
                if outcome.logged:  # a real step was taken: move on
                    fields["node_id"] = target
                    fields["deferred_since"] = None
                elif enr["deferred_since"] is None:
                    fields["deferred_since"] = self.clock()
                await self._save(session, enr, **fields)
                return
            # next
            if target is None:
                await self._finish(session, enr, node, "done", "end")
                return
            enr["node_id"] = target
            enr["deferred_since"] = None
            await self._save(session, enr, node_id=target, ctx=enr["ctx"], deferred_since=None, holdout=enr["holdout"])
        await self._finish(session, enr, None, "error", "too_many_steps")

    async def _finish(self, session: AsyncSession, enr: dict[str, Any], node: dict[str, Any] | None, status: str, reason: str) -> None:
        await self._save(session, enr, status=status, exit_reason=reason[:32], ctx=enr["ctx"], holdout=enr["holdout"], finished=True)

    # ------------------------------------------------------------ node logic

    async def _user(self, session: AsyncSession, user_id: int) -> dict[str, Any] | None:
        row = (
            await session.execute(
                text(
                    "select user_id, telegram_id, language_code, first_name, is_banned, telegram_notifications_status "
                    "from users where user_id = :u"
                ),
                {"u": user_id},
            )
        ).mappings().first()
        return dict(row) if row else None

    async def _paid_since(self, session: AsyncSession, user_id: int, since: datetime) -> bool:
        return bool(
            await session.scalar(
                text(
                    "select 1 from payments where user_id = :u and status = 'succeeded' and funding_source = 'external' "
                    "and created_at > :s limit 1"
                ),
                {"u": user_id, "s": since},
            )
        )

    async def execute(
        self, session: AsyncSession, enr: dict[str, Any], node: dict[str, Any], graph: dict[str, Any],
        settings: dict[str, Any], stats: dict[str, int], *, dry: bool = False,
    ) -> Outcome:
        kind, params, uid = node["type"], node["params"], enr["user_id"]
        now = self.clock()
        ctx = enr["ctx"]

        if kind == "if_paid":
            since = enr["entered_at"]
            if params["since"] == "last_message" and ctx.get("last_sent_at"):
                since = datetime.fromisoformat(ctx["last_sent_at"])
            return Outcome("next", "yes" if await self._paid_since(session, uid, since) else "no")
        if kind == "if_sub":
            active = await session.scalar(
                text(f"select 1 {BASE_FROM} where u.user_id = :u and {ACTIVE}"), {"u": uid}
            )
            return Outcome("next", "yes" if active else "no")
        if kind == "if_filter":
            sql, args = eligible_sql(params["audience"])
            return Outcome("next", "yes" if await session.scalar(text(sql), {**args, "uid": uid}) else "no")
        if kind == "split":
            in_a = split_bucket(enr["campaign_id"], node["id"], uid) < int(params["percent_a"])
            if in_a and params["control_a"]:
                enr["holdout"] = True
                if not dry:
                    await self._event(session, enr, node, "holdout")
            return Outcome("next", "a" if in_a else "b", detail={"group": "A" if in_a else "B"})
        if kind == "wait":
            if params["mode"] == "until_hour":
                until = next_local_hour(now, int(params["hour"]), settings)
            else:
                delta = {"minutes": 1, "hours": 60, "days": 1440}[params["unit"]] * int(params["amount"])
                until = now + timedelta(minutes=delta)
            return Outcome("park", until=until)
        if kind == "goal":
            if not dry:
                await self._event(session, enr, node, "goal", {"name": params["name"]})
            return Outcome("end", status="done", reason="goal")
        if kind == "exit":
            return Outcome("end", status="done", reason=(params["reason"] or "exit"))
        if kind == "issue_promo":
            if enr["holdout"]:
                return Outcome("next", detail={"skipped": "holdout"})
            codes = ctx.setdefault("promo_by_node", {})
            if node["id"] not in codes:
                codes[node["id"]] = "TESTCODE" if dry else await self.host.issue_promo(session, user_id=uid, params=params)
                if not dry:
                    await self._event(session, enr, node, "promo", {"code": codes[node["id"]], "kind": params["kind"], "value": params["value"]})
            ctx["promo_code"] = codes[node["id"]]
            return Outcome("next")
        if kind == "notify_admin":
            if not dry and not enr["holdout"]:
                body = params["text"].replace("{user_id}", str(uid)).replace("{campaign}", str(enr.get("name", "")))
                await self.host.notify_admins(body)
            return Outcome("next")
        if kind == "send_message":
            return await self._send(session, enr, node, settings, stats, dry=dry)
        raise ValueError(f"cannot execute {kind}")

    async def _defer_until(self, session: AsyncSession, user_id: int, settings: dict[str, Any], now: datetime) -> datetime | None:
        """Earliest allowed send time under quiet hours and frequency limits, or None if allowed now."""
        until: datetime | None = None
        if in_quiet(now, settings):
            until = next_local_hour(now, int(settings["quiet_to"]), settings)
        cap = int(settings["daily_cap"])
        if cap > 0:
            row = (
                await session.execute(
                    text(
                        "select count(*) as n, min(created_at) as oldest from ext_kiro_campaigns_events "
                        "where user_id = :u and kind = 'sent' and created_at > now() - interval '24 hours'"
                    ),
                    {"u": user_id},
                )
            ).mappings().one()
            if row["n"] >= cap and row["oldest"]:
                candidate = row["oldest"] + timedelta(hours=24, seconds=5)
                until = max(until, candidate) if until else candidate
        gap = int(settings["min_gap_hours"])
        if gap > 0:
            last = await session.scalar(
                text("select max(created_at) from ext_kiro_campaigns_events where user_id = :u and kind = 'sent'"),
                {"u": user_id},
            )
            if last and last > now - timedelta(hours=gap):
                candidate = last + timedelta(hours=gap, seconds=5)
                until = max(until, candidate) if until else candidate
        return until

    async def _send(
        self, session: AsyncSession, enr: dict[str, Any], node: dict[str, Any], settings: dict[str, Any],
        stats: dict[str, int], *, dry: bool,
    ) -> Outcome:
        params, ctx, now = node["params"], enr["ctx"], self.clock()
        if enr["holdout"]:
            return Outcome("next", detail={"skipped": "holdout"})
        user = await self._user(session, enr["user_id"])
        if (
            user is None or user["is_banned"] or not user["telegram_id"]
            or user["telegram_notifications_status"] == "blocked"
        ):
            return Outcome("end", status="exited", reason="ineligible")
        if not dry and enr["options"].get("exit_on_payment", True):
            if enr.get("trigger_type") in ("trg_sub_ends", "trg_sub_expired", "trg_registered", "trg_inactive"):
                if await self._paid_since(session, enr["user_id"], enr["entered_at"]):
                    await self._event(session, enr, node, "exit", {"reason": "paid"})
                    return Outcome("end", status="exited", reason="paid", logged=False)
        if not await self.host.allows(
            session, user_id=enr["user_id"], category=params["category"], respect=bool(settings["respect_marketing_preference"])
        ):
            if not dry:
                await self._event(session, enr, node, "skipped", {"reason": "preference"})
            return Outcome("next", detail={"skipped": "preference"}, logged=False)
        if params["respect_limits"] and not dry:
            until = await self._defer_until(session, enr["user_id"], settings, now)
            if until is not None:
                since = enr["deferred_since"] or now
                if now - since > timedelta(hours=int(settings["max_defer_hours"])):
                    await self._event(session, enr, node, "skipped", {"reason": "deferred_too_long"})
                    return Outcome("next", detail={"skipped": "deferred_too_long"})
                return Outcome("park", until=until, logged=False)
        if dry:
            return Outcome("next", detail={"would_send": True})
        result = await self.host.send_message(session, user=user, params=params, ctx=ctx, campaign=str(enr.get("name", "")))
        if result.status == "sent":
            await self._event(session, enr, node, "sent", {"message_id": result.message_id, "promo": ctx.get("promo_code")})
            ctx["last_sent_at"] = now.isoformat()
            ctx.pop("retries", None)
            stats["sent"] += 1
            await self.sleep(1.0 / max(1, int(settings["rate_per_second"])))
            return Outcome("next", logged=True)
        if result.status == "blocked":
            await self._event(session, enr, node, "failed", {"reason": "blocked", "error": result.error[:200]})
            return Outcome("end", status="exited", reason="blocked", logged=False)
        retries = int(ctx.get("retries", 0))
        if retries < len(RETRY_DELAYS):
            ctx["retries"] = retries + 1
            return Outcome("park", until=now + timedelta(seconds=RETRY_DELAYS[retries]), logged=False)
        await self._event(session, enr, node, "failed", {"reason": "error", "error": result.error[:200]})
        return Outcome("end", status="error", reason="send_failed", logged=False)

    # -------------------------------------------------------------- simulate

    async def simulate(self, session: AsyncSession, graph: dict[str, Any], user_id: int, settings: dict[str, Any], *, campaign_id: int = 0) -> list[dict[str, Any]]:
        """Walk the graph for one user without side effects; waits are skipped, messages are not sent."""
        trigger = trigger_of(graph)
        if trigger is None:
            return []
        nodes = {n["id"]: n for n in graph["nodes"]}
        enr = {
            "id": 0, "campaign_id": campaign_id, "version": 0, "user_id": user_id, "holdout": False, "ctx": {},
            "entered_at": self.clock(), "deferred_since": None, "options": {"exit_on_payment": False}, "name": "",
        }
        path = [{"node_id": trigger["id"], "result": "start"}]
        current = next_node(graph, trigger["id"])
        stats = {"sent": 0}
        for _ in range(MAX_NODE_STEPS):
            node = nodes.get(current or "")
            if node is None:
                break
            outcome = await self.execute(session, enr, node, graph, settings, stats, dry=True)
            step = {"node_id": node["id"], "result": outcome.port if outcome.kind == "next" else outcome.kind}
            if outcome.detail:
                step["detail"] = outcome.detail
            path.append(step)
            if outcome.kind == "end":
                break
            current = next_node(graph, node["id"], outcome.port)
        return path
