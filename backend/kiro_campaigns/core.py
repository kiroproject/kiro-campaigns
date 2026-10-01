"""Bridge between the engine and Minishop Core (Telegram delivery, promo codes, consent).

Everything Core-specific lives here so that the engine itself stays testable on a plain database.
Rendering, buttons and the HTML linter are Core's own broadcast helpers, so a campaign message looks
and validates exactly like an admin broadcast.
"""

from __future__ import annotations

import html
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from aiogram.exceptions import TelegramRetryAfter
from aiogram.types import BufferedInputFile
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from bot.plugins.spec import PluginContext
from bot.services.broadcast_personalization import (
    SHORTCODES,
    known_shortcodes,
    load_broadcast_contexts,
    render_broadcast_text,
    telegram_html_error,
    unknown_shortcodes,
)
from bot.services.message_audit import log_user_message_delivery
from bot.services.message_composition import (
    MessageButtonInput,
    MessageValidationError,
    resolve_message_buttons,
    telegram_markup_for_buttons,
)
from bot.services.promo_code_service import PromoCodeService
from bot.services.promo_effects import PromoEffects
from bot.services.telegram_notifications import (
    mark_telegram_notifications_status,
    telegram_notification_status_from_error,
)
from bot.services.user_notification_policy import UserNotificationCategory, user_notification_delivery_plan
from db.models import User

from .engine import SendResult
from .storage import PLUGIN_ID

logger = logging.getLogger(__name__)

__all__ = ["CoreHost", "html_error", "shortcode_names", "unknown_codes"]


def html_error(body: str) -> str | None:
    return telegram_html_error(body)


def unknown_codes(body: str) -> set[str]:
    return set(unknown_shortcodes(body))


def shortcode_names() -> list[str]:
    return sorted(SHORTCODES)


