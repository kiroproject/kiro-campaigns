"""Ready-made campaign graphs. They are created as drafts: nothing is sent until an admin publishes and starts them."""

from __future__ import annotations

from typing import Any


def _n(id_: str, type_: str, x: int, y: int, **params: Any) -> dict[str, Any]:
    return {"id": id_, "type": type_, "x": x, "y": y, "params": params}


def _e(a: str, b: str, port: str = "out") -> dict[str, str]:
    return {"from": a, "port": port, "to": b}


def _btn(kind: str, section: str = "home") -> dict[str, str]:
    return {"kind": kind, "section": section, "label": "", "url": ""}


PRESETS: dict[str, dict[str, Any]] = {
    "before_end_7": {
        "title": "За 7 дней до окончания",
        "description": "Один тёплый напоминатель с кнопкой продления. 10% людей — контрольная группа.",
        "graph": {
            "nodes": [
                _n("t", "trg_sub_ends", 40, 140, days=7),
                _n("s", "split", 300, 140, percent_a=10, control_a=True),
                _n("m", "send_message", 560, 80, texts={
                    "ru": "{first_name}, подписка заканчивается через {days_left} дн. ({end_date}).\n\nПродлите заранее, чтобы доступ не прерывался.",
                    "en": "{first_name}, your subscription ends in {days_left} days ({end_date}).\n\nRenew in advance so access is not interrupted.",
                }, buttons=[_btn("webapp_section", "plans")]),
                _n("g", "goal", 820, 80, name="Продлил"),
                _n("x", "exit", 560, 240, reason="control"),
            ],
            "edges": [_e("t", "s"), _e("s", "x", "a"), _e("s", "m", "b"), _e("m", "g")],
        },
    },
    "after_end_3": {
        "title": "3 дня после окончания: скидка 10%",
        "description": "Личная скидка через 3 дня после окончания. Через 3 дня проверяем оплату.",
        "graph": {
            "nodes": [
                _n("t", "trg_sub_expired", 40, 160, days=3),
                _n("s", "split", 280, 160, percent_a=10, control_a=True),
                _n("p", "issue_promo", 520, 100, kind="discount", value=10, valid_days=7),
                _n("m", "send_message", 760, 100, texts={
                    "ru": "{first_name}, мы скучаем 🙂\n\nВернитесь со скидкой 10%: ваш код <code>{promo_code}</code> действует 7 дней.",
                    "en": "{first_name}, we miss you 🙂\n\nCome back with 10% off: your code <code>{promo_code}</code> is valid for 7 days.",
                }, buttons=[_btn("promo_webapp")]),
                _n("w", "wait", 1000, 100, mode="delay", amount=3, unit="days"),
                _n("q", "if_paid", 1240, 100, since="entry"),
                _n("g", "goal", 1480, 40, name="Вернулся"),
                _n("x", "exit", 1480, 200, reason="не вернулся"),
                _n("c", "exit", 520, 260, reason="control"),
            ],
            "edges": [_e("t", "s"), _e("s", "c", "a"), _e("s", "p", "b"), _e("p", "m"), _e("m", "w"), _e("w", "q"),
                      _e("q", "g", "yes"), _e("q", "x", "no")],
        },
    },
    "after_end_14": {
        "title": "14 дней после окончания: скидка 20%",
        "description": "Последняя попытка вернуть клиента с большей скидкой.",
        "graph": {
            "nodes": [
                _n("t", "trg_sub_expired", 40, 160, days=14),
                _n("s", "split", 280, 160, percent_a=10, control_a=True),
                _n("p", "issue_promo", 520, 100, kind="discount", value=20, valid_days=7),
                _n("m", "send_message", 760, 100, texts={
                    "ru": "{first_name}, специально для вас скидка 20% на возвращение.\n\nКод <code>{promo_code}</code> действует 7 дней.",
                    "en": "{first_name}, here is 20% off to welcome you back.\n\nCode <code>{promo_code}</code> is valid for 7 days.",
                }, buttons=[_btn("promo_webapp")]),
                _n("g", "goal", 1000, 100, name="Вернулся"),
                _n("c", "exit", 520, 260, reason="control"),
            ],
            "edges": [_e("t", "s"), _e("s", "c", "a"), _e("s", "p", "b"), _e("p", "m"), _e("m", "g")],
        },
    },
    "welcome_no_payment": {
        "title": "Новичок без оплаты (через 24 часа)",
        "description": "Мягкое приглашение выбрать тариф через сутки после регистрации.",
        "graph": {
            "nodes": [
                _n("t", "trg_registered", 40, 140, hours=24, only_no_payment=True),
                _n("s", "split", 300, 140, percent_a=10, control_a=True),
                _n("m", "send_message", 560, 80, texts={
                    "ru": "{first_name}, добро пожаловать!\n\nВыберите тариф и подключитесь за пару минут — мы подскажем, как настроить.",
                    "en": "{first_name}, welcome!\n\nPick a plan and connect in a couple of minutes — we will help you set it up.",
                }, buttons=[_btn("webapp_section", "plans"), _btn("webapp_section", "install")]),
                _n("w", "wait", 820, 80, mode="delay", amount=2, unit="days"),
                _n("q", "if_paid", 1060, 80, since="entry"),
                _n("g", "goal", 1300, 20, name="Оплатил"),
                _n("x", "exit", 1300, 160, reason="не оплатил"),
                _n("c", "exit", 560, 240, reason="control"),
            ],
            "edges": [_e("t", "s"), _e("s", "c", "a"), _e("s", "m", "b"), _e("m", "w"), _e("w", "q"),
                      _e("q", "g", "yes"), _e("q", "x", "no")],
        },
    },
    "thanks_payment": {
        "title": "Спасибо за оплату",
        "description": "Сообщение через несколько минут после оплаты с подсказкой про приглашение друзей.",
        "graph": {
            "nodes": [
                _n("t", "trg_paid", 40, 100),
                _n("w", "wait", 280, 100, mode="delay", amount=5, unit="minutes"),
                _n("m", "send_message", 520, 100, texts={
                    "ru": "Спасибо, {first_name}! Оплата прошла успешно ✅\n\nПригласите друзей и получайте бонусы — ссылка в разделе «Бонусы».",
                    "en": "Thank you, {first_name}! Payment received ✅\n\nInvite friends and earn bonuses — see the Bonuses section.",
                }, category="subscriptions", respect_limits=False, buttons=[_btn("webapp_section", "invite")]),
                _n("g", "goal", 780, 100, name="Спасибо отправлено"),
            ],
            "edges": [_e("t", "w"), _e("w", "m"), _e("m", "g")],
        },
    },
}


def blank_graph() -> dict[str, Any]:
    return {
        "nodes": [_n("t", "trg_broadcast", 60, 120, mode="now", at="", time="12:00", weekdays=[0], audience={})],
        "edges": [],
    }
