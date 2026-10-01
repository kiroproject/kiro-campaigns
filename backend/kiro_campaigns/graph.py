"""Campaign graph: node catalog, normalisation and validation.

The catalog doubles as the form schema for the visual editor (`/meta`), so a block is declared once.
Pure Python: nothing here touches the database or Core.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from .audience import FILTER_FIELDS, clean_filter

MAX_NODES = 60
MAX_EDGES = 120
NODE_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
LANGUAGES = ("ru", "en")
MAX_TEXT = 4096
MAX_CAPTION = 1024

BUTTON_KINDS = ("url", "webapp_section", "promo_webapp", "promo_bot")
SECTIONS = ("home", "plans", "install", "trial", "invite", "devices", "support", "settings")
UNITS = ("minutes", "hours", "days")
PROMO_KINDS = ("discount", "bonus_days", "regular_traffic", "premium_traffic")


class GraphError(ValueError):
    pass


def _f(key: str, type_: str, label: str, default: Any = None, **extra: Any) -> dict[str, Any]:
    return {"key": key, "type": type_, "label": label, "default": default, **extra}


AUDIENCE = _f("audience", "filter", "Кому", {}, help="Условия отбора. Пусто = все подходящие")

CATALOG: dict[str, dict[str, Any]] = {
    # ---- triggers
    "trg_sub_ends": {
        "group": "trigger", "title": "До окончания подписки", "icon": "⏳", "ports": ["out"],
        "help": "Входит, когда до конца подписки остаётся не больше N дней.",
        "fields": [_f("days", "int", "За сколько дней", 7, min=1, max=90), AUDIENCE],
    },
    "trg_sub_expired": {
        "group": "trigger", "title": "После окончания", "icon": "⌛", "ports": ["out"],
        "help": "Входит через N дней после окончания, если подписка не продлена.",
        "fields": [_f("days", "int", "Через сколько дней", 3, min=1, max=365), AUDIENCE],
    },
    "trg_registered": {
        "group": "trigger", "title": "После регистрации", "icon": "👋", "ports": ["out"],
        "help": "Входит через N часов после регистрации.",
        "fields": [
            _f("hours", "int", "Через сколько часов", 24, min=1, max=720),
            _f("only_no_payment", "bool", "Только без оплат", True),
            AUDIENCE,
        ],
    },
    "trg_paid": {
        "group": "trigger", "title": "После оплаты", "icon": "💳", "ports": ["out"],
        "help": "Входит после каждой успешной оплаты (платёж с внешних средств).",
        "fields": [AUDIENCE],
    },
    "trg_inactive": {
        "group": "trigger", "title": "Не подключался", "icon": "💤", "ports": ["out"],
        "help": "Подписка активна, но уже N дней нет подключений.",
        "fields": [_f("days", "int", "Дней без подключения", 14, min=3, max=365), AUDIENCE],
    },
    "trg_broadcast": {
        "group": "trigger", "title": "Рассылка по сегменту", "icon": "📣", "ports": ["out"],
        "help": "Разовая или регулярная отправка выбранной аудитории.",
        "fields": [
            _f("mode", "select", "Когда", "now", options=[
                {"value": "now", "label": "Сразу после запуска"},
                {"value": "at", "label": "В указанное время"},
                {"value": "daily", "label": "Каждый день"},
                {"value": "weekly", "label": "По дням недели"},
            ]),
            _f("at", "datetime", "Дата и время (по вашему поясу)", ""),
            _f("time", "time", "Время", "12:00"),
            _f("weekdays", "weekdays", "Дни недели", [0]),
            AUDIENCE,
        ],
    },
    # ---- conditions
    "if_paid": {
        "group": "condition", "title": "Оплатил?", "icon": "💰", "ports": ["yes", "no"],
        "help": "Была ли успешная оплата после входа в кампанию или после последнего сообщения.",
        "fields": [_f("since", "select", "Считать с момента", "entry", options=[
            {"value": "entry", "label": "входа в кампанию"},
            {"value": "last_message", "label": "последнего сообщения"},
        ])],
    },
    "if_sub": {
        "group": "condition", "title": "Подписка активна?", "icon": "🔑", "ports": ["yes", "no"],
        "help": "Проверка текущего состояния подписки.",
        "fields": [],
    },
    "if_filter": {
        "group": "condition", "title": "Проверка аудитории", "icon": "🔍", "ports": ["yes", "no"],
        "help": "Подходит ли пользователь под условия.",
        "fields": [AUDIENCE],
    },
    "split": {
        "group": "condition", "title": "Случайное деление", "icon": "🎲", "ports": ["a", "b"],
        "help": "Делит людей случайно, но всегда одинаково для одного пользователя. "
        "Ветка A может быть контрольной группой: ей ничего не отправляется, а её конверсия сравнивается с веткой B.",
        "fields": [
            _f("percent_a", "int", "Доля ветки A, %", 10, min=1, max=99),
            _f("control_a", "bool", "Ветка A — контрольная группа", True),
        ],
    },
    # ---- actions
    "send_message": {
        "group": "action", "title": "Сообщение в Telegram", "icon": "✉️", "ports": ["out"],
        "help": "Подстановки: {first_name}, {days_left}, {tariff_name}, {end_date}, {miniapp_link} и другие "
        "из обычной рассылки, а также {promo_code} после блока «Промокод».",
        "fields": [
            _f("texts", "texts", "Текст", {}),
            _f("image_id", "image", "Картинка", ""),
            _f("buttons", "buttons", "Кнопки", []),
            _f("category", "select", "Категория", "marketing", options=[
                {"value": "marketing", "label": "Маркетинг (с учётом согласия)"},
                {"value": "subscriptions", "label": "Сервисное (подписка)"},
            ]),
            _f("respect_limits", "bool", "Учитывать лимиты и тихие часы", True),
        ],
    },
    "issue_promo": {
        "group": "action", "title": "Промокод", "icon": "🎟️", "ports": ["out"],
        "help": "Создаёт личный одноразовый код. Он доступен в тексте как {promo_code}.",
        "fields": [
            _f("kind", "select", "Что даёт", "discount", options=[
                {"value": "discount", "label": "Скидку, %"},
                {"value": "bonus_days", "label": "Бонусные дни"},
                {"value": "regular_traffic", "label": "Обычный трафик, ГБ"},
                {"value": "premium_traffic", "label": "Premium-трафик, ГБ"},
            ]),
            _f("value", "number", "Размер", 10, min=0.1, max=10000),
            _f("valid_days", "int", "Срок действия, дней", 14, min=1, max=365),
        ],
    },
    "notify_admin": {
        "group": "action", "title": "Уведомить админа", "icon": "🔔", "ports": ["out"],
        "help": "Сообщение администраторам. Подстановки: {user_id}, {campaign}.",
        "fields": [_f("text", "text", "Текст", "Пользователь {user_id} дошёл до этапа кампании «{campaign}»", max=500)],
    },
    # ---- flow
    "wait": {
        "group": "flow", "title": "Ждать", "icon": "⏱️", "ports": ["out"],
        "help": "Пауза перед следующим блоком.",
        "fields": [
            _f("mode", "select", "Режим", "delay", options=[
                {"value": "delay", "label": "Подождать"},
                {"value": "until_hour", "label": "До определённого часа"},
            ]),
            _f("amount", "int", "Сколько", 1, min=1, max=10000),
            _f("unit", "select", "Единица", "days", options=[
                {"value": "minutes", "label": "минут"},
                {"value": "hours", "label": "часов"},
                {"value": "days", "label": "дней"},
            ]),
            _f("hour", "int", "Час (по вашему поясу)", 12, min=0, max=23),
        ],
    },
    "goal": {
        "group": "flow", "title": "Цель достигнута", "icon": "🏁", "ports": [],
        "help": "Завершает путь пользователя как успешный.",
        "fields": [_f("name", "text", "Название цели", "Оплата", max=60)],
    },
    "exit": {
        "group": "flow", "title": "Выход", "icon": "🚪", "ports": [],
        "help": "Завершает путь пользователя.",
        "fields": [_f("reason", "text", "Причина", "", max=60)],
    },
}

TRIGGERS = tuple(t for t, spec in CATALOG.items() if spec["group"] == "trigger")


def _field_map(node_type: str) -> dict[str, dict[str, Any]]:
    return {f["key"]: f for f in CATALOG[node_type]["fields"]}


def _int(value: Any, field: dict[str, Any]) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError) as exc:
        raise GraphError(f"invalid_{field['key']}") from exc
    lo, hi = field.get("min"), field.get("max")
    if (lo is not None and number < lo) or (hi is not None and number > hi):
        raise GraphError(f"invalid_{field['key']}")
    return number


def _number(value: Any, field: dict[str, Any]) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise GraphError(f"invalid_{field['key']}") from exc
    lo, hi = field.get("min"), field.get("max")
    if (lo is not None and number < lo) or (hi is not None and number > hi):
        raise GraphError(f"invalid_{field['key']}")
    return int(number) if number.is_integer() else round(number, 3)


def _clean_buttons(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw[:4]:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "url")
        if kind not in BUTTON_KINDS:
            raise GraphError("invalid_button_kind")
        label = str(item.get("label") or "").strip()[:64]
        section = str(item.get("section") or "home")
        out.append({
            "kind": kind,
            "label": label,
            "url": str(item.get("url") or "").strip()[:512],
            "section": section if section in SECTIONS else "home",
        })
    return out


def _clean_texts(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for lang in LANGUAGES:
        value = str(raw.get(lang) or "").strip()
        if value:
            out[lang] = value[:MAX_TEXT]
    return out


def clean_params(node_type: str, raw: Any) -> dict[str, Any]:
    if node_type not in CATALOG:
        raise GraphError("unknown_node_type")
    raw = raw if isinstance(raw, dict) else {}
    params: dict[str, Any] = {}
    for field in CATALOG[node_type]["fields"]:
        key, kind = field["key"], field["type"]
        value = raw.get(key, field.get("default"))
        if kind == "int":
            params[key] = _int(value, field)
        elif kind == "number":
            params[key] = _number(value, field)
        elif kind == "bool":
            params[key] = bool(value)
        elif kind == "select":
            allowed = {o["value"] for o in field["options"]}
            params[key] = value if value in allowed else field["default"]
        elif kind == "text":
            params[key] = str(value or "").strip()[: int(field.get("max", 200))]
        elif kind == "time":
            text = str(value or "").strip()
            params[key] = text if re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", text) else str(field["default"])
        elif kind == "datetime":
            params[key] = str(value or "").strip()[:32]
        elif kind == "weekdays":
            days = sorted({int(d) for d in (value if isinstance(value, list) else []) if str(d).isdigit() and 0 <= int(d) <= 6})
            params[key] = days or [0]
        elif kind == "texts":
            params[key] = _clean_texts(value)
        elif kind == "buttons":
            params[key] = _clean_buttons(value)
        elif kind == "image":
            image = str(value or "").strip()
            if image and (not image.isalnum() or len(image) > 64):
                raise GraphError("invalid_image")
            params[key] = image
        elif kind == "filter":
            params[key] = clean_filter(value)
        else:  # pragma: no cover - catalog bug
            raise GraphError("bad_catalog")
    return params


def clean_graph(raw: Any) -> dict[str, Any]:
    """Normalise a graph from the editor; structural problems raise GraphError."""
    if not isinstance(raw, dict):
        raise GraphError("invalid_graph")
    nodes_raw, edges_raw = raw.get("nodes") or [], raw.get("edges") or []
    if not isinstance(nodes_raw, list) or not isinstance(edges_raw, list):
        raise GraphError("invalid_graph")
    if len(nodes_raw) > MAX_NODES:
        raise GraphError("too_many_nodes")
    if len(edges_raw) > MAX_EDGES:
        raise GraphError("too_many_edges")
    nodes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in nodes_raw:
        if not isinstance(item, dict):
            raise GraphError("invalid_node")
        node_id, node_type = str(item.get("id") or ""), str(item.get("type") or "")
        if not NODE_ID_RE.match(node_id) or node_id in seen:
            raise GraphError("invalid_node_id")
        seen.add(node_id)
        try:
            x, y = round(float(item.get("x", 0)), 1), round(float(item.get("y", 0)), 1)
        except (TypeError, ValueError):
            x = y = 0.0
        nodes.append({
            "id": node_id, "type": node_type, "x": x, "y": y,
            "params": clean_params(node_type, item.get("params")),
            "label": str(item.get("label") or "").strip()[:60],
        })
    by_id = {n["id"]: n for n in nodes}
    edges: list[dict[str, str]] = []
    used: set[tuple[str, str]] = set()
    for item in edges_raw:
        if not isinstance(item, dict):
            raise GraphError("invalid_edge")
        src, port, dst = str(item.get("from") or ""), str(item.get("port") or "out"), str(item.get("to") or "")
        if src not in by_id or dst not in by_id:
            raise GraphError("edge_unknown_node")
        if port not in CATALOG[by_id[src]["type"]]["ports"]:
            raise GraphError("edge_bad_port")
        if (src, port) in used:
            raise GraphError("edge_duplicate_port")
        used.add((src, port))
        edges.append({"from": src, "port": port, "to": dst})
    return {"nodes": nodes, "edges": edges}


Check = Callable[[str], str | None]


def validate_graph(
    graph: dict[str, Any],
    *,
    html_error: Check | None = None,
    unknown_codes: Callable[[str], set[str]] | None = None,
) -> list[dict[str, str]]:
    """Problems that make a graph unsafe to publish. `level` is 'error' or 'warning'."""
    issues: list[dict[str, str]] = []

    def add(level: str, node: str, code: str, message: str) -> None:
        issues.append({"level": level, "node_id": node, "code": code, "message": message})

    nodes = {n["id"]: n for n in graph["nodes"]}
    edges = graph["edges"]
    triggers = [n for n in graph["nodes"] if n["type"] in TRIGGERS]
    if len(triggers) != 1:
        add("error", "", "trigger_count", "В кампании должен быть ровно один блок-триггер")
    incoming = {e["to"] for e in edges}
    outgoing: dict[str, list[dict[str, str]]] = {}
    for e in edges:
        outgoing.setdefault(e["from"], []).append(e)
    for t in triggers:
        if t["id"] in incoming:
            add("error", t["id"], "trigger_incoming", "К триггеру нельзя подключать входящие связи")
        if not outgoing.get(t["id"]):
            add("error", t["id"], "trigger_empty", "К триггеру ничего не подключено")
    # reachability + cycles
    if len(triggers) == 1:
        reach, stack = set(), [triggers[0]["id"]]
        while stack:
            cur = stack.pop()
            if cur in reach:
                continue
            reach.add(cur)
            stack.extend(e["to"] for e in outgoing.get(cur, []))
        for nid in nodes:
            if nid not in reach:
                add("warning", nid, "unreachable", "Блок не связан с триггером и не будет выполнен")
    state: dict[str, int] = {}

    def has_cycle(start: str) -> bool:
        stack = [(start, iter(outgoing.get(start, [])))]
        state[start] = 1
        while stack:
            cur, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                state[cur] = 2
                stack.pop()
                continue
            target = nxt["to"]
            if state.get(target) == 1:
                return True
            if state.get(target) is None:
                state[target] = 1
                stack.append((target, iter(outgoing.get(target, []))))
        return False

    for nid in nodes:
        if state.get(nid) is None and has_cycle(nid):
            add("error", nid, "cycle", "Цикл в связях: возврат к уже пройденному блоку запрещён")
            break
    for node in graph["nodes"]:
        spec = CATALOG[node["type"]]
        ports = spec["ports"]
        connected = {e["port"] for e in outgoing.get(node["id"], [])}
        for port in ports:
            if port not in connected and node["type"] not in TRIGGERS:
                add("warning", node["id"], "open_port", f"Выход «{port}» не подключён: путь здесь завершится")
        params = node["params"]
        if node["type"] == "send_message":
            texts = params["texts"]
            if not texts:
                add("error", node["id"], "empty_text", "Не заполнен текст сообщения")
            for lang, body in texts.items():
                if params["image_id"] and len(body) > MAX_CAPTION:
                    add("error", node["id"], "caption_too_long", f"Подпись к картинке ({lang}) длиннее {MAX_CAPTION} знаков")
                if html_error:
                    err = html_error(body)
                    if err:
                        add("error", node["id"], "bad_html", f"Ошибка разметки ({lang}): {err}")
                if unknown_codes:
                    unknown = {c for c in unknown_codes(body) if c != "promo_code"}
                    if unknown:
                        add("error", node["id"], "unknown_shortcode", "Неизвестные подстановки: " + ", ".join(sorted(unknown)))
            for button in params["buttons"]:
                if not button["label"] and button["kind"] == "url":
                    add("error", node["id"], "button_label", "У кнопки-ссылки нужна подпись")
                if button["kind"] == "url" and not button["url"].startswith("https://"):
                    add("error", node["id"], "button_url", "Ссылка кнопки должна начинаться с https://")
        if node["type"] == "trg_broadcast" and params["mode"] == "at" and not params["at"]:
            add("error", node["id"], "broadcast_at", "Укажите дату и время запуска")
        if node["type"] == "issue_promo" and params["kind"] == "discount" and params["value"] > 99:
            add("error", node["id"], "promo_value", "Скидка не может быть больше 99%")
    # a {promo_code} token or promo button without a promo block upstream is almost surely a mistake
    promo_ids = {n["id"] for n in graph["nodes"] if n["type"] == "issue_promo"}
    for node in graph["nodes"]:
        if node["type"] != "send_message":
            continue
        uses = any("{promo_code}" in t for t in node["params"]["texts"].values()) or any(
            b["kind"] in ("promo_webapp", "promo_bot") for b in node["params"]["buttons"]
        )
        if uses and not promo_ids:
            add("error", node["id"], "promo_missing", "Используется промокод, но в кампании нет блока «Промокод»")
    return issues


def has_errors(issues: list[dict[str, str]]) -> bool:
    return any(i["level"] == "error" for i in issues)


def next_node(graph: dict[str, Any], node_id: str, port: str = "out") -> str | None:
    for edge in graph["edges"]:
        if edge["from"] == node_id and edge["port"] == port:
            return edge["to"]
    return None


def trigger_of(graph: dict[str, Any]) -> dict[str, Any] | None:
    for node in graph["nodes"]:
        if node["type"] in TRIGGERS:
            return node
    return None


def catalog_meta() -> dict[str, Any]:
    """Catalog for the editor, without implementation details."""
    return {
        "groups": [
            {"id": "trigger", "title": "Триггеры"},
            {"id": "condition", "title": "Условия"},
            {"id": "action", "title": "Действия"},
            {"id": "flow", "title": "Поток"},
        ],
        "nodes": {k: {kk: vv for kk, vv in v.items()} for k, v in CATALOG.items()},
        "filter_fields": FILTER_FIELDS,
        "limits": {"max_nodes": MAX_NODES, "max_text": MAX_TEXT, "max_caption": MAX_CAPTION},
        "sections": list(SECTIONS),
        "button_kinds": list(BUTTON_KINDS),
        "languages": list(LANGUAGES),
    }