class CoreHost:
    def __init__(self, ctx: PluginContext) -> None:
        self.ctx = ctx
        self._username: str | None = None

    async def _bot_username(self) -> str:
        if self._username is None:
            bot = self.ctx.require_bot()
            try:
                self._username = (await bot.get_me()).username or ""
            except Exception:  # noqa: BLE001
                logger.warning("kiro-campaigns: could not read the bot username")
                self._username = ""
        return self._username

    # ----------------------------------------------------------------- send

    def _pick_text(self, texts: dict[str, str], lang: str) -> str:
        default = (self.ctx.settings.DEFAULT_LANGUAGE or "ru").lower()
        return texts.get(lang) or texts.get(default) or texts.get("ru") or next(iter(texts.values()), "")

    async def render(
        self, session: AsyncSession, *, user_id: int, language: str, params: dict[str, Any], promo_code: str | None
    ) -> tuple[str, list[Any]]:
        """Rendered HTML text and resolved buttons for one recipient."""
        settings = self.ctx.settings
        lang = (language or settings.DEFAULT_LANGUAGE or "ru").lower()
        body = self._pick_text(params["texts"], lang)
        needed = set(known_shortcodes(body))
        contexts = (
            await load_broadcast_contexts(session, settings, [user_id], needed, self.ctx.panel_service) if needed else {}
        )
        username = await self._bot_username()
        rendered = render_broadcast_text(
            body, contexts.get(user_id), lang=lang, i18n=self.ctx.i18n, settings=settings, bot_username=username, escape=True
        )
        rendered = rendered.replace("{promo_code}", html.escape(promo_code or ""))
        specs = []
        for button in params["buttons"]:
            kind = button["kind"]
            if kind in ("promo_webapp", "promo_bot") and not promo_code:
                continue  # no code issued for this person: skip the promo button instead of failing the message
            specs.append(
                MessageButtonInput(
                    kind=kind, label=button["label"], url=button["url"],
                    promo_code=(promo_code or "") if kind in ("promo_webapp", "promo_bot") else "",
                    section=button["section"] if kind == "webapp_section" else "",
                )
            )
        buttons = resolve_message_buttons(
            specs,
            mini_app_url=settings.SUBSCRIPTION_MINI_APP_URL,
            bot_username=username,
            language=lang,
            translate=(lambda code, key: self.ctx.i18n.gettext(code, key)) if self.ctx.i18n else None,
            default_language=settings.DEFAULT_LANGUAGE,
        )
        return rendered, buttons

    async def _image(self, session: AsyncSession, image_id: str) -> BufferedInputFile | None:
        if not image_id:
            return None
        row = (
            await session.execute(
                text("select body, content_type from ext_kiro_campaigns_images where id = :i"), {"i": image_id}
            )
        ).first()
        if row is None:
            return None
        ext = "png" if row[1] == "image/png" else "jpg"
        return BufferedInputFile(bytes(row[0]), filename=f"campaign.{ext}")

    async def send_message(
        self, session: AsyncSession, *, user: dict[str, Any], params: dict[str, Any], ctx: dict[str, Any], campaign: str
    ) -> SendResult:
        bot = self.ctx.require_bot()
        uid, chat_id = int(user["user_id"]), int(user["telegram_id"])
        try:
            rendered, buttons = await self.render(
                session, user_id=uid, language=user.get("language_code") or "", params=params, promo_code=ctx.get("promo_code")
            )
            markup = telegram_markup_for_buttons(buttons)
            photo = await self._image(session, params["image_id"])
        except MessageValidationError as exc:
            return SendResult("failed", f"content:{exc.code}")
        if not rendered.strip():
            return SendResult("failed", "empty_text")
        try:
            if photo is not None:
                sent = await bot.send_photo(chat_id, photo, caption=rendered[:1024], parse_mode="HTML", reply_markup=markup)
            else:
                sent = await bot.send_message(
                    chat_id, rendered, parse_mode="HTML", disable_web_page_preview=True, reply_markup=markup
                )
        except TelegramRetryAfter as exc:
            return SendResult("failed", f"retry_after:{exc.retry_after}")
        except Exception as exc:  # noqa: BLE001
            status = telegram_notification_status_from_error(exc)
            if status:
                await mark_telegram_notifications_status(session, uid, status)
                return SendResult("blocked", str(exc)[:200])
            logger.warning("kiro-campaigns: send to %s failed: %s", uid, exc)
            return SendResult("failed", str(exc)[:200])
        await log_user_message_delivery(
            session,
            target_user_id=uid,
            event_type="plugin_campaign_message",
            channel="telegram",
            recipient=str(chat_id),
            content=rendered[:4096],
            timestamp=datetime.now(UTC),
        )
        return SendResult("sent", message_id=getattr(sent, "message_id", None))

    async def preview(self, session: AsyncSession, *, user_id: int, language: str, params: dict[str, Any]) -> str:
        rendered, _ = await self.render(session, user_id=user_id, language=language, params=params, promo_code="PROMO-EXAMPLE")
        return rendered

    async def send_test(
        self, session: AsyncSession, *, chat_id: int, user_id: int, params: dict[str, Any]
    ) -> SendResult:
        """Send a message to an admin as the given user would see it, with an obviously fake promo code."""
        user = {"user_id": user_id, "telegram_id": chat_id, "language_code": ""}
        row = (await session.execute(text("select language_code from users where user_id = :u"), {"u": user_id})).first()
        if row:
            user["language_code"] = row[0] or ""
        return await self.send_message(session, user=user, params=params, ctx={"promo_code": "TEST-PROMO"}, campaign="test")

    # ---------------------------------------------------------------- promo

    async def issue_promo(self, session: AsyncSession, *, user_id: int, params: dict[str, Any]) -> str:
        kind, value = params["kind"], float(params["value"])
        if kind == "discount":
            effects = PromoEffects(discount_percent=value, applies_to="subscription")
        elif kind == "bonus_days":
            effects = PromoEffects(bonus_days=int(value))
        elif kind == "regular_traffic":
            effects = PromoEffects(regular_traffic_gb=value)
        else:
            effects = PromoEffects(premium_traffic_gb=value)
        code = await PromoCodeService.issue_code(
            session,
            effects=effects,
            code=None,
            max_activations=1,
            valid_until=datetime.now(UTC) + timedelta(days=int(params["valid_days"])),
            origin=PLUGIN_ID,
            created_by_admin_id=None,
            user_id=user_id,
            owner_plugin_id=PLUGIN_ID,
        )
        return str(code.code)

    # -------------------------------------------------------------- consent

    async def allows(self, session: AsyncSession, *, user_id: int, category: str, respect: bool) -> bool:
        if category == "marketing" and not respect:
            return True
        user = (await session.execute(select(User).where(User.user_id == user_id))).scalar_one_or_none()
        if user is None:
            return False
        enum = UserNotificationCategory.MARKETING if category == "marketing" else UserNotificationCategory.SUBSCRIPTIONS
        plan = user_notification_delivery_plan(self.ctx.settings, enum, user, email_available=False)
        return bool(plan.telegram)

    async def notify_admins(self, text_: str) -> None:
        bot = self.ctx.bot
        if bot is None:
            return
        for admin_id in self.ctx.settings.ADMIN_IDS or []:
            try:
                await bot.send_message(int(admin_id), text_[:1000])
            except Exception:  # noqa: BLE001
                logger.warning("kiro-campaigns: admin notification to %s failed", admin_id)
