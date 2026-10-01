// KIRO campaigns: admin application (frontend host API v1).
// One module: list of campaigns, a visual graph editor, reports, journal, analytics and settings.
const API = "/api/admin/kiro-campaigns";

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ERRORS = {
  forbidden: "Нет прав администратора",
  csrf_failed: "Сессия устарела, обновите страницу",
  not_found: "Не найдено",
  graph_invalid: "В кампании есть ошибки — исправьте их перед публикацией",
  not_published: "Сначала опубликуйте кампанию",
  bad_state: "Действие недоступно в текущем состоянии кампании",
  user_not_found: "Пользователь не найден",
  user_required: "Укажите пользователя",
  too_many_nodes: "Слишком много блоков",
  invalid_image: "Не удалось прочитать картинку",
  image_too_large: "Картинка больше 1 МБ",
  unsupported_image: "Нужен JPEG или PNG",
  test_failed: "Не удалось отправить тест",
  admin_telegram_unavailable: "Не найден ваш Telegram-аккаунт",
  node_not_found: "Блок не найден",
  not_ready: "Плагин ещё запускается, повторите через минуту",
};

const STATUS = {
  draft: ["Черновик", "#8b93a3"],
  active: ["Работает", "#22c55e"],
  paused: ["Пауза", "#f59e0b"],
  finished: ["Завершена", "#6366f1"],
  archived: ["В архиве", "#6b7280"],
};

const GROUP_COLOR = { trigger: "#f59e0b", condition: "#3b82f6", action: "#22c55e", flow: "#a855f7" };
const PORT_LABEL = { out: "", yes: "Да", no: "Нет", a: "A", b: "B" };
const CUR = { RUB: "₽", USD: "$", EUR: "€", XTR: "⭐", USDT: "USDT" };
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const UNIT_RU = { minutes: "мин.", hours: "ч", days: "дн." };

