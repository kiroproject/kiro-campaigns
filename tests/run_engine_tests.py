"""Engine tests on a throwaway PostgreSQL (pgserver). Core is replaced by a minimal schema and a fake host.

Run:  python tests/run_engine_tests.py     (needs: pgserver sqlalchemy[asyncio] asyncpg)
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import types
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pgserver
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

ROOT = Path(__file__).resolve().parents[1] / "backend" / "kiro_campaigns"

# --- load the package without running its __init__ (which needs Core) ---------------------------
migr = types.ModuleType("db.migrator.engine")


@dataclass
class Migration:
    id: str
    description: str
    upgrade: object


migr.Migration = Migration
for name in ("db", "db.migrator"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["db.migrator.engine"] = migr
pkg = types.ModuleType("kiro_campaigns")
pkg.__path__ = [str(ROOT)]
sys.modules["kiro_campaigns"] = pkg

from kiro_campaigns import audience, engine as eng, graph as g, reports, storage  # noqa: E402

CORE_DDL = """
CREATE TABLE users (user_id BIGINT PRIMARY KEY, username TEXT, telegram_id BIGINT UNIQUE, first_name TEXT,
  language_code TEXT DEFAULT 'ru', registration_date TIMESTAMPTZ DEFAULT now(), is_banned BOOLEAN DEFAULT FALSE,
  referred_by_id BIGINT, telegram_notifications_status VARCHAR(32) NOT NULL DEFAULT 'unknown');
CREATE TABLE subscriptions (subscription_id SERIAL PRIMARY KEY, user_id BIGINT, start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ NOT NULL, duration_days INT, is_active BOOLEAN DEFAULT TRUE, last_connected_at TIMESTAMPTZ,
  provider TEXT, tariff_key TEXT);
