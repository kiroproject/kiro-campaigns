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