function csrf() {
  const m = document.cookie.match(/(?:^|;\s*)rw_webapp_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function api(path, method = "GET", body) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-CSRF-Token"] = csrf();
  const res = await fetch(API + path, {
    method,
    credentials: "same-origin",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(ERRORS[data.error] || data.detail || data.error || `HTTP ${res.status}`);
    err.code = data.error;
    err.data = data;
    throw err;
  }
  return data;
}

const money = (map) => {
  const parts = Object.entries(map || {})
    .filter(([, v]) => v)
    .map(([c, v]) => `${Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${CUR[c] || c}`);
  return parts.length ? parts.join(" · ") : "—";
};
const pct = (v) => (v === null || v === undefined ? "—" : `${Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`);
const num = (v) => Number(v || 0).toLocaleString("ru-RU");
const fmtDate = (s) => {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const STYLE = `
.kc{display:flex;flex-direction:column;gap:14px;color:var(--text);font-size:14px;min-width:0}
.kc *{box-sizing:border-box}
.kc h2,.kc h3,.kc h4{margin:0}
.kc-card{border:1px solid var(--border);border-radius:var(--radius-card,var(--radius,12px));padding:14px;background:var(--panel,var(--bg,transparent));min-width:0}
.kc-muted{color:var(--muted);font-size:12.5px}
.kc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.kc-grow{flex:1}
.kc-btn{border:1px solid var(--border);background:transparent;color:var(--text);border-radius:8px;padding:7px 12px;cursor:pointer;font:inherit;white-space:nowrap}
.kc-btn:hover{border-color:var(--accent)}
.kc-btn[disabled]{opacity:.5;cursor:default}
.kc-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-contrast,#fff)}
.kc-danger{color:#e5484d}
.kc-tabs{display:flex;gap:6px;flex-wrap:wrap}
.kc-tab{border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:999px;padding:6px 14px;cursor:pointer;font:inherit}
.kc-tab.on{color:var(--text);border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent)}
.kc input,.kc select,.kc textarea{font:inherit;color:var(--text);background-color:var(--panel-2,var(--panel,#1f2430));border:1px solid var(--border);
  border-radius:var(--radius-control,8px);padding:7px 9px;color-scheme:inherit;min-width:0;max-width:100%}
.kc select option{background-color:var(--panel-2,var(--panel,#1f2430));color:var(--text)}
.kc input[type=checkbox]{accent-color:var(--accent);width:auto}
.kc textarea{resize:vertical;min-height:90px;width:100%}
.kc label.f{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:12px}
.kc label.f.chk{flex-direction:row;align-items:center;gap:8px;color:var(--text);font-size:13.5px}
.kc-table{width:100%;border-collapse:collapse}
.kc-table th,.kc-table td{padding:8px 6px;border-bottom:1px solid var(--border);text-align:left;vertical-align:middle}
.kc-table th{color:var(--muted);font-weight:500;font-size:12px}
.kc-scroll{overflow-x:auto}
.kc-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;border:1px solid currentColor}
.kc-banner{padding:10px 12px;border-radius:10px;border:1px solid;font-size:13px}
.kc-banner.warn{border-color:#f59e0b;background:rgba(245,158,11,.1)}
.kc-banner.ok{border-color:#22c55e;background:rgba(34,197,94,.08)}
.kc-banner.bad{border-color:#e5484d;background:rgba(229,72,77,.08)}
.kc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.kc-stat{border:1px solid var(--border);border-radius:10px;padding:10px 12px}
.kc-stat b{display:block;font-size:20px;margin-top:2px}
.kc-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px 14px}
.kc-msg{padding:8px 12px;border-radius:8px;background:rgba(229,72,77,.12);color:#e5484d}
.kc-modal{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px}
.kc-modal>div{background:var(--panel,#1b1f2a);color:var(--text);border:1px solid var(--border);border-radius:14px;padding:18px;max-width:520px;width:100%;max-height:90vh;overflow:auto}
/* ---- editor */
.ke{display:grid;grid-template-columns:200px minmax(0,1fr) 320px;gap:10px;height:calc(100vh - 250px);min-height:520px}
.ke-pal,.ke-insp{border:1px solid var(--border);border-radius:12px;padding:10px;overflow:auto;background:var(--panel,transparent)}
.ke-pal h4{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:10px 0 6px}
.ke-pal h4:first-child{margin-top:0}
.ke-pal button{display:flex;gap:8px;align-items:center;width:100%;text-align:left;border:1px solid var(--border);background:transparent;color:var(--text);
  border-radius:8px;padding:7px 9px;margin-bottom:5px;cursor:pointer;font:inherit;font-size:13px}
.ke-pal button:hover{border-color:var(--accent)}
.ke-pal button[disabled]{opacity:.4;cursor:default}
.ke-cv{position:relative;border:1px solid var(--border);border-radius:12px;overflow:hidden;outline:none;touch-action:none;cursor:grab;
  background-color:var(--panel-2,#161a22);background-image:radial-gradient(rgba(127,127,127,.25) 1px,transparent 1px);background-size:22px 22px}
.ke-cv.pan{cursor:grabbing}
.ke-world{position:absolute;left:0;top:0;transform-origin:0 0}
.ke-edges{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}
.ke-edges path{fill:none;stroke:#7b8497;stroke-width:2}
.ke-edges path.hit{stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer}
.ke-edges path.sel{stroke:var(--accent)}
.ke-edges path.live{stroke:var(--accent);stroke-dasharray:5 4}
.ke-edges text{fill:var(--muted);font-size:11px}
.ke-node{position:absolute;width:220px;height:78px;border:1px solid var(--border);border-radius:12px;background:var(--panel,#1c212b);box-shadow:0 2px 8px rgba(0,0,0,.25);user-select:none;cursor:default}
.ke-node.sel{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 35%,transparent)}
.ke-node.err{border-color:#e5484d}
.ke-node.warn{border-style:dashed}
.ke-nh{display:flex;align-items:center;gap:7px;padding:7px 10px;border-radius:11px 11px 0 0;cursor:grab;font-weight:600;font-size:13px;border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden}
.ke-nh i{font-style:normal}
.ke-nb{padding:6px 10px;font-size:12px;color:var(--muted);line-height:1.35;overflow:hidden;height:36px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ke-port{position:absolute;width:14px;height:14px;border-radius:50%;background:var(--panel,#1c212b);border:2px solid #7b8497;cursor:crosshair}
.ke-port:hover,.ke-port.on{border-color:var(--accent);background:var(--accent)}
.ke-port.in{left:-8px;top:32px}
.ke-port.out{right:-8px}
.ke-plab{position:absolute;right:10px;font-size:10.5px;color:var(--muted);pointer-events:none}
.ke-badge{position:absolute;left:8px;bottom:-9px;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--accent);color:var(--accent-contrast,#fff);white-space:nowrap}
.ke-insp h3{font-size:14px;margin-bottom:8px}
.ke-insp .fld{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;color:var(--muted);font-size:12px}
.ke-insp .fld.chk{flex-direction:row;align-items:center;gap:8px;color:var(--text);font-size:13px}
.ke-insp input[type=text],.ke-insp input[type=number],.ke-insp input[type=time],.ke-insp input[type=datetime-local],.ke-insp select,.ke-insp textarea{width:100%}
.ke-insp .help{color:var(--muted);font-size:12px;line-height:1.4;margin-bottom:10px}
.ke-sub{border:1px dashed var(--border);border-radius:8px;padding:8px;margin-bottom:10px}
.ke-lang{display:flex;gap:4px;margin-bottom:6px}
.ke-lang button{border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:6px;padding:2px 9px;cursor:pointer;font:inherit;font-size:12px}
.ke-lang button.on{color:var(--text);border-color:var(--accent)}
.ke-issues{border:1px solid var(--border);border-radius:10px;padding:8px 12px;font-size:13px}
.ke-issues div{margin:3px 0}
.ke-issues .e{color:#e5484d}.ke-issues .w{color:#f59e0b}
.ke-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ke-zoom{position:absolute;right:10px;bottom:10px;display:flex;gap:4px;z-index:3}
.ke-zoom button{width:30px;height:30px;border:1px solid var(--border);background:var(--panel,#1c212b);color:var(--text);border-radius:8px;cursor:pointer}
.ke-path{outline:2px solid #f59e0b;outline-offset:2px}
@media (max-width:1100px){.ke{grid-template-columns:1fr;height:auto}.ke-cv{height:60vh}.ke-pal{display:flex;flex-wrap:wrap;gap:6px}.ke-pal h4{width:100%}.ke-pal button{width:auto}}
.kc-bars{display:flex;align-items:flex-end;gap:2px;height:140px}
.kc-bars div{flex:1;background:var(--accent);min-height:1px;border-radius:3px 3px 0 0;opacity:.85}
`;

// ---------------------------------------------------------------------------------------------
// Visual graph editor
// ---------------------------------------------------------------------------------------------
const NODE_W = 220;
const NODE_H = 78;

const clone = (v) => JSON.parse(JSON.stringify(v));

function portY(count, index) {
  if (count <= 1) return 39;
  return [26, 56][index] ?? 39 + index * 22;
}

function summary(node, meta) {
  const p = node.params || {};
  const filterCount = (f) => Object.keys(f || {}).length;
  const aud = (f) => (filterCount(f) ? ` · фильтров: ${filterCount(f)}` : "");
  switch (node.type) {
    case "trg_sub_ends": return `За ${p.days} дн. до окончания${aud(p.audience)}`;
    case "trg_sub_expired": return `Через ${p.days} дн. после окончания${aud(p.audience)}`;
    case "trg_registered": return `Через ${p.hours} ч после регистрации${p.only_no_payment ? ", без оплат" : ""}${aud(p.audience)}`;
    case "trg_paid": return `После оплаты${aud(p.audience)}`;
    case "trg_inactive": return `Нет подключений ${p.days} дн.${aud(p.audience)}`;
    case "trg_broadcast": {
      const when = { now: "сразу после запуска", at: `в ${p.at || "—"}`, daily: `каждый день в ${p.time}`, weekly: `${(p.weekdays || []).map((d) => WEEKDAYS[d]).join(", ")} в ${p.time}` }[p.mode];
      return `${when}${aud(p.audience)}`;
    }
    case "if_paid": return p.since === "last_message" ? "С последнего сообщения" : "С момента входа в кампанию";
    case "if_sub": return "Есть активная подписка";
    case "if_filter": return filterCount(p.audience) ? `Фильтров: ${filterCount(p.audience)}` : "Условия не заданы";
    case "split": return `A: ${p.percent_a}%${p.control_a ? " (контроль)" : ""} · B: ${100 - p.percent_a}%`;
    case "send_message": {
      const t = (p.texts || {}).ru || Object.values(p.texts || {})[0] || "";
      return t ? t.replace(/\s+/g, " ").slice(0, 70) : "Текст не задан";
    }
    case "issue_promo": {
      const label = { discount: "Скидка", bonus_days: "Бонусные дни", regular_traffic: "Трафик ГБ", premium_traffic: "Premium ГБ" }[p.kind];
      return `${label}: ${p.value}${p.kind === "discount" ? "%" : ""}, ${p.valid_days} дн.`;
    }
    case "notify_admin": return (p.text || "").slice(0, 60);
    case "wait": return p.mode === "until_hour" ? `До ${p.hour}:00` : `${p.amount} ${UNIT_RU[p.unit] || p.unit}`;
    case "goal": return p.name || "Цель";
    case "exit": return p.reason || "Выход";
    default: return "";
  }
}

function fieldVisible(type, key, params) {
  if (type === "wait") return key === "hour" ? params.mode === "until_hour" : key === "mode" || params.mode === "delay";
  if (type === "trg_broadcast") {
    if (key === "at") return params.mode === "at";
    if (key === "time") return params.mode === "daily" || params.mode === "weekly";
    if (key === "weekdays") return params.mode === "weekly";
  }
  if (type === "send_message" && key === "texts") return true;
  return true;
}

async function resizeToJpeg(file, maxSide = 1280) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  let blob = null;
  for (const quality of [0.86, 0.75, 0.6, 0.45]) {
    blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
    if (blob && blob.size <= 900 * 1024) break;
  }
  if (!blob) throw new Error("Не удалось подготовить картинку");
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(binary);
}

class Editor {
  constructor({ meta, graph, onChange, onTest }) {
    this.meta = meta;
    this.catalog = meta.catalog.nodes;
    this.graph = clone(graph);
    this.onChange = onChange;
    this.onTest = onTest;
    this.view = { x: 40, y: 40, k: 1 };
    this.sel = null;
    this.issues = [];
    this.counters = {};
    this.path = new Set();
    this.lang = "ru";
    this.counter = 0;
    this.history = [JSON.stringify(this.graph)];
    this.cursor = 0;
    this.nodeEls = new Map();
    this.commitTimer = 0;
    this.conn = null;
    this.destroyed = false;
  }

  // ------------------------------------------------------------------ mount
  mount(container) {
    this.root = document.createElement("div");
    this.root.className = "ke";
    this.root.innerHTML = `<div class="ke-pal" data-pal></div>
      <div class="ke-cv" data-cv tabindex="0"><div class="ke-world" data-world><svg class="ke-edges" data-edges></svg><div data-nodes></div></div>
        <div class="ke-zoom"><button type="button" data-z="out" title="Отдалить">−</button><button type="button" data-z="fit" title="Показать всё">⌂</button><button type="button" data-z="in" title="Приблизить">+</button></div></div>
      <div class="ke-insp" data-insp></div>`;
    container.replaceChildren(this.root);
    this.cv = this.root.querySelector("[data-cv]");
    this.world = this.root.querySelector("[data-world]");
    this.svg = this.root.querySelector("[data-edges]");
    this.layer = this.root.querySelector("[data-nodes]");
    this.insp = this.root.querySelector("[data-insp]");
    this.pal = this.root.querySelector("[data-pal]");
    this.renderPalette();
    this.bindCanvas();
    this.renderAll();
    this.renderInspector();
    this.fit();
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.commitTimer);
    window.removeEventListener("pointermove", this._move);
    window.removeEventListener("pointerup", this._up);
    this.root?.remove();
  }

  getGraph() {
    return clone(this.graph);
  }

  setIssues(issues) {
    this.issues = issues || [];
    this.nodeEls.forEach((el, id) => this.paintNode(id));
  }

  setCounters(map) {
    this.counters = map || {};
    this.nodeEls.forEach((el, id) => this.paintNode(id));
  }

  setPath(path) {
    this.path = new Set((path || []).map((p) => p.node_id));
    this.nodeEls.forEach((el, id) => el.classList.toggle("ke-path", this.path.has(id)));
  }

  // --------------------------------------------------------------- helpers
  node(id) {
    return this.graph.nodes.find((n) => n.id === id);
  }

  spec(node) {
    return this.catalog[node.type];
  }

  applyView() {
    this.world.style.transform = `translate(${this.view.x}px,${this.view.y}px) scale(${this.view.k})`;
  }

  toGraph(clientX, clientY) {
    const r = this.cv.getBoundingClientRect();
    return { x: (clientX - r.left - this.view.x) / this.view.k, y: (clientY - r.top - this.view.y) / this.view.k };
  }

  schedule() {
    clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => this.commit(), 450);
    this.onChange?.(this.graph, false);
  }

  commit() {
    clearTimeout(this.commitTimer);
    const snap = JSON.stringify(this.graph);
    if (snap === this.history[this.cursor]) return;
    this.history = this.history.slice(0, this.cursor + 1);
    this.history.push(snap);
    if (this.history.length > 60) this.history.shift();
    this.cursor = this.history.length - 1;
    this.onChange?.(this.graph, true);
  }

  restore(index) {
    if (index < 0 || index >= this.history.length) return;
    this.cursor = index;
    this.graph = JSON.parse(this.history[index]);
    if (this.sel && this.sel.type === "node" && !this.node(this.sel.id)) this.sel = null;
    this.renderAll();
    this.renderInspector();
    this.onChange?.(this.graph, true);
  }

  undo() { this.commit(); this.restore(this.cursor - 1); }
  redo() { this.restore(this.cursor + 1); }

  // --------------------------------------------------------------- palette
  renderPalette() {
    const hasTrigger = this.graph.nodes.some((n) => this.spec(n)?.group === "trigger");
    let html = "";
    for (const group of this.meta.catalog.groups) {
      html += `<h4>${esc(group.title)}</h4>`;
      for (const [type, spec] of Object.entries(this.catalog)) {
        if (spec.group !== group.id) continue;
        const off = group.id === "trigger" && hasTrigger;
        html += `<button type="button" data-add="${type}" ${off ? "disabled title=\"В кампании может быть только один триггер\"" : `title="${esc(spec.help)}"`}><i style="font-style:normal">${spec.icon}</i> ${esc(spec.title)}</button>`;
      }
    }
    html += `<div class="kc-muted" style="margin-top:10px;line-height:1.4">Нажмите блок, чтобы добавить его. Если выделен блок со свободным выходом, новый подключится автоматически.</div>`;
    this.pal.innerHTML = html;
    this.pal.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => this.addNode(b.dataset.add)));
  }

  newId() {
    let id;
    do id = `n${++this.counter}`;
    while (this.node(id));
    return id;
  }

  addNode(type) {
    const spec = this.catalog[type];
    if (!spec) return;
    if (spec.group === "trigger" && this.graph.nodes.some((n) => this.catalog[n.type].group === "trigger")) return;
    const params = {};
    for (const f of spec.fields) params[f.key] = clone(f.default);
    const selected = this.sel?.type === "node" ? this.node(this.sel.id) : null;
    let pos;
    let freePort = null;
    if (selected) {
      const ports = this.spec(selected).ports;
      freePort = ports.find((p) => !this.graph.edges.some((e) => e.from === selected.id && e.port === p)) || null;
      if (freePort) {
        const idx = ports.indexOf(freePort);
        pos = { x: selected.x + NODE_W + 70, y: selected.y + (ports.length > 1 ? idx * 110 : 0) };
      }
    }
    if (!pos) {
      const r = this.cv.getBoundingClientRect();
      const c = this.toGraph(r.left + r.width / 2, r.top + r.height / 2);
      pos = { x: c.x - NODE_W / 2 + (this.graph.nodes.length % 5) * 14, y: c.y - NODE_H / 2 + (this.graph.nodes.length % 5) * 14 };
    }
    const node = { id: this.newId(), type, x: Math.round(pos.x), y: Math.round(pos.y), params, label: "" };
    this.graph.nodes.push(node);
    if (selected && freePort && spec.group !== "trigger") this.graph.edges.push({ from: selected.id, port: freePort, to: node.id });
    this.sel = { type: "node", id: node.id };
    this.commit();
    this.renderPalette();
    this.renderAll();
    this.renderInspector();
  }

  removeSelected() {
    if (!this.sel) return;
    if (this.sel.type === "node") {
      const id = this.sel.id;
      this.graph.nodes = this.graph.nodes.filter((n) => n.id !== id);
      this.graph.edges = this.graph.edges.filter((e) => e.from !== id && e.to !== id);
    } else {
      const { from, port, to } = this.sel;
      this.graph.edges = this.graph.edges.filter((e) => !(e.from === from && e.port === port && e.to === to));
    }
    this.sel = null;
    this.commit();
    this.renderPalette();
    this.renderAll();
    this.renderInspector();
  }

  // --------------------------------------------------------------- canvas rendering
  renderAll() {
    this.layer.replaceChildren();
    this.nodeEls.clear();
    for (const node of this.graph.nodes) this.buildNode(node);
    this.renderEdges();
    this.applyView();
  }

  buildNode(node) {
    const spec = this.spec(node);
    const el = document.createElement("div");
    el.className = "ke-node";
    el.dataset.id = node.id;
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    const color = GROUP_COLOR[spec.group];
    let ports = "";
    if (spec.group !== "trigger") ports += `<div class="ke-port in" data-port-in></div>`;
    spec.ports.forEach((p, i) => {
      const y = portY(spec.ports.length, i);
      ports += `<div class="ke-port out" data-port-out="${p}" style="top:${y - 7}px"></div>`;
      if (PORT_LABEL[p]) ports += `<div class="ke-plab" style="top:${y - 8}px">${PORT_LABEL[p]}</div>`;
    });
    el.innerHTML = `<div class="ke-nh" style="border-left:4px solid ${color}"><i>${spec.icon}</i><span data-title></span></div><div class="ke-nb" data-body></div>${ports}<div class="ke-badge" data-badge hidden></div>`;
    this.layer.appendChild(el);
    this.nodeEls.set(node.id, el);
    this.paintNode(node.id);
    el.addEventListener("pointerdown", (e) => this.onNodeDown(e, node.id));
  }

  paintNode(id) {
    const node = this.node(id);
    const el = this.nodeEls.get(id);
    if (!node || !el) return;
    const spec = this.spec(node);
    el.querySelector("[data-title]").textContent = node.label || spec.title;
    el.querySelector("[data-body]").textContent = summary(node, this.meta);
    el.classList.toggle("sel", this.sel?.type === "node" && this.sel.id === id);
    const mine = this.issues.filter((i) => i.node_id === id);
    el.classList.toggle("err", mine.some((i) => i.level === "error"));
    el.classList.toggle("warn", !mine.some((i) => i.level === "error") && mine.length > 0);
    const badge = el.querySelector("[data-badge]");
    const c = this.counters[id];
    if (c) {
      const parts = [];
      if (c.visit) parts.push(`👥 ${num(c.visit)}`);
      if (c.sent) parts.push(`✉ ${num(c.sent)}`);
      if (c.payments) parts.push(`💳 ${num(c.payments)}`);
      badge.textContent = parts.join("  ");
      badge.hidden = !parts.length;
    } else badge.hidden = true;
  }

  edgePoints(edge) {
    const a = this.node(edge.from);
    const b = this.node(edge.to);
    if (!a || !b) return null;
    const ports = this.spec(a).ports;
    const idx = Math.max(0, ports.indexOf(edge.port));
    return { x1: a.x + NODE_W, y1: a.y + portY(ports.length, idx), x2: b.x, y2: b.y + 39 };
  }

  pathD({ x1, y1, x2, y2 }) {
    const dx = Math.max(50, Math.abs(x2 - x1) / 2);
    return `M${x1} ${y1} C${x1 + dx} ${y1},${x2 - dx} ${y2},${x2} ${y2}`;
  }

  renderEdges() {
    let html = "";
    for (const edge of this.graph.edges) {
      const pts = this.edgePoints(edge);
      if (!pts) continue;
      const sel = this.sel?.type === "edge" && this.sel.from === edge.from && this.sel.port === edge.port && this.sel.to === edge.to;
      const d = this.pathD(pts);
      html += `<path class="${sel ? "sel" : ""}" d="${d}"/><path class="hit" d="${d}" data-edge="${edge.from}|${edge.port}|${edge.to}"/>`;
      if (PORT_LABEL[edge.port]) html += `<text x="${pts.x1 + 8}" y="${pts.y1 - 6}">${PORT_LABEL[edge.port]}</text>`;
    }
    this.svg.innerHTML = html;
    this.svg.querySelectorAll("[data-edge]").forEach((p) =>
      p.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        const [from, port, to] = p.dataset.edge.split("|");
        this.select({ type: "edge", from, port, to });
      })
    );
  }

  select(sel) {
    this.sel = sel;
    this.nodeEls.forEach((el, id) => this.paintNode(id));
    this.renderEdges();
    this.renderInspector();
  }

  // --------------------------------------------------------------- canvas interaction
  bindCanvas() {
    this.cv.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".ke-node") || e.target.closest(".ke-zoom") || e.target.closest("[data-edge]")) return;
      this.cv.focus();
      this.select(null);
      const start = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      this.cv.classList.add("pan");
      this.drag = { kind: "pan", start };
    });
    this.cv.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = this.cv.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * 0.0015);
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
      },
      { passive: false }
    );
    this.cv.addEventListener("keydown", (e) => {
      if (e.target.closest("input,textarea,select")) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.removeSelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? this.redo() : this.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        this.redo();
      }
    });
    this.root.querySelectorAll("[data-z]").forEach((b) =>
      b.addEventListener("click", () => {
        const r = this.cv.getBoundingClientRect();
        if (b.dataset.z === "fit") this.fit();
        else this.zoomAt(r.width / 2, r.height / 2, b.dataset.z === "in" ? 1.2 : 1 / 1.2);
      })
    );
    this._move = (e) => this.onMove(e);
    this._up = (e) => this.onUp(e);
    window.addEventListener("pointermove", this._move);
    window.addEventListener("pointerup", this._up);
  }

  zoomAt(px, py, factor) {
    const k = Math.min(1.8, Math.max(0.3, this.view.k * factor));
    const real = k / this.view.k;
    this.view.x = px - (px - this.view.x) * real;
    this.view.y = py - (py - this.view.y) * real;
    this.view.k = k;
    this.applyView();
  }

  fit() {
    const r = this.cv.getBoundingClientRect();
    if (!this.graph.nodes.length || !r.width) {
      this.view = { x: 40, y: 40, k: 1 };
      return this.applyView();
    }
    const xs = this.graph.nodes.map((n) => n.x);
    const ys = this.graph.nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 30, maxX = Math.max(...xs) + NODE_W + 30;
    const minY = Math.min(...ys) - 30, maxY = Math.max(...ys) + NODE_H + 30;
    const k = Math.min(1.1, Math.max(0.35, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
    this.view = { k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k };
    this.applyView();
  }

  onNodeDown(e, id) {
    const portOut = e.target.closest("[data-port-out]");
    if (portOut) {
      e.stopPropagation();
      e.preventDefault();
      this.conn = { from: id, port: portOut.dataset.portOut };
      const live = document.createElementNS("http://www.w3.org/2000/svg", "path");
      live.setAttribute("class", "live");
      this.svg.appendChild(live);
      this.conn.path = live;
      this.drag = { kind: "connect" };
      return;
    }
    if (e.target.closest("[data-port-in]")) return;
    e.stopPropagation();
    this.cv.focus();
    if (!(this.sel?.type === "node" && this.sel.id === id)) this.select({ type: "node", id });
    const node = this.node(id);
    this.drag = { kind: "node", id, sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y, moved: false };
  }

  onMove(e) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === "pan") {
      this.view.x = d.start.vx + (e.clientX - d.start.x);
      this.view.y = d.start.vy + (e.clientY - d.start.y);
      this.applyView();
    } else if (d.kind === "node") {
      const node = this.node(d.id);
      const nx = Math.round(d.ox + (e.clientX - d.sx) / this.view.k);
      const ny = Math.round(d.oy + (e.clientY - d.sy) / this.view.k);
      if (nx !== node.x || ny !== node.y) d.moved = true;
      node.x = nx;
      node.y = ny;
      const el = this.nodeEls.get(d.id);
      el.style.left = `${nx}px`;
      el.style.top = `${ny}px`;
      this.renderEdges();
    } else if (d.kind === "connect" && this.conn) {
      const a = this.node(this.conn.from);
      const ports = this.spec(a).ports;
      const idx = ports.indexOf(this.conn.port);
      const p = this.toGraph(e.clientX, e.clientY);
      this.conn.path.setAttribute("d", this.pathD({ x1: a.x + NODE_W, y1: a.y + portY(ports.length, idx), x2: p.x, y2: p.y }));
    }
  }

  onUp(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.cv.classList.remove("pan");
    if (d.kind === "node" && d.moved) {
      this.commit();
    } else if (d.kind === "connect" && this.conn) {
      const conn = this.conn;
      this.conn = null;
      conn.path.remove();
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".ke-node");
      const target = under && this.root.contains(under) ? under.dataset.id : null;
      if (target) this.connect(conn.from, conn.port, target);
    }
  }

  connect(from, port, to) {
    if (from === to) return;
    const dst = this.node(to);
    if (!dst || this.spec(dst).group === "trigger") return;
    this.graph.edges = this.graph.edges.filter((e) => !(e.from === from && e.port === port));
    this.graph.edges.push({ from, port, to });
    this.commit();
    this.renderEdges();
    this.renderInspector();
  }

  // --------------------------------------------------------------- inspector
  renderInspector() {
    const box = this.insp;
    box.replaceChildren();
    const sel = this.sel;
    if (!sel) {
      box.innerHTML = `<h3>Как собрать кампанию</h3><div class="help">1. Добавьте <b>триггер</b> — он определяет, кто и когда попадает в кампанию.<br>2. Соединяйте блоки: потяните от кружка справа к блоку.<br>3. Для проверки результата добавьте <b>«Случайное деление»</b> с контрольной группой.<br>4. Нажмите <b>«Опубликовать»</b>, затем <b>«Запустить»</b>.<br><br>Колесо мыши — масштаб, перетаскивание фона — перемещение. Delete удаляет выделенное. Ctrl+Z — отмена.</div>`;
      return;
    }
    if (sel.type === "edge") {
      const a = this.node(sel.from), b = this.node(sel.to);
      box.innerHTML = `<h3>Связь</h3><div class="help">${esc(a ? a.label || this.spec(a).title : "")} → ${esc(b ? b.label || this.spec(b).title : "")}</div><button type="button" class="kc-btn kc-danger" data-del>Удалить связь</button>`;
      box.querySelector("[data-del]").addEventListener("click", () => this.removeSelected());
      return;
    }
    const node = this.node(sel.id);
    const spec = this.spec(node);
    const mine = this.issues.filter((i) => i.node_id === node.id);
    box.innerHTML = `<h3>${spec.icon} ${esc(spec.title)}</h3><div class="help">${esc(spec.help)}</div>
      ${mine.map((i) => `<div class="kc-banner ${i.level === "error" ? "bad" : "warn"}" style="margin-bottom:8px">${esc(i.message)}</div>`).join("")}
      <label class="fld">Название блока на схеме<input type="text" data-label maxlength="60" value="${esc(node.label)}" placeholder="${esc(spec.title)}"></label>
      <div data-fields></div>
      <div class="kc-row" style="margin-top:6px"><button type="button" class="kc-btn kc-danger" data-del>Удалить блок</button>${node.type === "send_message" ? `<button type="button" class="kc-btn" data-test>Тест мне в Telegram</button>` : ""}</div>`;
    box.querySelector("[data-label]").addEventListener("input", (e) => {
      node.label = e.target.value;
      this.paintNode(node.id);
      this.schedule();
    });
    box.querySelector("[data-del]").addEventListener("click", () => this.removeSelected());
    const test = box.querySelector("[data-test]");
    if (test) test.addEventListener("click", () => this.onTest?.(node.id, test));
    const fields = box.querySelector("[data-fields]");
    for (const field of spec.fields) {
      if (!fieldVisible(node.type, field.key, node.params)) continue;
      fields.appendChild(this.fieldControl(node, field));
    }
  }

  setParam(node, key, value, rerender = false) {
    node.params[key] = value;
    this.paintNode(node.id);
    this.schedule();
    if (rerender) this.renderInspector();
  }

  fieldControl(node, field) {
    const wrap = document.createElement("div");
    const val = node.params[field.key];
    const label = field.type === "bool" ? "" : `<span>${esc(field.label)}</span>`;
    const dyn = node.type === "issue_promo" && field.key === "value"
      ? { discount: "Скидка, %", bonus_days: "Бонусные дни", regular_traffic: "Трафик, ГБ", premium_traffic: "Premium-трафик, ГБ" }[node.params.kind]
      : null;
    const lab = dyn ? `<span>${dyn}</span>` : label;
    switch (field.type) {
      case "int":
      case "number":
        wrap.className = "fld";
        wrap.innerHTML = `${lab}<input type="number" step="${field.type === "int" ? 1 : "any"}" min="${field.min ?? ""}" max="${field.max ?? ""}" value="${esc(val)}">`;
        wrap.querySelector("input").addEventListener("input", (e) => this.setParam(node, field.key, e.target.value === "" ? "" : Number(e.target.value)));
        break;
      case "bool":
        wrap.className = "fld chk";
        wrap.innerHTML = `<input type="checkbox" ${val ? "checked" : ""}> <span>${esc(field.label)}</span>`;
        wrap.querySelector("input").addEventListener("change", (e) => this.setParam(node, field.key, e.target.checked));
        break;
      case "select":
        wrap.className = "fld";
        wrap.innerHTML = `${lab}<select>${field.options.map((o) => `<option value="${esc(o.value)}" ${o.value === val ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
        wrap.querySelector("select").addEventListener("change", (e) => this.setParam(node, field.key, e.target.value, true));
        break;
      case "text":
        wrap.className = "fld";
        wrap.innerHTML = `${lab}<input type="text" maxlength="${field.max || 200}" value="${esc(val)}">`;
        wrap.querySelector("input").addEventListener("input", (e) => this.setParam(node, field.key, e.target.value));
        break;
      case "time":
        wrap.className = "fld";
        wrap.innerHTML = `${lab}<input type="time" value="${esc(val)}">`;
        wrap.querySelector("input").addEventListener("input", (e) => this.setParam(node, field.key, e.target.value));
        break;
      case "datetime":
        wrap.className = "fld";
        wrap.innerHTML = `${lab}<input type="datetime-local" value="${esc(val)}">`;
        wrap.querySelector("input").addEventListener("input", (e) => this.setParam(node, field.key, e.target.value));
        break;
      case "weekdays":
        wrap.className = "fld";
        wrap.innerHTML = `${lab}<div class="kc-row">${WEEKDAYS.map((d, i) => `<label class="kc-row" style="gap:3px"><input type="checkbox" data-d="${i}" ${(val || []).includes(i) ? "checked" : ""}> ${d}</label>`).join("")}</div>`;
        wrap.querySelectorAll("[data-d]").forEach((c) =>
          c.addEventListener("change", () => {
            const days = [...wrap.querySelectorAll("[data-d]")].filter((x) => x.checked).map((x) => Number(x.dataset.d));
            this.setParam(node, field.key, days.length ? days : [0]);
          })
        );
        break;
      case "texts":
        this.textsControl(wrap, node, field);
        break;
      case "buttons":
        this.buttonsControl(wrap, node, field);
        break;
      case "image":
        this.imageControl(wrap, node, field);
        break;
      case "filter":
        this.filterControl(wrap, node, field);
        break;
      default:
        wrap.textContent = field.label;
    }
    return wrap;
  }

  textsControl(wrap, node, field) {
    wrap.className = "fld";
    const langs = this.meta.catalog.languages;
    const codes = [...this.meta.shortcodes, "promo_code"];
    wrap.innerHTML = `<span>${esc(field.label)} (HTML Telegram: &lt;b&gt;, &lt;i&gt;, &lt;a&gt;, &lt;code&gt;)</span>
      <div class="ke-lang">${langs.map((l) => `<button type="button" data-l="${l}" class="${l === this.lang ? "on" : ""}">${l.toUpperCase()}</button>`).join("")}</div>
      <textarea rows="8" data-ta></textarea>
      <div class="kc-row"><select data-ins style="flex:1"><option value="">Вставить подстановку…</option>${codes.map((c) => `<option value="${c}">{${c}}</option>`).join("")}</select><span class="kc-muted" data-count></span></div>`;
    const ta = wrap.querySelector("[data-ta]");
    const count = wrap.querySelector("[data-count]");
    const load = () => {
      ta.value = (node.params.texts || {})[this.lang] || "";
      count.textContent = `${ta.value.length}/4096`;
      wrap.querySelectorAll("[data-l]").forEach((b) => b.classList.toggle("on", b.dataset.l === this.lang));
    };
    load();
    const write = () => {
      const texts = { ...(node.params.texts || {}) };
      if (ta.value.trim()) texts[this.lang] = ta.value;
      else delete texts[this.lang];
      count.textContent = `${ta.value.length}/4096`;
      this.setParam(node, field.key, texts);
    };
    ta.addEventListener("input", write);
    wrap.querySelectorAll("[data-l]").forEach((b) =>
      b.addEventListener("click", () => {
        this.lang = b.dataset.l;
        load();
      })
    );
    wrap.querySelector("[data-ins]").addEventListener("change", (e) => {
      if (!e.target.value) return;
      const token = `{${e.target.value}}`;
      const s = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, s) + token + ta.value.slice(ta.selectionEnd ?? s);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = s + token.length;
      e.target.value = "";
      write();
    });
  }

  buttonsControl(wrap, node, field) {
    wrap.className = "fld";
    const kinds = { url: "Ссылка", webapp_section: "Раздел Mini App", promo_webapp: "Промокод (Mini App)", promo_bot: "Промокод (бот)" };
    const sectionNames = { home: "Главная", plans: "Тарифы", install: "Подключение", trial: "Пробный период", invite: "Бонусы", devices: "Устройства", support: "Поддержка", settings: "Настройки" };
    const draw = () => {
      const list = node.params.buttons || [];
      wrap.innerHTML = `<span>${esc(field.label)} (до 4). Пустая подпись берётся из переводов Minishop.</span>
        ${list.map((b, i) => `<div class="ke-sub" data-b="${i}">
          <select data-k>${Object.entries(kinds).map(([v, t]) => `<option value="${v}" ${b.kind === v ? "selected" : ""}>${t}</option>`).join("")}</select>
          <input type="text" data-label maxlength="64" placeholder="Подпись" value="${esc(b.label)}" style="margin-top:5px">
          ${b.kind === "url" ? `<input type="text" data-url placeholder="https://…" value="${esc(b.url)}" style="margin-top:5px">` : ""}
          ${b.kind === "webapp_section" ? `<select data-sec style="margin-top:5px">${this.meta.catalog.sections.map((s) => `<option value="${s}" ${b.section === s ? "selected" : ""}>${sectionNames[s] || s}</option>`).join("")}</select>` : ""}
          <button type="button" class="kc-btn kc-danger" data-rm style="margin-top:5px">Убрать</button></div>`).join("")}
        ${list.length < 4 ? `<button type="button" class="kc-btn" data-addb>+ Кнопка</button>` : ""}`;
      wrap.querySelectorAll("[data-b]").forEach((row) => {
        const i = Number(row.dataset.b);
        const b = node.params.buttons[i];
        row.querySelector("[data-k]").addEventListener("change", (e) => { b.kind = e.target.value; this.setParam(node, "buttons", node.params.buttons); draw(); });
        row.querySelector("[data-label]").addEventListener("input", (e) => { b.label = e.target.value; this.setParam(node, "buttons", node.params.buttons); });
        row.querySelector("[data-url]")?.addEventListener("input", (e) => { b.url = e.target.value; this.setParam(node, "buttons", node.params.buttons); });
        row.querySelector("[data-sec]")?.addEventListener("change", (e) => { b.section = e.target.value; this.setParam(node, "buttons", node.params.buttons); });
        row.querySelector("[data-rm]").addEventListener("click", () => { node.params.buttons.splice(i, 1); this.setParam(node, "buttons", node.params.buttons); draw(); });
      });
      wrap.querySelector("[data-addb]")?.addEventListener("click", () => {
        node.params.buttons = [...(node.params.buttons || []), { kind: "webapp_section", label: "", url: "", section: "plans" }];
        this.setParam(node, "buttons", node.params.buttons);
        draw();
      });
    };
    draw();
  }

  imageControl(wrap, node, field) {
    wrap.className = "fld";
    const draw = (status = "") => {
      const id = node.params[field.key];
      wrap.innerHTML = `<span>${esc(field.label)} (подпись до 1024 знаков)</span>
        ${id ? `<img src="${API}/img/${esc(id)}" alt="" style="max-width:100%;max-height:140px;border-radius:8px;border:1px solid var(--border)">` : ""}
        <div class="kc-row"><label class="kc-btn" style="cursor:pointer">Загрузить<input type="file" accept="image/*" hidden></label>${id ? `<button type="button" class="kc-btn kc-danger" data-rm>Убрать</button>` : ""}<span class="kc-muted">${esc(status)}</span></div>`;
      wrap.querySelector("input[type=file]").addEventListener("change", async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        draw("Загрузка…");
        try {
          const res = await api("/images", "POST", { data: await resizeToJpeg(file) });
          node.params[field.key] = res.image_id;
          this.setParam(node, field.key, res.image_id);
          draw("Загружено");
        } catch (err) {
          draw(err.message);
        }
      });
      wrap.querySelector("[data-rm]")?.addEventListener("click", () => { this.setParam(node, field.key, ""); draw(); });
    };
    draw();
  }

  filterControl(wrap, node, field) {
    wrap.className = "fld";
    const spec = this.meta.filter_fields;
    const cur = node.params[field.key] || {};
    wrap.innerHTML = `<span>${esc(field.label)}</span><div class="ke-sub" data-f>${spec.map((f) => {
      const v = cur[f.key];
      if (f.type === "select") return `<label class="fld">${esc(f.label)}<select data-fk="${f.key}">${f.options.map((o) => `<option value="${o.value}" ${(v ?? f.default) === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>`;
      if (f.type === "tags") return `<label class="fld">${esc(f.label)}<input type="text" data-fk="${f.key}" value="${esc((v || []).join(", "))}"></label>`;
      return `<label class="fld">${esc(f.label)}<input type="number" min="${f.min}" max="${f.max}" data-fk="${f.key}" value="${esc(v ?? "")}"></label>`;
    }).join("")}</div>`;
    const read = () => {
      const out = {};
      wrap.querySelectorAll("[data-fk]").forEach((c) => {
        const f = spec.find((x) => x.key === c.dataset.fk);
        const raw = c.value.trim();
        if (f.type === "select") { if (raw && raw !== "any") out[f.key] = raw; }
        else if (f.type === "tags") { if (raw) out[f.key] = raw.split(",").map((t) => t.trim()).filter(Boolean); }
        else if (raw !== "") out[f.key] = Number(raw);
      });
      this.setParam(node, field.key, out);
    };
    wrap.querySelectorAll("[data-fk]").forEach((c) => c.addEventListener("input", read));
  }
}

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
