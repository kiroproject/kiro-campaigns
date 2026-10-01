"""Audience filters and trigger discovery as SQL over Core tables (users, subscriptions, payments).

User-provided values are only ever bound parameters; the SQL text is assembled from fixed fragments.
Eligibility is always enforced here: not banned, has a Telegram id, has not blocked the bot.
"""

from __future__ import annotations

import re
from typing import Any

SUB_STATES = ("any", "active", "expired", "never")
TRI = ("any", "yes", "no")
TRIAL = ("any", "used", "never")

FILTER_FIELDS: list[dict[str, Any]] = [
    {"key": "sub_state", "type": "select", "label": "Подписка", "default": "any", "options": [
        {"value": "any", "label": "Любая"}, {"value": "active", "label": "Активна"},
        {"value": "expired", "label": "Истекла"}, {"value": "never", "label": "Никогда не было"}]},
    {"key": "tariffs", "type": "tags", "label": "Тарифы (ключи через запятую)", "default": []},
    {"key": "days_left_min", "type": "int", "label": "Осталось дней от", "default": None, "min": 0, "max": 3650},
    {"key": "days_left_max", "type": "int", "label": "Осталось дней до", "default": None, "min": 0, "max": 3650},
    {"key": "expired_days_min", "type": "int", "label": "Истекла дней назад от", "default": None, "min": 0, "max": 3650},
    {"key": "expired_days_max", "type": "int", "label": "Истекла дней назад до", "default": None, "min": 0, "max": 3650},
    {"key": "registered_days_min", "type": "int", "label": "Зарегистрирован дней назад от", "default": None, "min": 0, "max": 3650},
    {"key": "registered_days_max", "type": "int", "label": "Зарегистрирован дней назад до", "default": None, "min": 0, "max": 3650},
    {"key": "paid", "type": "select", "label": "Платил", "default": "any", "options": [
        {"value": "any", "label": "Не важно"}, {"value": "yes", "label": "Да"}, {"value": "no", "label": "Нет"}]},
    {"key": "payments_min", "type": "int", "label": "Оплат не меньше", "default": None, "min": 1, "max": 1000},
    {"key": "trial", "type": "select", "label": "Пробный период", "default": "any", "options": [
        {"value": "any", "label": "Не важно"}, {"value": "used", "label": "Использовал"}, {"value": "never", "label": "Не использовал"}]},
    {"key": "inactive_days_min", "type": "int", "label": "Не подключался дней", "default": None, "min": 1, "max": 3650},
    {"key": "referred", "type": "select", "label": "Пришёл по приглашению", "default": "any", "options": [
        {"value": "any", "label": "Не важно"}, {"value": "yes", "label": "Да"}, {"value": "no", "label": "Нет"}]},
    {"key": "languages", "type": "tags", "label": "Языки (ru, en)", "default": []},
]

_INT_KEYS = (
    "days_left_min", "days_left_max", "expired_days_min", "expired_days_max",
    "registered_days_min", "registered_days_max", "payments_min", "inactive_days_min",
)
_TAG_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,40}$")

BASE_FROM = """
FROM users u
LEFT JOIN LATERAL (
    SELECT s.subscription_id, s.end_date, s.start_date, s.is_active, s.tariff_key, s.last_connected_at, s.provider
    FROM subscriptions s WHERE s.user_id = u.user_id ORDER BY s.end_date DESC LIMIT 1
) ls ON TRUE
"""
ELIGIBLE = (
    "u.is_banned IS NOT TRUE AND u.telegram_id IS NOT NULL "
    "AND COALESCE(u.telegram_notifications_status, 'unknown') <> 'blocked'"
)
ACTIVE = "(ls.subscription_id IS NOT NULL AND ls.is_active IS NOT FALSE AND ls.end_date > now())"
PAID_EXISTS = (
    "EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.user_id AND p.status = 'succeeded' "
    "AND p.funding_source = 'external')"
)


