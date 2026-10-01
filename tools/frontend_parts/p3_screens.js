// ---------------------------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------------------------
const cache = { tab: "campaigns", cid: null, sub: "editor", window: null };

const h = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

function statusBadge(status) {
  const [label, color] = STATUS[status] || [status, "#888"];
  return `<span class="kc-badge" style="color:${color}">${esc(label)}</span>`;
}

function modal(html, onMount) {
  const m = h(`<div class="kc-modal"><div>${html}</div></div>`);
  document.body.appendChild(m);
  const close = () => m.remove();
  m.addEventListener("pointerdown", (e) => { if (e.target === m) close(); });
  onMount?.(m, close);
  return { el: m, close };
}

function confirmBox(text, okLabel = "Продолжить") {
  return new Promise((resolve) => {
    modal(`<p style="margin:0 0 14px;line-height:1.5">${text}</p><div class="kc-row" style="justify-content:flex-end"><button class="kc-btn" data-no>Отмена</button><button class="kc-btn kc-primary" data-ok>${esc(okLabel)}</button></div>`, (m, close) => {
      m.querySelector("[data-no]").onclick = () => { close(); resolve(false); };
      m.querySelector("[data-ok]").onclick = () => { close(); resolve(true); };
    });
  });
}

function downloadCsv(name, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function barChart(points, key = "revenue") {
  const max = Math.max(1, ...points.map((p) => p[key]));
  const step = Math.ceil(points.length / 8);
  return `<div class="kc-bars">${points.map((p) => `<div title="${esc(p.day)}: ${num(p[key])}" style="height:${Math.max(1, Math.round((p[key] / max) * 100))}%"></div>`).join("")}</div>
    <div class="kc-row kc-muted" style="justify-content:space-between;margin-top:4px">${points.filter((_, i) => i % step === 0).map((p) => `<span>${esc(p.day.slice(5))}</span>`).join("")}</div>`;
}

function mountApp(target, view) {
  const root = document.createElement("div");
  root.className = "kc";
  root.innerHTML = `<style>${STYLE}</style><div data-body class="kc-muted">Загрузка…</div>`;
  target.replaceChildren(root);
  const st = {
    root, disposed: false, meta: null, camp: null, editor: null, dirty: false, saving: false, saveTimer: 0,
    tab: view === "settings" ? "settings" : cache.tab, status: "",
  };
  const body = () => root.querySelector("[data-body]");

  const toast = (text, kind = "ok") => {
    const t = h(`<div class="kc-banner ${kind}" style="position:fixed;right:16px;bottom:16px;z-index:2147483001;max-width:380px">${esc(text)}</div>`);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4500);
  };
  const fail = (err) => toast(err.message || String(err), "bad");

  async function loadMeta() {
    if (!st.meta) st.meta = await api("/meta");
    return st.meta;
  }

  // ------------------------------------------------------------------ shell
  function shell(inner) {
    const tabs = view === "settings" ? [["settings", "Настройки"]] : [["campaigns", "Кампании"], ["analytics", "Аналитика"], ["settings", "Настройки"]];
    body().innerHTML = `<div class="kc-row"><h2 class="kc-grow">Кампании</h2><div class="kc-tabs">${tabs.map(([id, t]) => `<button class="kc-tab ${st.tab === id ? "on" : ""}" data-tab="${id}">${t}</button>`).join("")}</div></div><div data-main>${inner}</div>`;
    body().querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await leaveEditor())) return;
      st.tab = b.dataset.tab;
      cache.tab = st.tab;
      cache.cid = null;
      route();
    }));
  }

  async function leaveEditor() {
    if (st.editor && st.dirty) await saveNow();
    st.editor?.destroy();
    st.editor = null;
    st.camp = null;
    return true;
  }

  async function route() {
    if (st.disposed) return;
    try {
      await loadMeta();
      if (st.tab === "campaigns" && cache.cid) return await showCampaign(cache.cid);
      if (st.tab === "campaigns") return await showList();
      if (st.tab === "analytics") return await showAnalytics();
      return await showSettings();
    } catch (err) {
      body().innerHTML = `<div class="kc-msg">Ошибка: ${esc(err.message)}</div>`;
    }
  }

  // ------------------------------------------------------------------ list
  async function showList() {
    const data = await api("/campaigns");
    const meta = st.meta;
    shell(`${data.engine_enabled ? "" : `<div class="kc-banner warn">Движок рассылок <b>выключен</b>: кампании не запускаются и ничего не отправляется. Включите его во вкладке «Настройки», когда будете готовы.</div>`}
      <div class="kc-row"><button class="kc-btn kc-primary" data-new>+ Новая кампания</button>
        <select data-preset><option value="">Из готового сценария…</option>${meta.presets.map((p) => `<option value="${p.id}">${esc(p.title)}</option>`).join("")}</select>
        <span class="kc-muted">Конверсия считается за ${data.window_days} дн. после первого сообщения</span></div>
      <div class="kc-card kc-scroll">${data.campaigns.length ? `<table class="kc-table"><tr><th>Кампания</th><th>Статус</th><th>Триггер</th><th>В кампании</th><th>Отправлено</th><th>Оплатили</th><th>Конверсия</th><th>Выручка</th><th></th></tr>
        ${data.campaigns.map((c) => {
          const s = c.stats || {};
          const trig = (meta.catalog.nodes[c.trigger] || {}).title || "—";
          return `<tr><td><a href="#" data-open="${c.id}"><b>${esc(c.name)}</b></a><div class="kc-muted">v${c.live_version || 0} · блоков: ${c.nodes}</div></td><td>${statusBadge(c.status)}</td>
            <td>${esc(trig)}</td><td>${num(s.entered)}${s.active ? `<div class="kc-muted">идут: ${num(s.active)}</div>` : ""}</td><td>${num(s.sent)}</td><td>${num(s.converted)}</td><td>${pct(s.reached ? s.rate : null)}</td><td>${esc(money(s.revenue))}</td>
            <td class="kc-row">${c.status === "active" ? `<button class="kc-btn" data-act="pause" data-id="${c.id}">Пауза</button>` : ""}${c.status === "paused" ? `<button class="kc-btn" data-act="resume" data-id="${c.id}">Продолжить</button>` : ""}<button class="kc-btn" data-open="${c.id}">Открыть</button></td></tr>`;
        }).join("")}</table>` : `<p class="kc-muted" style="margin:0">Кампаний пока нет. Начните с готового сценария: он создастся выключенным, и вы сможете его изменить.</p>`}</div>`);
    const main = body();
    main.querySelector("[data-new]").onclick = async () => {
      try { const r = await api("/campaigns", "POST", {}); cache.cid = r.id; cache.sub = "editor"; route(); } catch (e) { fail(e); }
    };
    main.querySelector("[data-preset]").onchange = async (e) => {
      if (!e.target.value) return;
      try { const r = await api("/campaigns", "POST", { preset: e.target.value }); cache.cid = r.id; cache.sub = "editor"; route(); } catch (err) { fail(err); }
    };
    main.querySelectorAll("[data-open]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); cache.cid = Number(a.dataset.open); cache.sub = "editor"; route(); }));
    main.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
      try { await api(`/campaigns/${b.dataset.id}/${b.dataset.act}`, "POST", {}); route(); } catch (e) { fail(e); }
    }));
  }

  // ------------------------------------------------------------------ campaign
  async function showCampaign(id) {
    const { campaign } = await api(`/campaigns/${id}`);
    st.camp = campaign;
    st.dirty = false;
    const sub = cache.sub;
    const subs = [["editor", "Схема"], ["report", "Отчёт"], ["journal", "Журнал"], ["options", "Параметры"]];
    const c = campaign;
    const actions = {
      draft: `<button class="kc-btn kc-primary" data-run="start">Запустить</button>`,
      finished: `<button class="kc-btn kc-primary" data-run="start">Запустить заново</button>`,
      active: `<button class="kc-btn" data-run="pause">Пауза</button><button class="kc-btn kc-danger" data-run="stop">Остановить</button>`,
      paused: `<button class="kc-btn kc-primary" data-run="resume">Продолжить</button><button class="kc-btn kc-danger" data-run="stop">Остановить</button>`,
      archived: `<button class="kc-btn" data-run="restore">Вернуть из архива</button>`,
    }[c.status] || "";
    shell(`<div class="kc-card"><div class="kc-row"><button class="kc-btn" data-back>← К списку</button>
        <input type="text" data-name maxlength="120" value="${esc(c.name)}" style="flex:1;min-width:200px;font-weight:600">
        ${statusBadge(c.status)}<span class="kc-muted">опубликована v${c.live_version || 0}${c.unpublished ? " · <b style=\"color:#f59e0b\">есть неопубликованные правки</b>" : ""}</span>
        <span class="kc-grow"></span>${actions}</div></div>
      <div class="kc-tabs">${subs.map(([s, t]) => `<button class="kc-tab ${sub === s ? "on" : ""}" data-sub="${s}">${t}</button>`).join("")}</div>
      <div data-panel></div>`);
    const main = body();
    main.querySelector("[data-back]").onclick = async () => { if (await leaveEditor()) { cache.cid = null; route(); } };
    main.querySelector("[data-name]").addEventListener("input", () => { st.dirty = true; scheduleSave(); });
    main.querySelectorAll("[data-sub]").forEach((b) => b.addEventListener("click", async () => {
      if (st.dirty) await saveNow();
      cache.sub = b.dataset.sub;
      showCampaign(id);
    }));
    main.querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", () => runAction(b.dataset.run, b)));
    const panel = main.querySelector("[data-panel]");
    st.editor?.destroy();
    st.editor = null;
    if (sub === "editor") renderEditor(panel);
    else if (sub === "report") await renderReport(panel);
    else if (sub === "journal") await renderJournal(panel);
    else renderOptions(panel);
  }

  function scheduleSave() {
    st.status = "Изменено…";
    paintStatus();
    clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(() => saveNow().catch(fail), 1800);
  }

  function paintStatus() {
    const el = body().querySelector("[data-save-status]");
    if (el) el.textContent = st.status;
  }

  async function saveNow() {
    if (!st.camp || st.saving) return;
    clearTimeout(st.saveTimer);
    st.saving = true;
    try {
      const nameEl = body().querySelector("[data-name]");
      const payload = { name: nameEl ? nameEl.value : st.camp.name, options: st.camp.options };
      if (st.editor) payload.graph = st.editor.getGraph();
      const res = await api(`/campaigns/${st.camp.id}`, "PUT", payload);
      st.camp.name = payload.name;
      if (payload.graph) st.camp.graph = payload.graph;
      st.dirty = false;
      st.status = "Сохранено ✓";
      st.editor?.setIssues(res.issues);
      renderIssues(res.issues);
    } finally {
      st.saving = false;
      paintStatus();
    }
  }

  function renderIssues(issues) {
    const box = body().querySelector("[data-issues]");
    if (!box) return;
    const errors = issues.filter((i) => i.level === "error");
    const warns = issues.filter((i) => i.level !== "error");
    box.innerHTML = issues.length
      ? `<div class="ke-issues">${errors.map((i) => `<div class="e">● ${esc(i.message)}</div>`).join("")}${warns.map((i) => `<div class="w">○ ${esc(i.message)}</div>`).join("")}</div>`
      : `<div class="kc-banner ok">Схема в порядке, ошибок нет.</div>`;
  }

  function renderEditor(panel) {
    panel.innerHTML = `<div class="ke-tools" style="margin-bottom:8px">
        <button class="kc-btn" data-undo title="Ctrl+Z">↶</button><button class="kc-btn" data-redo title="Ctrl+Y">↷</button>
        <button class="kc-btn" data-save>Сохранить</button><button class="kc-btn kc-primary" data-publish>Опубликовать</button>
        <span class="kc-muted" data-save-status></span><span class="kc-grow"></span>
        <button class="kc-btn" data-dry>Сколько людей войдёт</button><button class="kc-btn" data-sim>Проверить на пользователе</button><button class="kc-btn" data-counters>Показать цифры</button></div>
      <div data-ed></div><div data-issues style="margin-top:10px"></div>`;
    const editor = new Editor({
      meta: st.meta,
      graph: st.camp.graph,
      onChange: () => { st.dirty = true; scheduleSave(); },
      onTest: async (nodeId, btn) => {
        btn.disabled = true;
        try { await api(`/campaigns/${st.camp.id}/test`, "POST", { node_id: nodeId, graph: editor.getGraph() }); toast("Тестовое сообщение отправлено вам в Telegram"); }
        catch (err) { fail(err); }
        btn.disabled = false;
      },
    });
    st.editor = editor;
    editor.mount(panel.querySelector("[data-ed]"));
    editor.setIssues(st.camp.issues);
    renderIssues(st.camp.issues);
    panel.querySelector("[data-undo]").onclick = () => editor.undo();
    panel.querySelector("[data-redo]").onclick = () => editor.redo();
    panel.querySelector("[data-save]").onclick = () => saveNow().then(() => toast("Сохранено")).catch(fail);
    panel.querySelector("[data-publish]").onclick = publish;
    panel.querySelector("[data-dry]").onclick = dryRun;
    panel.querySelector("[data-sim]").onclick = simulate;
    panel.querySelector("[data-counters]").onclick = async (e) => {
      try {
        const { report } = await api(`/campaigns/${st.camp.id}/report`);
        const map = {};
        for (const [id, v] of Object.entries(report.nodes)) map[id] = { visit: v.visit, sent: v.sent, payments: v.payments };
        editor.setCounters(map);
        e.target.textContent = "Цифры обновлены";
      } catch (err) { fail(err); }
    };
  }

  async function publish() {
    try {
      await saveNow();
      const res = await api(`/campaigns/${st.camp.id}/publish`, "POST", {});
      toast(`Опубликована версия ${res.version}`);
      showCampaign(st.camp.id);
    } catch (err) {
      if (err.data?.issues) { st.editor?.setIssues(err.data.issues); renderIssues(err.data.issues); }
      fail(err);
    }
  }

  async function dryRun() {
    try {
      const r = await api(`/campaigns/${st.camp.id}/dry-run`, "POST", { graph: st.editor.getGraph() });
      modal(`<h3>Кто войдёт сейчас</h3><p>Подходит под условия триггера: <b>${num(r.count)}</b> чел.${r.scheduled ? " (по расписанию число меняется)" : ""}.</p><p class="kc-muted">Примеры ID: ${r.sample.join(", ") || "—"}. Лимиты и тихие часы применяются при отправке.</p><div class="kc-row" style="justify-content:flex-end"><button class="kc-btn kc-primary" data-ok>Понятно</button></div>`, (m, close) => (m.querySelector("[data-ok]").onclick = close));
    } catch (err) { fail(err); }
  }

  function simulate() {
    modal(`<h3>Проверка на пользователе</h3><p class="kc-muted">Схема пройдёт для выбранного человека без отправки сообщений и ожиданий. Подсветится путь.</p>
      <input type="text" data-u placeholder="ID, Telegram ID или @username" style="width:100%"><div data-res style="margin-top:10px"></div>
      <div class="kc-row" style="justify-content:flex-end;margin-top:12px"><button class="kc-btn" data-close>Закрыть</button><button class="kc-btn kc-primary" data-go>Проверить</button></div>`, (m, close) => {
      m.querySelector("[data-close]").onclick = () => { close(); };
      m.querySelector("[data-go]").onclick = async () => {
        try {
          const r = await api(`/campaigns/${st.camp.id}/simulate`, "POST", { user: m.querySelector("[data-u]").value, graph: st.editor.getGraph() });
          st.editor.setPath(r.path);
          const nodes = st.editor.graph.nodes;
          m.querySelector("[data-res]").innerHTML = r.path.map((p) => { const n = nodes.find((x) => x.id === p.node_id); return `<div>→ ${esc(n ? n.label || st.meta.catalog.nodes[n.type].title : p.node_id)} <span class="kc-muted">${esc(p.result)}</span></div>`; }).join("");
        } catch (err) { m.querySelector("[data-res]").innerHTML = `<div class="kc-msg">${esc(err.message)}</div>`; }
      };
    });
  }

  async function runAction(action, btn) {
    try {
      if (st.dirty) await saveNow();
      if (action === "start") {
        if (st.camp.unpublished && !(await confirmBox("Есть неопубликованные правки: запустится последняя опубликованная версия. Продолжить?"))) return;
        const live = st.camp.live_graph || st.camp.graph;
        const r = await api(`/campaigns/${st.camp.id}/dry-run`, "POST", { graph: live });
        const ok = await confirmBox(`В кампанию сейчас подходит <b>${num(r.count)}</b> чел. После запуска сообщения начнут уходить с учётом лимитов и тихих часов. Запустить?`, "Запустить");
        if (!ok) return;
      }
      if (action === "stop" && !(await confirmBox("Остановить кампанию? Все ожидающие участники будут исключены, это нельзя отменить."))) return;
      btn.disabled = true;
      const res = await api(`/campaigns/${st.camp.id}/${action}`, "POST", {});
      if (action === "start" && !res.engine_enabled) toast("Кампания запущена, но движок выключен — включите его в «Настройках»", "warn");
      showCampaign(st.camp.id);
    } catch (err) {
      fail(err);
      btn.disabled = false;
    }
  }

  async function renderReport(panel) {
    const win = cache.window || null;
    const { report } = await api(`/campaigns/${st.camp.id}/report${win ? `?window=${win}` : ""}`);
    const r = report;
    const nodes = st.camp.graph.nodes;
    const title = (id) => { const n = nodes.find((x) => x.id === id); return n ? n.label || st.meta.catalog.nodes[n.type].title : id; };
    const rows = Object.entries(r.nodes).map(([id, v]) => `<tr><td>${esc(title(id))}</td><td>${num(v.visit)}</td><td>${num(v.sent)}</td><td>${num(v.failed)}</td><td>${num(v.skipped)}</td><td>${num(v.payments)}</td><td>${esc(money(v.revenue))}</td></tr>`).join("");
    panel.innerHTML = `<div class="kc-row"><label class="kc-row" style="gap:6px">Окно привязки оплат, дней <input type="number" min="1" max="90" value="${r.window_days}" data-win style="width:80px"></label><span class="kc-muted">Оплата считается, если произошла в течение окна после первого сообщения (для контроля — после входа в кампанию).</span></div>
      <div class="kc-grid">
        <div class="kc-stat"><span class="kc-muted">Вошли в кампанию</span><b>${num(r.funnel.entered)}</b><span class="kc-muted">идут сейчас: ${num(r.funnel.active)}</span></div>
        <div class="kc-stat"><span class="kc-muted">Сообщений отправлено</span><b>${num(r.delivery.sent)}</b><span class="kc-muted">ошибок: ${num(r.delivery.failed)} · пропущено: ${num(r.delivery.skipped)}</span></div>
        <div class="kc-stat"><span class="kc-muted">Получили и оплатили</span><b>${num(r.treated.converted)} из ${num(r.treated.n)}</b><span class="kc-muted">конверсия ${pct(r.treated.rate)}</span></div>
        <div class="kc-stat"><span class="kc-muted">Выручка группы</span><b style="font-size:16px">${esc(money(r.treated.revenue))}</b><span class="kc-muted">на человека: ${esc(money(r.treated.arpu))}</span></div></div>
      <div class="kc-card"><h3>Что принесла рассылка</h3>
        ${r.control.n ? `<div class="kc-grid" style="margin-top:10px">
          <div class="kc-stat"><span class="kc-muted">Получили</span><b>${pct(r.treated.rate)}</b><span class="kc-muted">${num(r.treated.n)} чел.</span></div>
          <div class="kc-stat"><span class="kc-muted">Контрольная группа</span><b>${pct(r.control.rate)}</b><span class="kc-muted">${num(r.control.n)} чел., сообщений не получали</span></div>
          <div class="kc-stat"><span class="kc-muted">Прирост конверсии</span><b style="color:${r.uplift_pp > 0 ? "#22c55e" : r.uplift_pp < 0 ? "#e5484d" : "inherit"}">${r.uplift_pp === null ? "—" : (r.uplift_pp > 0 ? "+" : "") + r.uplift_pp + " п.п."}</b><span class="kc-muted">разница получивших и контроля</span></div></div>
          ${r.control.n < 30 ? `<p class="kc-muted">Контрольная группа маленькая (${r.control.n}): вывод пока ненадёжен.</p>` : ""}`
        : `<p class="kc-muted" style="margin:6px 0 0">Контрольной группы нет. Добавьте блок «Случайное деление» с контролем, чтобы отличать эффект рассылки от оплат, которые произошли бы и так.</p>`}
        ${r.promo.issued ? `<p style="margin-bottom:0">Промокоды: выдано <b>${num(r.promo.issued)}</b>, активировано <b>${num(r.promo.activated)}</b>, оплат с кодом <b>${num(r.promo.payments)}</b> на ${esc(money(r.promo.revenue))}.</p>` : ""}
        ${Object.keys(r.goals).length ? `<p style="margin-bottom:0">Цели: ${Object.entries(r.goals).map(([n, c]) => `${esc(n || "—")}: <b>${num(c)}</b>`).join(" · ")}</p>` : ""}</div>
      <div class="kc-card kc-scroll"><h3>По блокам</h3><table class="kc-table"><tr><th>Блок</th><th>Дошли</th><th>Отправлено</th><th>Ошибки</th><th>Пропущено</th><th>Оплат после</th><th>Выручка</th></tr>${rows || `<tr><td colspan="7" class="kc-muted">Данных пока нет</td></tr>`}</table>
        <p class="kc-muted" style="margin-bottom:0">«Оплат после» — оплаты, где это сообщение было последним перед платежом.</p></div>`;
    panel.querySelector("[data-win]").onchange = (e) => { cache.window = Math.max(1, Math.min(90, Number(e.target.value) || 7)); renderReport(panel).catch(fail); };
  }

  async function renderJournal(panel, offset = 0) {
    const kind = panel.querySelector("[data-kind]")?.value || "";
    const user = panel.querySelector("[data-user]")?.value || "";
    const { events } = await api(`/campaigns/${st.camp.id}/journal?limit=50&offset=${offset}&kind=${encodeURIComponent(kind)}&user=${encodeURIComponent(user)}`);
    const KIND = { sent: "Отправлено", failed: "Ошибка", skipped: "Пропущено", promo: "Промокод", goal: "Цель", exit: "Выход", holdout: "Контроль" };
    panel.innerHTML = `<div class="kc-row"><select data-kind><option value="">Все события</option>${Object.entries(KIND).map(([k, t]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${t}</option>`).join("")}</select>
        <input type="text" data-user placeholder="ID пользователя" value="${esc(user)}" style="width:150px"><button class="kc-btn" data-go>Найти</button>
        <span class="kc-grow"></span><input type="text" data-ex placeholder="Исключить: ID или @username" style="width:220px"><button class="kc-btn kc-danger" data-exclude>Исключить из кампании</button></div>
      <div class="kc-card kc-scroll"><table class="kc-table"><tr><th>Когда</th><th>Пользователь</th><th>Событие</th><th>Блок</th><th>Детали</th></tr>
      ${events.map((e) => `<tr><td>${fmtDate(e.created_at)}</td><td>${e.user_id}${e.username ? ` <span class="kc-muted">@${esc(e.username)}</span>` : ""}</td><td>${esc(KIND[e.kind] || e.kind)}</td><td>${esc(e.node_id || "")}</td><td class="kc-muted">${esc(e.detail ? JSON.stringify(e.detail) : "")}</td></tr>`).join("") || `<tr><td colspan="5" class="kc-muted">Событий нет</td></tr>`}</table>
      <div class="kc-row" style="margin-top:8px"><button class="kc-btn" data-prev ${offset ? "" : "disabled"}>← Новее</button><button class="kc-btn" data-next ${events.length === 50 ? "" : "disabled"}>Старше →</button></div></div>`;
    panel.querySelector("[data-go]").onclick = () => renderJournal(panel, 0).catch(fail);
    panel.querySelector("[data-prev]").onclick = () => renderJournal(panel, Math.max(0, offset - 50)).catch(fail);
    panel.querySelector("[data-next]").onclick = () => renderJournal(panel, offset + 50).catch(fail);
    panel.querySelector("[data-exclude]").onclick = async () => {
      try { const r = await api(`/campaigns/${st.camp.id}/exclude`, "POST", { user: panel.querySelector("[data-ex]").value }); toast(`Исключено записей: ${r.removed}`); } catch (e) { fail(e); }
    };
  }

  function renderOptions(panel) {
    const c = st.camp;
    panel.innerHTML = `<div class="kc-card"><h3>Параметры кампании</h3>
      <label class="f chk" style="margin:12px 0"><input type="checkbox" data-exit ${c.options.exit_on_payment !== false ? "checked" : ""}> Исключать из кампании после оплаты (для триггеров про окончание подписки, регистрацию и неактивность)</label>
      <p class="kc-muted">Лимиты, тихие часы и частота общие для всех кампаний и задаются во вкладке «Настройки».</p>
      <div class="kc-row"><button class="kc-btn" data-dup>Сделать копию</button>${["draft", "finished", "paused"].includes(c.status) ? `<button class="kc-btn" data-arch>В архив</button>` : ""}${["draft", "archived"].includes(c.status) ? `<button class="kc-btn kc-danger" data-del>Удалить</button>` : ""}</div></div>`;
    panel.querySelector("[data-exit]").onchange = (e) => { c.options.exit_on_payment = e.target.checked; st.dirty = true; scheduleSave(); };
    panel.querySelector("[data-dup]").onclick = async () => { try { const r = await api(`/campaigns/${c.id}/duplicate`, "POST", {}); cache.cid = r.id; cache.sub = "editor"; route(); } catch (e) { fail(e); } };
    panel.querySelector("[data-arch]")?.addEventListener("click", async () => { try { await api(`/campaigns/${c.id}/archive`, "POST", {}); cache.cid = null; route(); } catch (e) { fail(e); } });
    panel.querySelector("[data-del]")?.addEventListener("click", async () => {
      if (!(await confirmBox("Удалить кампанию вместе с её журналом? Это нельзя отменить."))) return;
      try { await api(`/campaigns/${c.id}`, "DELETE"); cache.cid = null; route(); } catch (e) { fail(e); }
    });
  }

  // ------------------------------------------------------------------ analytics
  async function showAnalytics() {
    const days = cache.days || 30;
    const { analytics: a } = await api(`/analytics?days=${days}`);
    const cur = cache.cur && a.currencies.includes(cache.cur) ? cache.cur : a.currencies[0];
    const t = (cur && a.totals[cur]) || { revenue: 0, payments: 0, payers: 0, avg_check: 0 };
    const share = (cur && a.campaign_share[cur]) || { revenue: 0, share: 0 };
    shell(`<div class="kc-row"><div class="kc-tabs">${[7, 30, 90].map((d) => `<button class="kc-tab ${d === days ? "on" : ""}" data-days="${d}">${d} дн.</button>`).join("")}</div>
        ${a.currencies.length > 1 ? `<select data-cur>${a.currencies.map((c) => `<option ${c === cur ? "selected" : ""}>${c}</option>`).join("")}</select>` : ""}
        <span class="kc-grow"></span><button class="kc-btn" data-csv>Скачать CSV</button></div>
      ${a.currencies.length ? `<div class="kc-grid">
        <div class="kc-stat"><span class="kc-muted">Выручка (${esc(cur)})</span><b>${num(t.revenue)} ${CUR[cur] || cur}</b><span class="kc-muted">оплат: ${num(t.payments)}</span></div>
        <div class="kc-stat"><span class="kc-muted">Средний чек</span><b>${num(t.avg_check)} ${CUR[cur] || cur}</b></div>
        <div class="kc-stat"><span class="kc-muted">Платящих клиентов</span><b>${num(a.payers.all)}</b><span class="kc-muted">новых ${num(a.payers.new)} · повторных ${num(a.payers.repeat)}</span></div>
        <div class="kc-stat"><span class="kc-muted">Пробный → оплата</span><b>${pct(a.trial.rate)}</b><span class="kc-muted">${num(a.trial.paid)} из ${num(a.trial.started)}</span></div>
        <div class="kc-stat"><span class="kc-muted">Не продлили за период</span><b>${num(a.subscriptions.lost)}</b><span class="kc-muted">активных сейчас: ${num(a.subscriptions.active)}</span></div>
        <div class="kc-stat"><span class="kc-muted">Доля выручки после рассылок</span><b>${pct(share.share)}</b><span class="kc-muted">${num(share.revenue)} ${CUR[cur] || cur}</span></div></div>
      <div class="kc-card"><h3>Выручка по дням, ${esc(cur)}</h3>${barChart(a.series[cur] || [])}</div>
      <div class="kc-card kc-scroll"><h3>По тарифам</h3><table class="kc-table"><tr><th>Тариф</th><th>Валюта</th><th>Оплат</th><th>Выручка</th></tr>${a.tariffs.map((x) => `<tr><td>${esc(x.tariff)}</td><td>${esc(x.currency)}</td><td>${num(x.payments)}</td><td>${num(x.revenue)}</td></tr>`).join("")}</table></div>
      <p class="kc-muted">В выручку входят успешные оплаты внешними платёжными системами (без оплат с внутреннего баланса). «Доля после рассылок» — оплаты, которым в течение окна привязки предшествовало сообщение какой-либо кампании.</p>`
      : `<div class="kc-card kc-muted">За выбранный период успешных оплат нет.</div>`}`);
    const main = body();
    main.querySelectorAll("[data-days]").forEach((b) => b.addEventListener("click", () => { cache.days = Number(b.dataset.days); showAnalytics().catch(fail); }));
    main.querySelector("[data-cur]")?.addEventListener("change", (e) => { cache.cur = e.target.value; showAnalytics().catch(fail); });
    main.querySelector("[data-csv]").onclick = () => {
      const rows = [["Дата", "Валюта", "Выручка", "Оплат"]];
      for (const c of a.currencies) for (const p of a.series[c]) rows.push([p.day, c, p.revenue, p.payments]);
      downloadCsv(`kiro-analytics-${days}d.csv`, rows);
    };
  }

  // ------------------------------------------------------------------ settings
  async function showSettings() {
    const { settings: s } = await api("/settings");
    const num_ = (k, label, min, max, hint = "") => `<label class="f">${label}<input type="number" min="${min}" max="${max}" name="${k}" value="${esc(s[k])}">${hint ? `<span class="kc-muted">${hint}</span>` : ""}</label>`;
    const chk = (k, label) => `<label class="f chk"><input type="checkbox" name="${k}" ${s[k] ? "checked" : ""}> ${label}</label>`;
    shell(`<div class="kc-banner ${s.engine_enabled ? "ok" : "warn"}">Движок рассылок: <b>${s.engine_enabled ? "включён" : "выключен"}</b>. ${s.engine_enabled ? "Активные кампании находят участников и отправляют сообщения раз в минуту." : "Пока он выключен, ничего не отправляется, даже если кампании запущены."}</div>
      <div class="kc-card"><form data-form class="kc-form">
        ${chk("engine_enabled", "<b>Движок включён</b> (главный выключатель)")}
        ${chk("respect_marketing_preference", "Учитывать согласие пользователя на маркетинговые сообщения")}
        ${chk("quiet_enabled", "Тихие часы")}
        ${num_("tz_offset_hours", "Часовой пояс: смещение от UTC, ч", -12, 14, "Москва = 3")}
        ${num_("quiet_from", "Тихие часы: с (час)", 0, 23)}
        ${num_("quiet_to", "Тихие часы: до (час)", 0, 23)}
        ${num_("daily_cap", "Сообщений на человека в сутки", 0, 20, "Во всех кампаниях вместе. 0 = без ограничения")}
        ${num_("min_gap_hours", "Минимум часов между сообщениями", 0, 720)}
        ${num_("rate_per_second", "Скорость отправки, сообщений в секунду", 1, 28, "Telegram разрешает около 30")}
        ${num_("cooldown_days", "Повторный вход в кампанию не раньше чем через, дн.", 0, 365)}
        ${num_("attribution_days", "Окно привязки оплат, дн.", 1, 90)}
        ${num_("max_defer_hours", "Откладывать сообщение не дольше, ч", 1, 720, "Потом оно пропускается")}
      </form><div class="kc-row" style="margin-top:12px"><button class="kc-btn kc-primary" data-save>Сохранить</button><button class="kc-btn" data-tick>Выполнить такт сейчас</button><span class="kc-muted" data-res></span></div></div>`);
    const main = body();
    main.querySelector("[data-save]").onclick = async (e) => {
      const form = main.querySelector("[data-form]");
      const payload = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        payload[el.name] = el.type === "checkbox" ? el.checked : Number(el.value);
      }
      if (payload.engine_enabled && !s.engine_enabled && !(await confirmBox("Включить движок? Запущенные кампании начнут отправлять сообщения пользователям."))) return;
      e.target.disabled = true;
      try { await api("/settings", "PUT", payload); toast("Настройки сохранены"); showSettings().catch(fail); } catch (err) { fail(err); e.target.disabled = false; }
    };
    main.querySelector("[data-tick]").onclick = async (e) => {
      e.target.disabled = true;
      try { const r = await api("/engine/tick", "POST", {}); main.querySelector("[data-res]").textContent = `Вошло: ${r.stats.entered}, обработано: ${r.stats.processed}, отправлено: ${r.stats.sent}`; } catch (err) { fail(err); }
      e.target.disabled = false;
    };
  }

  route();
  return st;
}

export function mountView(view, target) {
  return mountApp(target, view);
}

export function updateView() {
  // Admin shell props (language, feature flags) must not re-mount the editor and wipe unsaved changes.
}

export function unmountView(instance) {
  if (!instance) return;
  instance.disposed = true;
  clearTimeout(instance.saveTimer);
  instance.editor?.destroy();
  instance.root.remove();
}
