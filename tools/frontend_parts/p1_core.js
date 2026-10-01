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
