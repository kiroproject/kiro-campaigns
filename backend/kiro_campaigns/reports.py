"""Conversion reports and the small analytics section. Pure SQL over Core tables and the plugin's events.

Revenue means successful payments funded from outside the shop (funding_source = 'external'); amounts are
never mixed across currencies. A payment is attributed to a campaign when it happens within `window`
days after the person was reached (first message for the comparison, last message for per-block credit).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

PAY = "p.status = 'succeeded' AND p.funding_source = 'external'"


def _money(rows: list[Any], key_cur: str = "currency", key_val: str = "revenue") -> dict[str, float]:
    return {str(r[key_cur]): round(float(r[key_val] or 0), 2) for r in rows if r[key_cur]}


def _rate(part: int, whole: int) -> float:
    return round(100.0 * part / whole, 2) if whole else 0.0


async def _group(session: AsyncSession, campaign_id: int, window: int, control: bool) -> dict[str, Any]:
    """People reached (or held back as control) with how many paid within the window."""
    if control:
        base = (
            "SELECT en.user_id, en.entered_at AS t0 FROM ext_kiro_campaigns_enrollments en "
            "WHERE en.campaign_id = :c AND en.holdout"
        )
    else:
        base = (
            "SELECT ev.user_id, min(ev.created_at) AS t0 FROM ext_kiro_campaigns_events ev "
            "WHERE ev.campaign_id = :c AND ev.kind = 'sent' GROUP BY ev.enrollment_id, ev.user_id"
        )
    args = {"c": campaign_id, "w": int(window)}
    n = int(await session.scalar(text(f"SELECT count(*) FROM ({base}) g"), args) or 0)
    rows = (
        await session.execute(
            text(
                f"SELECT p.currency, count(DISTINCT g.user_id) AS payers, sum(p.amount) AS revenue, count(*) AS payments "
                f"FROM ({base}) g JOIN payments p ON p.user_id = g.user_id AND {PAY} "
                f"AND p.created_at > g.t0 AND p.created_at <= g.t0 + (cast(:w as integer) * interval '1 day') "
                f"GROUP BY p.currency"
            ),
            args,
        )
    ).mappings().all()
    converted = int(
        await session.scalar(
            text(
                f"SELECT count(DISTINCT g.user_id) FROM ({base}) g JOIN payments p ON p.user_id = g.user_id AND {PAY} "
                f"AND p.created_at > g.t0 AND p.created_at <= g.t0 + (cast(:w as integer) * interval '1 day')"
            ),
            args,
        )
        or 0
    )
    revenue = _money(rows)
    return {
        "n": n,
        "converted": converted,
        "rate": _rate(converted, n),
        "revenue": revenue,
        "arpu": {cur: round(val / n, 2) for cur, val in revenue.items()} if n else {},
    }


async def campaign_report(session: AsyncSession, campaign_id: int, window: int) -> dict[str, Any]:
    args = {"c": campaign_id, "w": int(window)}
    enroll = (
        await session.execute(
            text(
                "SELECT count(*) AS entered, count(*) FILTER (WHERE status = 'active') AS active, "
                "count(*) FILTER (WHERE status = 'done') AS done, count(*) FILTER (WHERE status = 'exited') AS exited, "
                "count(*) FILTER (WHERE status = 'error') AS error, count(*) FILTER (WHERE holdout) AS holdout "
                "FROM ext_kiro_campaigns_enrollments WHERE campaign_id = :c"
            ),
            args,
        )
    ).mappings().one()
    kinds = {
        r["kind"]: int(r["n"])
        for r in (
            await session.execute(
                text("SELECT kind, count(*) AS n FROM ext_kiro_campaigns_events WHERE campaign_id = :c GROUP BY kind"), args
            )
        ).mappings()
    }
    nodes: dict[str, dict[str, Any]] = {}
    for r in (
        await session.execute(
            text("SELECT node_id, kind, count(*) AS n FROM ext_kiro_campaigns_events WHERE campaign_id = :c AND node_id IS NOT NULL GROUP BY node_id, kind"),
            args,
        )
    ).mappings():
        nodes.setdefault(r["node_id"], {})[r["kind"]] = int(r["n"])
    # last-touch credit per message block
    for r in (
        await session.execute(
            text(
                f"SELECT se.node_id, p.currency, count(DISTINCT p.payment_id) AS payments, sum(p.amount) AS revenue "
                f"FROM ext_kiro_campaigns_events se JOIN payments p ON p.user_id = se.user_id AND {PAY} "
                f"AND p.created_at > se.created_at AND p.created_at <= se.created_at + (cast(:w as integer) * interval '1 day') "
                f"WHERE se.campaign_id = :c AND se.kind = 'sent' AND NOT EXISTS ("
                f"  SELECT 1 FROM ext_kiro_campaigns_events s2 WHERE s2.campaign_id = :c AND s2.kind = 'sent' "
                f"  AND s2.user_id = se.user_id AND s2.created_at > se.created_at AND s2.created_at < p.created_at) "
                f"GROUP BY se.node_id, p.currency"
            ),
            args,
        )
    ).mappings():
        info = nodes.setdefault(r["node_id"], {})
        info["payments"] = info.get("payments", 0) + int(r["payments"])
        info.setdefault("revenue", {})[r["currency"]] = round(float(r["revenue"] or 0), 2)
    # exact attribution through promo codes issued by this campaign
    promo = (
        await session.execute(
            text(
                f"SELECT count(DISTINCT ev.detail->>'code') AS issued, count(DISTINCT a.activation_id) AS activated, "
                f"count(DISTINCT p.payment_id) AS payments FROM ext_kiro_campaigns_events ev "
                f"LEFT JOIN promo_codes pc ON pc.code = ev.detail->>'code' "
                f"LEFT JOIN promo_code_activations a ON a.promo_code_id = pc.promo_code_id "
                f"LEFT JOIN payments p ON p.payment_id = a.payment_id AND {PAY} "
                f"WHERE ev.campaign_id = :c AND ev.kind = 'promo'"
            ),
            args,
        )
    ).mappings().one()
    promo_rev = (
        await session.execute(
            text(
                f"SELECT p.currency, sum(p.amount) AS revenue FROM ext_kiro_campaigns_events ev "
                f"JOIN promo_codes pc ON pc.code = ev.detail->>'code' "
                f"JOIN promo_code_activations a ON a.promo_code_id = pc.promo_code_id "
                f"JOIN payments p ON p.payment_id = a.payment_id AND {PAY} "
                f"WHERE ev.campaign_id = :c AND ev.kind = 'promo' GROUP BY p.currency"
            ),
            args,
        )
    ).mappings().all()
    goals = {
        r["name"]: int(r["n"])
        for r in (
            await session.execute(
                text(
                    "SELECT coalesce(detail->>'name', '') AS name, count(*) AS n FROM ext_kiro_campaigns_events "
                    "WHERE campaign_id = :c AND kind = 'goal' GROUP BY 1"
                ),
                args,
            )
        ).mappings()
    }
    treated = await _group(session, campaign_id, window, control=False)
    control = await _group(session, campaign_id, window, control=True)
    uplift = None
    if control["n"] and treated["n"]:
        uplift = round(treated["rate"] - control["rate"], 2)
    return {
        "window_days": int(window),
        "funnel": {k: int(v or 0) for k, v in dict(enroll).items()},
        "delivery": {
            "sent": kinds.get("sent", 0), "failed": kinds.get("failed", 0),
            "skipped": kinds.get("skipped", 0), "promo": kinds.get("promo", 0),
        },
        "treated": treated,
        "control": control,
        "uplift_pp": uplift,
        "promo": {
            "issued": int(promo["issued"] or 0), "activated": int(promo["activated"] or 0),
            "payments": int(promo["payments"] or 0), "revenue": _money(promo_rev),
        },
        "nodes": nodes,
        "goals": goals,
    }


async def overview(session: AsyncSession, window: int) -> dict[int, dict[str, Any]]:
    """One row of numbers per campaign for the list screen."""
    out: dict[int, dict[str, Any]] = {}
    for r in (
        await session.execute(
            text(
                "SELECT campaign_id, count(*) AS entered, count(*) FILTER (WHERE status = 'active') AS active, "
                "count(*) FILTER (WHERE holdout) AS holdout FROM ext_kiro_campaigns_enrollments GROUP BY campaign_id"
            )
        )
    ).mappings():
        out[r["campaign_id"]] = {"entered": int(r["entered"]), "active": int(r["active"]), "holdout": int(r["holdout"])}
    for r in (
        await session.execute(
            text(
                "SELECT campaign_id, count(*) AS n, count(DISTINCT enrollment_id) AS reached "
                "FROM ext_kiro_campaigns_events WHERE kind = 'sent' GROUP BY campaign_id"
            )
        )
    ).mappings():
        info = out.setdefault(r["campaign_id"], {})
        info["sent"] = int(r["n"])
        info["reached"] = int(r["reached"])
    for r in (
        await session.execute(
            text(
                f"WITH g AS (SELECT campaign_id, user_id, min(created_at) AS t0 FROM ext_kiro_campaigns_events "
                f"WHERE kind = 'sent' GROUP BY campaign_id, enrollment_id, user_id) "
                f"SELECT g.campaign_id, count(DISTINCT (g.campaign_id, g.user_id)) AS payers, p.currency, sum(p.amount) AS revenue "
                f"FROM g JOIN payments p ON p.user_id = g.user_id AND {PAY} AND p.created_at > g.t0 "
                f"AND p.created_at <= g.t0 + (cast(:w as integer) * interval '1 day') GROUP BY g.campaign_id, p.currency"
            ),
            {"w": int(window)},
        )
    ).mappings():
        info = out.setdefault(r["campaign_id"], {})
        info["converted"] = info.get("converted", 0) + int(r["payers"])
        info.setdefault("revenue", {})[r["currency"]] = round(float(r["revenue"] or 0), 2)
    for info in out.values():
        info.setdefault("sent", 0)
        info.setdefault("entered", 0)
        info.setdefault("converted", 0)
        info.setdefault("revenue", {})
        info.setdefault("reached", 0)
        info.setdefault("active", 0)
        info.setdefault("holdout", 0)
        info["rate"] = _rate(info["converted"], info["reached"])
    return out


async def analytics(session: AsyncSession, days: int, window: int, tz_offset: int) -> dict[str, Any]:
    """Revenue, payers, trial conversion, churn, tariffs and campaign share for the last `days` days."""
    args = {"d": int(days), "off": int(tz_offset), "w": int(window)}
    day = "date_trunc('day', p.created_at + (cast(:off as integer) * interval '1 hour'))"
    daily_rows = (
        await session.execute(
            text(
                f"SELECT {day}::date AS day, p.currency, count(*) AS payments, sum(p.amount) AS revenue, "
                f"count(DISTINCT p.user_id) AS payers FROM payments p WHERE {PAY} "
                f"AND p.created_at >= now() - (cast(:d as integer) * interval '1 day') GROUP BY 1, 2 ORDER BY 1"
            ),
            args,
        )
    ).mappings().all()
    currencies = sorted({r["currency"] for r in daily_rows}, key=lambda c: -sum(float(r["revenue"]) for r in daily_rows if r["currency"] == c))
    today = (datetime.now(UTC) + timedelta(hours=tz_offset)).date()
    series: dict[str, list[dict[str, Any]]] = {}
    for cur in currencies:
        by_day = {r["day"]: r for r in daily_rows if r["currency"] == cur}
        points = []
        for i in range(days, -1, -1):
            d = today - timedelta(days=i)
            r = by_day.get(d)
            points.append({"day": d.isoformat(), "revenue": round(float(r["revenue"]), 2) if r else 0, "payments": int(r["payments"]) if r else 0})
        series[cur] = points
    totals = (
        await session.execute(
            text(
                f"SELECT p.currency, count(*) AS payments, sum(p.amount) AS revenue, count(DISTINCT p.user_id) AS payers "
                f"FROM payments p WHERE {PAY} AND p.created_at >= now() - (cast(:d as integer) * interval '1 day') GROUP BY 1"
            ),
            args,
        )
    ).mappings().all()
    new_payers = int(
        await session.scalar(
            text(
                f"SELECT count(DISTINCT p.user_id) FROM payments p WHERE {PAY} "
                f"AND p.created_at >= now() - (cast(:d as integer) * interval '1 day') "
                f"AND NOT EXISTS (SELECT 1 FROM payments o WHERE o.user_id = p.user_id AND o.status = 'succeeded' "
                f"AND o.funding_source = 'external' AND o.created_at < p.created_at)"
            ),
            args,
        )
        or 0
    )
    all_payers = int(
        await session.scalar(
            text(f"SELECT count(DISTINCT p.user_id) FROM payments p WHERE {PAY} AND p.created_at >= now() - (cast(:d as integer) * interval '1 day')"),
            args,
        )
        or 0
    )
    trial = (
        await session.execute(
            text(
                f"SELECT count(DISTINCT t.user_id) AS started, count(DISTINCT t.user_id) FILTER (WHERE EXISTS ("
                f"  SELECT 1 FROM payments p WHERE p.user_id = t.user_id AND {PAY} AND p.created_at > t.start_date)) AS paid "
                f"FROM subscriptions t WHERE t.provider = 'trial' AND t.start_date >= now() - (cast(:d as integer) * interval '1 day')"
            ),
            args,
        )
    ).mappings().one()
    churn = (
        await session.execute(
            text(
                "SELECT count(*) FILTER (WHERE ls.end_date >= now() - (cast(:d as integer) * interval '1 day') AND ls.end_date < now()) AS lost, "
                "count(*) FILTER (WHERE ls.end_date >= now() AND ls.is_active) AS active "
                "FROM (SELECT DISTINCT ON (user_id) user_id, end_date, is_active FROM subscriptions ORDER BY user_id, end_date DESC) ls"
            ),
            args,
        )
    ).mappings().one()
    tariffs = (
        await session.execute(
            text(
                f"SELECT coalesce(p.tariff_key, '—') AS tariff, p.currency, count(*) AS payments, sum(p.amount) AS revenue "
                f"FROM payments p WHERE {PAY} AND p.created_at >= now() - (cast(:d as integer) * interval '1 day') "
                f"GROUP BY 1, 2 ORDER BY sum(p.amount) DESC LIMIT 30"
            ),
            args,
        )
    ).mappings().all()
    attributed = (
        await session.execute(
            text(
                f"SELECT p.currency, sum(p.amount) AS revenue, count(*) AS payments FROM payments p WHERE {PAY} "
                f"AND p.created_at >= now() - (cast(:d as integer) * interval '1 day') AND EXISTS ("
                f"  SELECT 1 FROM ext_kiro_campaigns_events se WHERE se.kind = 'sent' AND se.user_id = p.user_id "
                f"  AND se.created_at < p.created_at AND se.created_at >= p.created_at - (cast(:w as integer) * interval '1 day')) "
                f"GROUP BY 1"
            ),
            args,
        )
    ).mappings().all()
    total_by_cur = _money(totals)
    attributed_by_cur = _money(attributed)
    return {
        "days": int(days),
        "currencies": currencies,
        "series": series,
        "totals": {
            r["currency"]: {"revenue": round(float(r["revenue"] or 0), 2), "payments": int(r["payments"]), "payers": int(r["payers"]),
                            "avg_check": round(float(r["revenue"] or 0) / int(r["payments"]), 2) if r["payments"] else 0}
            for r in totals
        },
        "payers": {"all": all_payers, "new": new_payers, "repeat": max(0, all_payers - new_payers)},
        "trial": {"started": int(trial["started"] or 0), "paid": int(trial["paid"] or 0), "rate": _rate(int(trial["paid"] or 0), int(trial["started"] or 0))},
        "subscriptions": {"lost": int(churn["lost"] or 0), "active": int(churn["active"] or 0)},
        "tariffs": [
            {"tariff": r["tariff"], "currency": r["currency"], "payments": int(r["payments"]), "revenue": round(float(r["revenue"] or 0), 2)}
            for r in tariffs
        ],
        "campaign_share": {
            cur: {"revenue": attributed_by_cur.get(cur, 0), "total": total_by_cur.get(cur, 0), "share": round(100.0 * attributed_by_cur.get(cur, 0) / total_by_cur[cur], 2) if total_by_cur.get(cur) else 0.0}
            for cur in currencies
        },
    }
