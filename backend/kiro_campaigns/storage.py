"""Tables, defaults and settings helpers for campaigns. Every table is plugin-owned (ext_kiro_campaigns_*)."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncSession

from db.migrator.engine import Migration

PLUGIN_ID = "kiro-campaigns"

CAMPAIGN_STATUSES = ("draft", "active", "paused", "finished", "archived")

DEFAULT_SETTINGS: dict[str, Any] = {
    # Master switch: nothing is discovered or sent while this is off.
    "engine_enabled": False,
    # Offset from UTC in hours, used for quiet hours and "until hour" waits (MSK = 3).
    "tz_offset_hours": 3,
    "quiet_enabled": True,
    "quiet_from": 22,
    "quiet_to": 10,
    # Frequency limits across ALL campaigns, per user.
    "daily_cap": 2,
    "min_gap_hours": 12,
    # Telegram allows ~30 messages per second overall; stay well below.
    "rate_per_second": 20,
    # A payment counts for a campaign when it happens within this many days after a delivery.
    "attribution_days": 7,
    # Minimal days between two entries of the same user into the same campaign.
    "cooldown_days": 14,
    "respect_marketing_preference": True,
    # How long a message may be postponed by quiet hours or limits before it is skipped.
    "max_defer_hours": 48,
}

SETTING_BOUNDS: dict[str, tuple[int, int]] = {
    "tz_offset_hours": (-12, 14),
    "quiet_from": (0, 23),
    "quiet_to": (0, 23),
    "daily_cap": (0, 20),
    "min_gap_hours": (0, 720),
    "rate_per_second": (1, 28),
    "attribution_days": (1, 90),
    "cooldown_days": (0, 365),
    "max_defer_hours": (1, 720),
}
SETTING_FLAGS = ("engine_enabled", "quiet_enabled", "respect_marketing_preference")


def _upgrade_0001(connection: Connection) -> None:
    for statement in (
        """
        CREATE TABLE IF NOT EXISTS ext_kiro_campaigns_settings (
            id INTEGER PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS ext_kiro_campaigns_images (
            id VARCHAR(64) PRIMARY KEY,
            content_type VARCHAR(32) NOT NULL,
            body BYTEA NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS ext_kiro_campaigns (
            id SERIAL PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'draft',
            graph JSONB NOT NULL,
            live_version INTEGER NOT NULL DEFAULT 0,
            options JSONB NOT NULL DEFAULT '{}'::jsonb,
            last_run_key VARCHAR(64),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            started_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_ext_kiro_campaigns_status ON ext_kiro_campaigns (status)",
        """
        CREATE TABLE IF NOT EXISTS ext_kiro_campaigns_versions (
            campaign_id INTEGER NOT NULL REFERENCES ext_kiro_campaigns(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            graph JSONB NOT NULL,
            published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (campaign_id, version)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS ext_kiro_campaigns_enrollments (
            id BIGSERIAL PRIMARY KEY,
            campaign_id INTEGER NOT NULL REFERENCES ext_kiro_campaigns(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            user_id BIGINT NOT NULL,
            entry_key VARCHAR(64) NOT NULL DEFAULT '',
            status VARCHAR(12) NOT NULL DEFAULT 'active',
            exit_reason VARCHAR(32),
            node_id VARCHAR(40),
            wait_until TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deferred_since TIMESTAMPTZ,
            holdout BOOLEAN NOT NULL DEFAULT FALSE,
            ctx JSONB NOT NULL DEFAULT '{}'::jsonb,
            entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            finished_at TIMESTAMPTZ,
            CONSTRAINT uq_ext_kiro_campaigns_entry UNIQUE (campaign_id, user_id, entry_key)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_ext_kiro_campaigns_enr_due ON ext_kiro_campaigns_enrollments (status, wait_until)",
        "CREATE INDEX IF NOT EXISTS ix_ext_kiro_campaigns_enr_user ON ext_kiro_campaigns_enrollments (user_id, campaign_id, entered_at)",
        """
        CREATE TABLE IF NOT EXISTS ext_kiro_campaigns_events (
            id BIGSERIAL PRIMARY KEY,
            campaign_id INTEGER NOT NULL,
            version INTEGER NOT NULL,
            enrollment_id BIGINT,
            user_id BIGINT NOT NULL,
            node_id VARCHAR(40),
            node_type VARCHAR(24),
            kind VARCHAR(16) NOT NULL,
            detail JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_ext_kiro_campaigns_ev_camp ON ext_kiro_campaigns_events (campaign_id, kind, node_id)",
        "CREATE INDEX IF NOT EXISTS ix_ext_kiro_campaigns_ev_user ON ext_kiro_campaigns_events (user_id, kind, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_ext_kiro_campaigns_ev_time ON ext_kiro_campaigns_events (kind, created_at)",
    ):
        connection.exec_driver_sql(statement)


MIGRATIONS = [
    Migration(
        id=f"{PLUGIN_ID}.0001_initial",
        description="Campaigns: settings, images, graphs, versions, enrollments, events",
        upgrade=_upgrade_0001,
    ),
]


def clean_settings(body: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """Validate a partial settings update on top of the current values."""
    data = dict(current)
    for key in SETTING_FLAGS:
        if key in body:
            data[key] = bool(body[key])
    for key, (lo, hi) in SETTING_BOUNDS.items():
        if key in body:
            try:
                number = int(float(body[key]))
            except (TypeError, ValueError) as exc:
                raise ValueError(f"invalid_{key}") from exc
            if not lo <= number <= hi:
                raise ValueError(f"invalid_{key}")
            data[key] = number
    return data


async def load_settings(session: AsyncSession) -> dict[str, Any]:
    raw = await session.scalar(text("select data from ext_kiro_campaigns_settings where id = 1"))
    data = dict(DEFAULT_SETTINGS)
    if isinstance(raw, dict):
        data.update({k: v for k, v in raw.items() if k in DEFAULT_SETTINGS})
    elif isinstance(raw, str):
        data.update({k: v for k, v in json.loads(raw).items() if k in DEFAULT_SETTINGS})
    return data


async def save_settings(session: AsyncSession, data: dict[str, Any]) -> None:
    await session.execute(
        text(
            "insert into ext_kiro_campaigns_settings (id, data, updated_at) values (1, cast(:d as jsonb), now()) "
            "on conflict (id) do update set data = excluded.data, updated_at = now()"
        ),
        {"d": json.dumps(data, ensure_ascii=False)},
    )