def clean_filter(raw: Any) -> dict[str, Any]:
    """Keep only known, valid keys; empty values are dropped so the stored filter stays small."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key in ("sub_state", "paid", "referred", "trial"):
        value = raw.get(key)
        allowed = {"sub_state": SUB_STATES, "paid": TRI, "referred": TRI, "trial": TRIAL}[key]
        if value in allowed and value != "any":
            out[key] = value
    for key in _INT_KEYS:
        value = raw.get(key)
        if value in (None, ""):
            continue
        try:
            number = int(float(value))
        except (TypeError, ValueError):
            continue
        if 0 <= number <= 3650:
            out[key] = number
    for key in ("tariffs", "languages"):
        value = raw.get(key)
        if isinstance(value, str):
            value = [v.strip() for v in value.split(",")]
        if isinstance(value, list):
            tags = [str(v).strip() for v in value if _TAG_RE.match(str(v).strip())][:20]
            if tags:
                out[key] = [t.lower() for t in tags] if key == "languages" else tags
    return out


def filter_where(spec: dict[str, Any], prefix: str = "f") -> tuple[list[str], dict[str, Any]]:
    """SQL conditions (aliases `u` and `ls`) and bound parameters for a cleaned filter."""
    spec = clean_filter(spec)
    cond: list[str] = []
    args: dict[str, Any] = {}

    def p(name: str, value: Any, sql_type: str = "integer") -> str:
        key = f"{prefix}_{name}"
        args[key] = value
        return f"cast(:{key} as {sql_type})"

    state = spec.get("sub_state")
    if state == "active":
        cond.append(ACTIVE)
    elif state == "expired":
        cond.append(f"(ls.subscription_id IS NOT NULL AND NOT {ACTIVE})")
    elif state == "never":
        cond.append("ls.subscription_id IS NULL")
    if "tariffs" in spec:
        cond.append(f"ls.tariff_key = ANY({p('tariffs', spec['tariffs'], 'text[]')})")
    days_left = "(EXTRACT(EPOCH FROM (ls.end_date - now())) / 86400.0)"
    if "days_left_min" in spec:
        cond.append(f"({ACTIVE} AND {days_left} >= {p('dlmin', spec['days_left_min'])})")
    if "days_left_max" in spec:
        cond.append(f"({ACTIVE} AND {days_left} <= {p('dlmax', spec['days_left_max'])})")
    expired_days = "(EXTRACT(EPOCH FROM (now() - ls.end_date)) / 86400.0)"
    if "expired_days_min" in spec:
        cond.append(f"(ls.subscription_id IS NOT NULL AND NOT {ACTIVE} AND {expired_days} >= {p('edmin', spec['expired_days_min'])})")
    if "expired_days_max" in spec:
        cond.append(f"(ls.subscription_id IS NOT NULL AND NOT {ACTIVE} AND {expired_days} <= {p('edmax', spec['expired_days_max'])})")
    age = "(EXTRACT(EPOCH FROM (now() - u.registration_date)) / 86400.0)"
    if "registered_days_min" in spec:
        cond.append(f"{age} >= {p('rmin', spec['registered_days_min'])}")
    if "registered_days_max" in spec:
        cond.append(f"{age} <= {p('rmax', spec['registered_days_max'])}")
    if spec.get("paid") == "yes":
        cond.append(PAID_EXISTS)
    elif spec.get("paid") == "no":
        cond.append(f"NOT {PAID_EXISTS}")
    if "payments_min" in spec:
        cond.append(
            "(SELECT count(*) FROM payments p WHERE p.user_id = u.user_id AND p.status = 'succeeded' "
            f"AND p.funding_source = 'external') >= {p('pmin', spec['payments_min'])}"
        )
    trial_exists = "EXISTS (SELECT 1 FROM subscriptions t WHERE t.user_id = u.user_id AND t.provider = 'trial')"
    if spec.get("trial") == "used":
        cond.append(trial_exists)
    elif spec.get("trial") == "never":
        cond.append(f"NOT {trial_exists}")
    if "inactive_days_min" in spec:
        cond.append(
            f"({ACTIVE} AND COALESCE(ls.last_connected_at, ls.start_date, now()) "
            f"<= now() - ({p('inact', spec['inactive_days_min'])} * interval '1 day'))"
        )
    if spec.get("referred") == "yes":
        cond.append("u.referred_by_id IS NOT NULL")
    elif spec.get("referred") == "no":
        cond.append("u.referred_by_id IS NULL")
    if "languages" in spec:
        cond.append(f"lower(COALESCE(u.language_code, 'ru')) = ANY({p('langs', spec['languages'], 'text[]')})")
    return cond, args


def _entry_stamp(column: str) -> str:
    return f"to_char({column} AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI')"


def candidates_sql(
    trigger_type: str, params: dict[str, Any], *, run_key: str = ""
) -> tuple[str, dict[str, Any]]:
    """`SELECT u.user_id, <entry_key> AS entry_key` for users who should enter right now."""
    cond, args = filter_where(params.get("audience") or {}, "aud")
    where = [ELIGIBLE, *cond]
    if trigger_type == "trg_sub_ends":
        args["t_days"] = int(params["days"])
        where.append(f"{ACTIVE} AND ls.end_date <= now() + (cast(:t_days as integer) * interval '1 day')")
        key = _entry_stamp("ls.end_date")
    elif trigger_type == "trg_sub_expired":
        args["t_days"] = int(params["days"])
        where.append(
            "ls.subscription_id IS NOT NULL AND ls.end_date <= now() - (cast(:t_days as integer) * interval '1 day') "
            "AND ls.end_date > now() - ((cast(:t_days as integer) + 7) * interval '1 day')"
        )
        key = _entry_stamp("ls.end_date")
    elif trigger_type == "trg_registered":
        args["t_hours"] = int(params["hours"])
        where.append(
            "u.registration_date <= now() - (cast(:t_hours as integer) * interval '1 hour') "
            "AND u.registration_date > now() - ((cast(:t_hours as integer) + 168) * interval '1 hour')"
        )
        if params.get("only_no_payment", True):
            where.append(f"NOT {PAID_EXISTS}")
        key = "''"
    elif trigger_type == "trg_inactive":
        args["t_days"] = int(params["days"])
        where.append(
            f"{ACTIVE} AND COALESCE(ls.last_connected_at, ls.start_date, now()) "
            "<= now() - (cast(:t_days as integer) * interval '1 day')"
        )
        key = "'a' || to_char(COALESCE(ls.last_connected_at, ls.start_date) AT TIME ZONE 'UTC', 'YYYYMMDD')"
    elif trigger_type == "trg_paid":
        where.append(
            "pay.payment_id IS NOT NULL"
        )
        base = (
            "SELECT u.user_id, 'p' || pay.payment_id AS entry_key "
            + BASE_FROM
            + "JOIN payments pay ON pay.user_id = u.user_id AND pay.status = 'succeeded' "
            "AND pay.funding_source = 'external' AND pay.created_at > now() - interval '3 days' "
            + "WHERE " + " AND ".join(where)
        )
        return base, args
    elif trigger_type == "trg_broadcast":
        args["t_run"] = run_key[:60]
        key = "cast(:t_run as text)"
    else:
        raise ValueError("unknown_trigger")
    sql = f"SELECT u.user_id, {key} AS entry_key {BASE_FROM} WHERE " + " AND ".join(where)
    return sql, args


def eligible_sql(spec: dict[str, Any], user_param: str = "uid") -> tuple[str, dict[str, Any]]:
    """Does one user (bound as :uid) match the filter? Returns a SELECT yielding one row or none."""
    cond, args = filter_where(spec, "chk")
    where = [f"u.user_id = :{user_param}", *cond]
    return f"SELECT 1 {BASE_FROM} WHERE " + " AND ".join(where) + " LIMIT 1", args