CREATE TABLE payments (payment_id SERIAL PRIMARY KEY, user_id BIGINT, provider TEXT, funding_source VARCHAR(48) DEFAULT 'external',
  amount FLOAT, currency TEXT, status TEXT, tariff_key TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE promo_codes (promo_code_id SERIAL PRIMARY KEY, code TEXT UNIQUE);
CREATE TABLE promo_code_activations (activation_id SERIAL PRIMARY KEY, promo_code_id INT, user_id BIGINT, payment_id INT);
"""

PASSED = 0


def ok(cond: bool, label: str) -> None:
    global PASSED
    if not cond:
        raise AssertionError(label)
    PASSED += 1
    print(f"  ok  {label}")


class FakeHost:
    def __init__(self) -> None:
        self.sent: list[tuple[int, dict]] = []
        self.promos: list[int] = []
        self.admin: list[str] = []
        self.fail_for: dict[int, str] = {}
        self.deny: set[int] = set()

    async def send_message(self, session, *, user, params, ctx, campaign):
        if user["user_id"] in self.fail_for:
            return eng.SendResult(self.fail_for[user["user_id"]], "boom")
        self.sent.append((user["user_id"], {"texts": params["texts"], "promo": ctx.get("promo_code")}))
        return eng.SendResult("sent", message_id=len(self.sent))

    async def issue_promo(self, session, *, user_id, params):
        self.promos.append(user_id)
        return f"PROMO{user_id}"

    async def notify_admins(self, text_):
        self.admin.append(text_)

    async def allows(self, session, *, user_id, category, respect):
        return user_id not in self.deny


def node(id_, type_, **params):
    return {"id": id_, "type": type_, "x": 0, "y": 0, "params": params}


def edge(a, b, port="out"):
    return {"from": a, "port": port, "to": b}


def build(nodes, edges):
    return g.clean_graph({"nodes": nodes, "edges": edges})


async def main() -> None:
    server = pgserver.get_server(tempfile.mkdtemp())
    url = server.get_uri().replace("postgresql://", "postgresql+asyncpg://")
    engine = create_async_engine(url)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with engine.begin() as conn:
        for stmt in CORE_DDL.strip().split(";"):
            if stmt.strip():
                await conn.exec_driver_sql(stmt)
        await conn.run_sync(lambda c: storage._upgrade_0001(c))

    async def sql(q: str, **a):
        async with factory() as s:
            r = await s.execute(text(q), a)
            await s.commit()
            return r

    async def scalar(q: str, **a):
        async with factory() as s:
            value = await s.scalar(text(q), a)
            await s.commit()
            return value

    now = datetime.now(UTC)

    async def user(uid, *, tg=True, banned=False, status="unknown", registered_days=30, lang="ru", referred=None):
        await sql(
            "insert into users (user_id, telegram_id, first_name, language_code, is_banned, telegram_notifications_status, "
            "registration_date, referred_by_id) values (:u, :t, :n, :l, :b, :s, now() - cast(:d as integer) * interval '1 day', :r)",
            u=uid, t=uid if tg else None, n=f"U{uid}", l=lang, b=banned, s=status, d=registered_days, r=referred,
        )

    async def sub(uid, *, ends_in_days, tariff="start", provider="panel", connected_days_ago=0, active=True):
        await sql(
            "insert into subscriptions (user_id, start_date, end_date, is_active, tariff_key, provider, last_connected_at) values "
            "(:u, now() - interval '60 days', now() + cast(:e as double precision) * interval '1 day', :a, :t, :p, "
            "case when cast(:c as integer) is null then null else now() - cast(:c as integer) * interval '1 day' end)",
            u=uid, e=ends_in_days, a=active, t=tariff, p=provider, c=connected_days_ago,
        )

    async def pay(uid, *, ago_hours=0, status="succeeded", funding="external", amount=300.0):
        await sql(
            "insert into payments (user_id, provider, funding_source, amount, currency, status, created_at) values "
            "(:u, 'yookassa', :f, :a, 'RUB', :s, now() - cast(:h as integer) * interval '1 hour')",
            u=uid, f=funding, a=amount, s=status, h=ago_hours,
        )

    # ------------------------------------------------------------------ catalog / graph
    print("graph")
    meta = g.catalog_meta()
    ok(set(meta["nodes"]) >= {"send_message", "split", "wait", "issue_promo", "trg_broadcast"}, "catalog has the blocks")
    chain = build(
        [
            node("t", "trg_sub_expired", days=3),
            node("m", "send_message", texts={"ru": "Привет, {first_name}! Код {promo_code}"}, category="marketing"),
            node("p", "issue_promo", kind="discount", value=10, valid_days=14),
            node("g", "goal", name="Оплата"),
        ],
        [edge("t", "p"), edge("p", "m"), edge("m", "g")],
    )
    issues = g.validate_graph(chain)
    ok(not g.has_errors(issues), "valid chain has no errors")
    cyc = build([node("t", "trg_paid"), node("a", "wait", amount=1), node("b", "wait", amount=1)], [edge("t", "a"), edge("a", "b"), edge("b", "a")])
    ok(any(i["code"] == "cycle" for i in g.validate_graph(cyc)), "cycle is rejected")
    no_promo = build([node("t", "trg_paid"), node("m", "send_message", texts={"ru": "Код {promo_code}"})], [edge("t", "m")])
    ok(any(i["code"] == "promo_missing" for i in g.validate_graph(no_promo)), "promo token without promo block is rejected")
    two = build([node("a", "trg_paid"), node("b", "trg_inactive", days=5)], [])
    ok(any(i["code"] == "trigger_count" for i in g.validate_graph(two)), "exactly one trigger is required")
    try:
        build([node("a", "trg_paid")], [edge("a", "a", "nope")])
        ok(False, "bad port rejected")
    except g.GraphError:
        ok(True, "bad port rejected")
    ok(audience.clean_filter({"sub_state": "bogus", "tariffs": "a, b ,;drop", "days_left_max": "5"}) == {"tariffs": ["a", "b"], "days_left_max": 5}, "filter cleaning drops junk")

    # ------------------------------------------------------------------ discovery
    print("discovery")
    await user(1)                          # active, ends in 2 days
    await sub(1, ends_in_days=2)
    await user(2)                          # active, ends in 20 days
    await sub(2, ends_in_days=20)
    await user(3)                          # expired 4 days ago
    await sub(3, ends_in_days=-4)
    await user(4, status="blocked")        # blocked the bot
    await sub(4, ends_in_days=1)
    await user(5, banned=True)             # banned
    await sub(5, ends_in_days=1)
    await user(6, tg=False)                # no telegram
    await sub(6, ends_in_days=1)
    await user(7, registered_days=0)       # registered 25 h ago, never paid
    await sql("update users set registration_date = now() - interval '25 hours' where user_id = 7")
    await user(8)                          # inactive 20 days
    await sub(8, ends_in_days=30, connected_days_ago=20)
    await pay(8, ago_hours=2)              # fresh payment
    await user(9, lang="en")
    await sub(9, ends_in_days=3, tariff="premium")

    async def candidates(ttype, **params):
        spec = g.CATALOG[ttype]
        full = g.clean_params(ttype, params)
        sql_, args = audience.candidates_sql(ttype, full, run_key="k1")
        async with factory() as s:
            rows = (await s.execute(text(f"select user_id from ({sql_}) c order by 1"), args)).scalars().all()
        return [int(x) for x in rows]

    ok(await candidates("trg_sub_ends", days=3) == [1, 9], "sub_ends(3): only eligible users with <=3 days left")
    ok(await candidates("trg_sub_ends", days=3, audience={"tariffs": ["premium"]}) == [9], "audience filter by tariff")
    ok(await candidates("trg_sub_ends", days=30, audience={"languages": ["en"]}) == [9], "audience filter by language")
    ok(await candidates("trg_sub_expired", days=3) == [3], "sub_expired(3): expired 4 days ago")
    ok(await candidates("trg_sub_expired", days=5) == [], "sub_expired(5): not yet")
    ok(await candidates("trg_registered", hours=24) == [7], "registered 24h: only the never-paid 25h-old user")
    ok(await candidates("trg_paid") == [8], "paid: the user with a fresh payment")
    ok(await candidates("trg_inactive", days=14) == [8], "inactive 14d: the user idle for 20d")
    ok(await candidates("trg_broadcast", audience={"sub_state": "active"}) == [1, 2, 8, 9], "broadcast to active (blocked/banned/no-telegram excluded)")
    ok(await candidates("trg_broadcast", audience={"paid": "yes"}) == [8], "broadcast paid=yes")
    ok(await candidates("trg_broadcast", audience={"days_left_min": 10, "days_left_max": 25}) == [2], "days_left range")
    ok(await candidates("trg_broadcast", audience={"expired_days_min": 1}) == [3], "expired_days_min")
    ok(await candidates("trg_broadcast", audience={"sub_state": "never"}) == [7], "sub_state never")

    # ------------------------------------------------------------------ one-shot broadcast
    print("broadcast")
    host = FakeHost()
    settings_off = {**storage.DEFAULT_SETTINGS}
    en = eng.Engine(factory, host, sleep=lambda s: asyncio.sleep(0))
    async with factory() as s:
        await storage.save_settings(s, {**settings_off, "engine_enabled": True, "quiet_enabled": False, "daily_cap": 5, "min_gap_hours": 0})
        await s.commit()

    async def create_campaign(name, graph, status="active", options=None):
        async with factory() as s:
            cid = await s.scalar(
                text("insert into ext_kiro_campaigns (name, status, graph, live_version, options, started_at) values "
                     "(:n, :st, cast(:g as jsonb), 1, cast(:o as jsonb), now()) returning id"),
                {"n": name, "st": status, "g": json.dumps(graph), "o": json.dumps(options or {})},
            )
            await s.execute(text("insert into ext_kiro_campaigns_versions (campaign_id, version, graph) values (:c, 1, cast(:g as jsonb))"),
                            {"c": cid, "g": json.dumps(graph)})
            await s.commit()
            return cid

    bc = build(
        [node("t", "trg_broadcast", mode="now", audience={"sub_state": "active"}),
         node("m", "send_message", texts={"ru": "Акция для {first_name}"}, respect_limits=False),
         node("g", "goal", name="sent")],
        [edge("t", "m"), edge("m", "g")],
    )
    cid = await create_campaign("broadcast", bc)
    stats = await en.tick()
    ok(sorted(u for u, _ in host.sent) == [1, 2, 8, 9], "broadcast sent to the 4 eligible users")
    ok(stats["entered"] == 4, "tick reports 4 entered")
    ok(await scalar("select status from ext_kiro_campaigns where id = :c", c=cid) == "finished", "one-shot broadcast finishes itself")
    stats = await en.tick()
    ok(len(host.sent) == 4, "second tick does not resend")
    ok(await scalar("select count(*) from ext_kiro_campaigns_events where campaign_id = :c and kind = 'sent'", c=cid) == 4, "4 sent events")
    ok(await scalar("select count(*) from ext_kiro_campaigns_events where campaign_id = :c and node_id = 'm' and kind = 'visit'", c=cid) == 4, "visit counters per node")

    # ------------------------------------------------------------------ chain with promo, wait, control group, exit on payment
    print("chain")
    host = FakeHost()
    en = eng.Engine(factory, host, sleep=lambda s: asyncio.sleep(0))
    await sql("delete from ext_kiro_campaigns")
    ch = build(
        [node("t", "trg_sub_expired", days=3),
         node("s", "split", percent_a=100 - 99, control_a=True),   # 1% control: nobody of ours lands there by chance
         node("p", "issue_promo", kind="discount", value=10, valid_days=14),
         node("m", "send_message", texts={"ru": "Вернитесь, {first_name}! {promo_code}"}, respect_limits=False),
         node("w", "wait", mode="delay", amount=2, unit="days"),
         node("q", "if_paid", since="entry"),
         node("ok", "goal", name="Оплатил"),
         node("m2", "send_message", texts={"ru": "Последний шанс"}, respect_limits=False),
         node("x", "exit", reason="control")],
        [edge("t", "s"), edge("s", "x", "a"), edge("s", "p", "b"), edge("p", "m"), edge("m", "w"), edge("w", "q"),
         edge("q", "ok", "yes"), edge("q", "m2", "no")],
    )
    cid = await create_campaign("chain", ch)
    await en.tick()
    ok(host.promos == [3], "promo issued for the entrant")
    ok(host.sent and host.sent[0][0] == 3 and host.sent[0][1]["promo"] == "PROMO3", "message carries the promo code in ctx")
    row = (await sql("select node_id, status, wait_until > now() + interval '40 hours' as far from ext_kiro_campaigns_enrollments where campaign_id = :c", c=cid)).mappings().one()
    ok(row["node_id"] == "q" and row["status"] == "active" and row["far"], "parked at the condition after the 2-day wait")
    await en.tick()
    ok(len(host.sent) == 1, "nothing is sent while waiting")
    # time passes: no payment -> second message
    await sql("update ext_kiro_campaigns_enrollments set wait_until = now() - interval '1 minute' where campaign_id = :c", c=cid)
    await en.tick()
    ok([t["texts"]["ru"] for _, t in host.sent] == ["Вернитесь, {first_name}! {promo_code}", "Последний шанс"], "second message when unpaid")
    ok(await scalar("select status from ext_kiro_campaigns_enrollments where campaign_id = :c", c=cid) == "done", "enrollment completed")
    # a user who pays during the wait -> goal, not the reminder
    await sql("delete from ext_kiro_campaigns_enrollments"); await sql("delete from ext_kiro_campaigns_events")
    host.sent.clear(); host.promos.clear()
    await sql("update ext_kiro_campaigns set last_run_key = null")
    await en.tick()
    await pay(3, ago_hours=0)
    await sql("update ext_kiro_campaigns_enrollments set wait_until = now() - interval '1 minute' where campaign_id = :c", c=cid)
    await en.tick()
    ok(len(host.sent) == 1, "paid user does not get the reminder")
    ok(await scalar("select count(*) from ext_kiro_campaigns_events where kind = 'goal'") == 1, "goal event recorded")
    # control group
    ch_ctrl = build([node("t", "trg_sub_expired", days=3), node("s", "split", percent_a=99, control_a=True),
                     node("m", "send_message", texts={"ru": "X"}, respect_limits=False), node("x", "exit", reason="control")],
                    [edge("t", "s"), edge("s", "x", "a"), edge("s", "m", "b")])
    await sql("delete from ext_kiro_campaigns"); await sql("delete from ext_kiro_campaigns_events"); await sql("delete from payments where user_id = 3")
    host.sent.clear()
    cid2 = await create_campaign("ctrl", ch_ctrl)
    bucket = eng.split_bucket(cid2, "s", 3)
    await en.tick()
    in_control = bucket < 99
    ok((len(host.sent) == 0) == in_control, f"control group (bucket {bucket}) gets nothing, others do")
    ok(bool(await scalar("select holdout from ext_kiro_campaigns_enrollments where campaign_id = :c", c=cid2)) == in_control, "holdout flag stored")

    # ------------------------------------------------------------------ limits, quiet hours, consent, failures
    print("limits")
    host = FakeHost()
    fixed_now = datetime.now(UTC).replace(hour=20, minute=0, second=0, microsecond=0)  # 23:00 MSK
    en = eng.Engine(factory, host, clock=lambda: fixed_now, sleep=lambda s: asyncio.sleep(0))
    async with factory() as s:
        await storage.save_settings(s, {**storage.DEFAULT_SETTINGS, "engine_enabled": True, "quiet_enabled": True, "quiet_from": 22, "quiet_to": 10,
                                        "tz_offset_hours": 3, "daily_cap": 1, "min_gap_hours": 0})
        await s.commit()
    msg = build([node("t", "trg_sub_expired", days=3), node("m", "send_message", texts={"ru": "Q"}), node("m2", "send_message", texts={"ru": "Q2"})],
                [edge("t", "m"), edge("m", "m2")])
    await sql("delete from ext_kiro_campaigns"); await sql("delete from ext_kiro_campaigns_enrollments"); await sql("delete from ext_kiro_campaigns_events")
    cid = await create_campaign("quiet", msg)
    await en.tick()
    ok(len(host.sent) == 0, "quiet hours: nothing is sent at 23:00 local")
    wake = (await sql("select wait_until, deferred_since is not null as d from ext_kiro_campaigns_enrollments where campaign_id = :c", c=cid)).mappings().one()
    expected = fixed_now.replace(hour=7)  # 10:00 MSK = 07:00 UTC next day
    if expected <= fixed_now:
        expected += timedelta(days=1)
    ok(wake["d"], "deferral remembered")
    ok(wake["wait_until"].astimezone(UTC).hour == 7, "wakes at the end of quiet hours (10:00 local)")
    # daytime: first message goes, second is held back by the daily cap
    day = datetime.now(UTC).replace(hour=9, minute=0, second=0, microsecond=0)  # 12:00 MSK
    en = eng.Engine(factory, host, clock=lambda: day, sleep=lambda s: asyncio.sleep(0))
    await sql("update ext_kiro_campaigns_enrollments set wait_until = now() - interval '1 minute' where campaign_id = :c", c=cid)
    await en.tick()
    ok(len(host.sent) == 1, "daytime: first message sent")
    r = (await sql("select node_id, status from ext_kiro_campaigns_enrollments where campaign_id = :c", c=cid)).mappings().one()
    ok(r["node_id"] == "m2" and r["status"] == "active", "second message waits for the daily cap")
    ok(await scalar("select wait_until > now() + interval '20 hours' from ext_kiro_campaigns_enrollments where campaign_id = :c", c=cid), "deferred ~24h by the cap")
    # consent
    host2 = FakeHost(); host2.deny.add(3)
    en2 = eng.Engine(factory, host2, clock=lambda: day, sleep=lambda s: asyncio.sleep(0))
    await sql("delete from ext_kiro_campaigns_enrollments"); await sql("delete from ext_kiro_campaigns_events")
    await sql("update ext_kiro_campaigns set last_run_key = null")
    await en2.tick()
    ok(len(host2.sent) == 0 and await scalar("select count(*) from ext_kiro_campaigns_events where kind = 'skipped'") >= 1, "no marketing consent: skipped, logged")
    # failures: blocked ends, transient retries
    host3 = FakeHost(); host3.fail_for[3] = "blocked"
    en3 = eng.Engine(factory, host3, clock=lambda: day, sleep=lambda s: asyncio.sleep(0))
    await sql("delete from ext_kiro_campaigns_enrollments"); await sql("delete from ext_kiro_campaigns_events")
    await en3.tick()
    ok(await scalar("select exit_reason from ext_kiro_campaigns_enrollments") == "blocked", "blocked bot ends the path")
    async with factory() as s_:
        await storage.save_settings(s_, {**storage.DEFAULT_SETTINGS, "engine_enabled": True, "quiet_enabled": False, "daily_cap": 5, "min_gap_hours": 0})
        await s_.commit()
    host4 = FakeHost(); host4.fail_for[3] = "failed"
    en4 = eng.Engine(factory, host4, sleep=lambda s: asyncio.sleep(0))
    await sql("delete from ext_kiro_campaigns_enrollments"); await sql("delete from ext_kiro_campaigns_events")
    await en4.tick()
    st = (await sql("select status, wait_until > now() as future, ctx from ext_kiro_campaigns_enrollments")).mappings().one()
    ok(st["status"] == "active" and st["future"] and eng.jload(st["ctx"])["retries"] == 1, "transient failure is retried later")
    # paused campaign is ignored; engine switch off
    await sql("update ext_kiro_campaigns set status = 'paused'")
    await sql("update ext_kiro_campaigns_enrollments set wait_until = now() - interval '1 minute'")
    host5 = FakeHost()
    await eng.Engine(factory, host5, clock=lambda: day, sleep=lambda s: asyncio.sleep(0)).tick()
    ok(not host5.sent, "paused campaign is not processed")

    # ------------------------------------------------------------------ simulate
    print("simulate")
    events_before = await scalar("select count(*) from ext_kiro_campaigns_events")
    promos_before, sent_before = len(host.promos), len(host.sent)
    async with factory() as s:
        path = await en.simulate(s, ch, 3, storage.DEFAULT_SETTINGS)
    ids = [p["node_id"] for p in path]
    in_control = eng.split_bucket(0, "s", 3) < 1
    ok(ids[:2] == ["t", "s"], "simulation starts at the trigger and the split")
    ok(ids[2] == ("x" if in_control else "p"), "deterministic branch for the same user")
    ok(await scalar("select count(*) from ext_kiro_campaigns_events") == events_before, "simulation writes no events")
    ok(len(host.promos) == promos_before and len(host.sent) == sent_before, "simulation issues no promo codes and sends nothing")

    # ------------------------------------------------------------------ reports
    print("reports")
    await sql("delete from payments"); await sql("delete from ext_kiro_campaigns_events"); await sql("delete from ext_kiro_campaigns_enrollments")
    await sql("delete from ext_kiro_campaigns")
    rc = await create_campaign("report", build([node("t", "trg_paid"), node("p", "issue_promo", kind="discount", value=10, valid_days=7),
                                                 node("m", "send_message", texts={"ru": "x"})], [edge("t", "p"), edge("p", "m")]))
    # treated: users 1,2,3 reached; control: user 7 (holdout)
    for u in (1, 2, 3):
        eid = await scalar("insert into ext_kiro_campaigns_enrollments (campaign_id, version, user_id, entry_key, node_id, status) "
                           "values (:c, 1, :u, 'k', 'm', 'done') returning id", c=rc, u=u)
        await sql("insert into ext_kiro_campaigns_events (campaign_id, version, enrollment_id, user_id, node_id, node_type, kind, created_at) "
                  "values (:c, 1, :e, :u, 'm', 'send_message', 'sent', now() - interval '3 days')", c=rc, e=eid, u=u)
    await sql("insert into ext_kiro_campaigns_enrollments (campaign_id, version, user_id, entry_key, node_id, status, holdout, entered_at) "
              "values (:c, 1, 7, 'k', 'x', 'done', true, now() - interval '3 days')", c=rc)
    await sql("insert into payments (user_id, provider, funding_source, amount, currency, status, created_at) values "
              "(1, 'y', 'external', 500, 'RUB', 'succeeded', now() - interval '1 day'),"
              "(1, 'y', 'external', 100, 'RUB', 'succeeded', now() - interval '12 hours'),"
              "(2, 'y', 'external', 5, 'USD', 'succeeded', now() - interval '2 days'),"
              "(3, 'y', 'balance', 900, 'RUB', 'succeeded', now() - interval '1 day'),"       # paid from balance: not revenue
              "(7, 'y', 'external', 300, 'RUB', 'succeeded', now() - interval '1 day'),"       # control converted
              "(7, 'y', 'external', 50, 'RUB', 'canceled', now() - interval '1 day')")
    # a promo code issued by the campaign and used in a payment
    await sql("insert into ext_kiro_campaigns_events (campaign_id, version, enrollment_id, user_id, node_id, node_type, kind, detail) "
              "values (:c, 1, 1, 1, 'p', 'issue_promo', 'promo', cast(:d as jsonb))", c=rc, d=json.dumps({"code": "ABC123"}))
    await sql("insert into promo_codes (code) values ('ABC123')")
    pid = await scalar("select payment_id from payments where user_id = 1 and amount = 500")
    await sql("insert into promo_code_activations (promo_code_id, user_id, payment_id) values (1, 1, :p)", p=pid)
    async with factory() as s:
        rep = await reports.campaign_report(s, rc, 7)
    ok(rep["treated"]["n"] == 3 and rep["treated"]["converted"] == 2, "treated: 3 reached, 2 paid in the window")
    ok(rep["treated"]["revenue"] == {"RUB": 600.0, "USD": 5.0}, "revenue split per currency, balance-funded payment excluded")
    ok(rep["control"]["n"] == 1 and rep["control"]["converted"] == 1 and rep["control"]["revenue"] == {"RUB": 300.0}, "control group measured separately")
    ok(rep["uplift_pp"] == round(66.67 - 100.0, 2), "uplift = treated rate - control rate")
    ok(rep["promo"]["issued"] == 1 and rep["promo"]["activated"] == 1 and rep["promo"]["payments"] == 1 and rep["promo"]["revenue"] == {"RUB": 500.0},
       "exact promo attribution")
    ok(rep["nodes"]["m"]["sent"] == 3 and rep["nodes"]["m"]["payments"] == 3, "per-block counts and last-touch credit")
    ok(rep["funnel"]["entered"] == 4 and rep["funnel"]["holdout"] == 1, "funnel counters")
    async with factory() as s:
        ov = await reports.overview(s, 7)
    ok(ov[rc]["reached"] == 3 and ov[rc]["converted"] == 2 and ov[rc]["rate"] == 66.67, "overview row")
    async with factory() as s:
        an = await reports.analytics(s, 30, 7, 3)
    ok(an["totals"]["RUB"]["revenue"] == 900.0 and an["totals"]["RUB"]["payments"] == 3, "analytics totals exclude balance and canceled")
    ok(an["payers"]["all"] == 3 and an["payers"]["new"] == 3, "payers counted")
    ok(len(an["series"]["RUB"]) == 31 and sum(p["revenue"] for p in an["series"]["RUB"]) == 900.0, "daily series is gap-filled")
    ok(an["campaign_share"]["RUB"]["revenue"] == 600.0, "campaign share counts payments after a delivery")
    ok(isinstance(an["tariffs"], list) and "subscriptions" in an and "trial" in an, "analytics shape")

    # ------------------------------------------------------------------ settings validation
    print("settings")
    cur = dict(storage.DEFAULT_SETTINGS)
    ok(storage.clean_settings({"daily_cap": "3", "engine_enabled": True}, cur)["daily_cap"] == 3, "settings accept valid values")
    try:
        storage.clean_settings({"rate_per_second": 500}, cur)
        ok(False, "rate limit bounded")
    except ValueError:
        ok(True, "rate limit bounded")

    await engine.dispose()
    server.cleanup()
    print(f"\n{PASSED} checks passed")


asyncio.run(main())
