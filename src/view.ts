/**
 * THE SDK'S MCP APPS VIEW (spec §5): one HTML document that draws every
 * derived result (a list, a record, a fragment, a dashboard) for hosts that
 * show MCP Apps views: ChatGPT, Claude, and a workspace host's frames.
 *
 * It speaks the MCP Apps bridge (JSON-RPC 2.0 over postMessage:
 * `ui/initialize` then `ui/notifications/initialized`, `tools/call`,
 * `ui/notifications/tool-result`, `ui/notifications/size-changed`,
 * `ui/update-model-context`). ChatGPT implements the same bridge and also
 * injects `window.openai`: the view draws its first result from
 * `window.openai.toolOutput` when that is there first, but calls tools over the
 * standard bridge; `window.openai.callTool` is used only by a host that did not
 * answer `ui/initialize`. Data arrives as the tool result's `structuredContent`;
 * a page opened with no tool call (`boot`) asks for its own data. No network
 * access: the host relays every call, with its permissions and confirmations.
 * A click always shows something: progress at once, then the record, or what
 * the host or the app said, in a status line at the top of the view.
 */

import { META_KEY, PROTOCOL_ID } from "../spec/src/protocol"

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26"

const STYLE = `
:root{color-scheme:light dark;--bg:var(--color-background-primary,#fff);--bg2:var(--color-background-secondary,#f5f5f7);--fg:var(--color-text-primary,#1d1d1f);--fg2:var(--color-text-secondary,#6e6e73);--line:var(--color-border-primary,#e5e5ea);--accent:var(--color-text-info,#0a66d8);--r:var(--border-radius-md,10px);font-family:var(--font-sans,system-ui,-apple-system,sans-serif)}
@media (prefers-color-scheme:dark){:root{--bg:var(--color-background-primary,#1c1c1e);--bg2:var(--color-background-secondary,#2c2c2e);--fg:var(--color-text-primary,#f5f5f7);--fg2:var(--color-text-secondary,#a1a1a6);--line:var(--color-border-primary,#3a3a3c)}}
html[data-theme=dark]{--bg:var(--color-background-primary,#1c1c1e);--bg2:var(--color-background-secondary,#2c2c2e);--fg:var(--color-text-primary,#f5f5f7);--fg2:var(--color-text-secondary,#a1a1a6);--line:var(--color-border-primary,#3a3a3c)}
html[data-theme=light]{--bg:var(--color-background-primary,#fff);--bg2:var(--color-background-secondary,#f5f5f7);--fg:var(--color-text-primary,#1d1d1f);--fg2:var(--color-text-secondary,#6e6e73);--line:var(--color-border-primary,#e5e5ea)}
*{box-sizing:border-box}body{margin:0;background:transparent;color:var(--fg);font-size:14px;line-height:1.4}
#root{padding:12px}h2{font-size:16px;margin:0 0 10px}h3{font-size:14px;margin:0 0 6px}
.muted{color:var(--fg2)}.box{background:var(--bg);border:1px solid var(--line);border-radius:var(--r);padding:12px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600;color:var(--fg2);font-size:12px}
tr.link{cursor:pointer}tr.link:hover td{background:var(--bg2)}td.num{text-align:right;font-variant-numeric:tabular-nums}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;background:var(--bg2)}
.t-success{background:#d9f5df;color:#11622a}.t-danger{background:#fde0e0;color:#8a1414}.t-warning{background:#fff1cc;color:#7a4d00}.t-info{background:#dcebff;color:#0b4a99}
@media (prefers-color-scheme:dark){.t-success{background:#123d20;color:#9be3ae}.t-danger{background:#4a1616;color:#ffb3b3}.t-warning{background:#4a3a10;color:#ffd98a}.t-info{background:#14304f;color:#a9cfff}}
html[data-theme=dark]{color-scheme:dark}html[data-theme=light]{color-scheme:light}
html[data-theme=dark] .t-success{background:#123d20;color:#9be3ae}html[data-theme=dark] .t-danger{background:#4a1616;color:#ffb3b3}html[data-theme=dark] .t-warning{background:#4a3a10;color:#ffd98a}html[data-theme=dark] .t-info{background:#14304f;color:#a9cfff}
html[data-theme=light] .t-success{background:#d9f5df;color:#11622a}html[data-theme=light] .t-danger{background:#fde0e0;color:#8a1414}html[data-theme=light] .t-warning{background:#fff1cc;color:#7a4d00}html[data-theme=light] .t-info{background:#dcebff;color:#0b4a99}
dl{display:grid;grid-template-columns:minmax(90px,max-content) 1fr;gap:6px 14px;margin:8px 0}dt{color:var(--fg2)}dd{margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.stat{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}
button{font:inherit;border:1px solid var(--line);background:var(--bg2);color:var(--fg);border-radius:8px;padding:5px 12px;cursor:pointer}button.back{margin:0 0 8px;background:transparent;border-color:transparent;color:var(--fg2);padding:2px 4px}button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.actions{margin-top:10px}
form.act{margin-top:8px;display:grid;gap:6px}input,select,textarea{font:inherit;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.bar{display:grid;grid-template-columns:minmax(70px,max-content) 1fr max-content;gap:6px 10px;align-items:center}.bar i{display:block;height:10px;background:var(--accent);border-radius:4px}
.msg{margin-top:8px;font-size:13px}.err{color:#c62828}
th.sort{cursor:pointer;user-select:none;white-space:nowrap}th.sort:hover{color:var(--fg)}th.sort:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.req{color:#c62828}.ferr{color:#c62828;font-size:12px;min-height:0}.bad{border-color:#c62828}form.act label{display:block}
#status{position:sticky;top:0;z-index:2;margin:12px 12px 0;padding:7px 10px;border-radius:8px;font-size:13px;background:var(--bg2);color:var(--fg2);border:1px solid var(--line)}#status[hidden]{display:none}#status.error{color:#c62828;border-color:#c62828}
tr.link:focus-visible td{outline:2px solid var(--accent);outline-offset:-2px}tr[aria-busy=true] td{opacity:.55}
`

const SCRIPT = `
(() => {
  const BOOT = __BOOT__;
  const root = document.getElementById("root"); const statusLine = document.getElementById("status");
  // shown: a result is on screen (the first one the host gave, or the view's own boot call).
  let nextId = 1; const pending = new Map(); let shown = false; let locale = navigator.language || "en";
  const post = (m) => window.parent.postMessage(m, "*");
  // A host that never answers (it refused the call without saying so) is an error the person sees, not a dead click.
  const request = (method, params, wait) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); post({ jsonrpc: "2.0", id, method, params }); if (wait) setTimeout(() => { if (pending.delete(id)) reject(new Error(tr("noAnswer", method + (params && params.name ? " " + params.name : "")))); }, wait); });
  const notify = (method, params) => post({ jsonrpc: "2.0", method, params });
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // The bridge this host speaks: "mcp" once it answered ui/initialize (the standard, ChatGPT included), "openai" for a
  // host that only injects window.openai. Every call waits for the handshake: a host takes no tools/call before it.
  let bridge = null;
  const openaiCalls = () => Boolean(window.openai && typeof window.openai.callTool === "function");
  const ready = request("ui/initialize", { protocolVersion: "${MCP_APPS_PROTOCOL_VERSION}", appInfo: { name: "${PROTOCOL_ID}-view", version: "1.0.0" }, appCapabilities: {} }, 10000).then(
    (r) => { bridge = "mcp"; applyContext(r && r.hostContext); notify("ui/notifications/initialized", {}); resize(); },
    (e) => { if (openaiCalls()) { bridge = "openai"; return; } throw new Error(tr("noBridge") + " (" + String((e && e.message) || e) + ")"); });
  ready.catch(() => {});
  const within = (p, what) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(tr("noAnswer", what))), 30000); p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });
  // A refusal says who refused and why (the host's own words), never a dead click.
  const callTool = async (name, args) => {
    await ready;
    if (bridge === "mcp") {
      try { return await request("tools/call", { name, arguments: args }, 30000); }
      catch (e) { const why = String((e && e.message) || e); throw new Error(why.startsWith(tr("noAnswer", "")) ? why : tr("refused", name) + " " + why); }
    }
    let r;
    try { r = await within(Promise.resolve(window.openai.callTool(name, args)), name); }
    catch (e) { const why = String((e && e.message) || e); throw new Error(why.startsWith(tr("noAnswer", "")) ? why : tr("refused", name) + " " + why); }
    if (r === undefined || r === null || typeof r !== "object") throw new Error(tr("refused", name));
    if (!r.structuredContent && !r.isError) throw new Error(tr("noData", name));
    return r;
  };
  // What the view is doing or what went wrong, at the top where the person is looking (sticky while scrolling).
  const notice = (text, kind) => { statusLine.hidden = !text; statusLine.textContent = text || ""; statusLine.className = kind || ""; statusLine.setAttribute("role", kind === "error" ? "alert" : "status"); resize(); };
  const fail = (e) => { const text = String((e && e.message) || e || "Failed"); if (!shown) { notice(null); root.innerHTML = '<div class="box err">' + esc(text) + "</div>"; resize(); } else notice(text, "error"); };
  // The view's own few words (what the app's labels don't cover), in the host's language when the view has it.
  const STR = {
    en: { opening: "Opening…", working: "Working…", refused: "The host refused the call ({n}).", noAnswer: "The host did not answer ({n}).", noData: "The host returned no data for the view ({n}).", noBridge: "This host does not connect the view to the app", required: "Required", tooShort: "At least {n} characters", tooLong: "At most {n} characters", min: "At least {n}", max: "At most {n}", date: "Enter a date", number: "Enter a number", search: "Search…", choose: "Choose…", none: "No results", done: "Done.", noAccess: "No access", notAvailable: "Not available", sortBy: "Sort by {n}", unknownPerson: "Unknown person", refGone: "Deleted", refUnreachable: "App not answering", refUnknownApp: "App not in this workspace", recordUri: "A record URI: clegra://app/entity/id" },
    it: { opening: "Apertura…", working: "In corso…", refused: "L'host ha rifiutato la chiamata ({n}).", noAnswer: "L'host non ha risposto ({n}).", noData: "L'host non ha restituito dati per la vista ({n}).", noBridge: "Questo host non collega la vista all'app", required: "Obbligatorio", tooShort: "Almeno {n} caratteri", tooLong: "Al massimo {n} caratteri", min: "Almeno {n}", max: "Al massimo {n}", date: "Inserisci una data", number: "Inserisci un numero", search: "Cerca…", choose: "Scegli…", none: "Nessun risultato", done: "Fatto.", noAccess: "Nessun accesso", notAvailable: "Non disponibile", sortBy: "Ordina per {n}", unknownPerson: "Persona sconosciuta", refGone: "Eliminato", refUnreachable: "L'app non risponde", refUnknownApp: "App non presente in questo spazio", recordUri: "L'URI di un record: clegra://app/entità/id" },
    es: { opening: "Abriendo…", working: "En curso…", refused: "El host rechazó la llamada ({n}).", noAnswer: "El host no respondió ({n}).", noData: "El host no devolvió datos para la vista ({n}).", noBridge: "Este host no conecta la vista con la app", required: "Obligatorio", tooShort: "Al menos {n} caracteres", tooLong: "Como máximo {n} caracteres", min: "Al menos {n}", max: "Como máximo {n}", date: "Introduce una fecha", number: "Introduce un número", search: "Buscar…", choose: "Elige…", none: "Sin resultados", done: "Hecho.", noAccess: "Sin acceso", notAvailable: "No disponible", sortBy: "Ordenar por {n}", unknownPerson: "Persona desconocida", refGone: "Eliminado", refUnreachable: "La app no responde", refUnknownApp: "App que no está en este espacio", recordUri: "La URI de un registro: clegra://app/entidad/id" },
    fr: { opening: "Ouverture…", working: "En cours…", refused: "L'hôte a refusé l'appel ({n}).", noAnswer: "L'hôte n'a pas répondu ({n}).", noData: "L'hôte n'a renvoyé aucune donnée pour la vue ({n}).", noBridge: "Cet hôte ne relie pas la vue à l'app", required: "Obligatoire", tooShort: "Au moins {n} caractères", tooLong: "Au plus {n} caractères", min: "Au moins {n}", max: "Au plus {n}", date: "Saisissez une date", number: "Saisissez un nombre", search: "Rechercher…", choose: "Choisir…", none: "Aucun résultat", done: "Fait.", noAccess: "Pas d'accès", notAvailable: "Non disponible", sortBy: "Trier par {n}", unknownPerson: "Personne inconnue", refGone: "Supprimé", refUnreachable: "L'app ne répond pas", refUnknownApp: "App absente de cet espace", recordUri: "L'URI d'un enregistrement : clegra://app/entité/id" },
    de: { opening: "Wird geöffnet…", working: "Wird ausgeführt…", refused: "Der Host hat den Aufruf abgelehnt ({n}).", noAnswer: "Der Host hat nicht geantwortet ({n}).", noData: "Der Host hat keine Daten für die Ansicht geliefert ({n}).", noBridge: "Dieser Host verbindet die Ansicht nicht mit der App", required: "Erforderlich", tooShort: "Mindestens {n} Zeichen", tooLong: "Höchstens {n} Zeichen", min: "Mindestens {n}", max: "Höchstens {n}", date: "Datum eingeben", number: "Zahl eingeben", search: "Suchen…", choose: "Auswählen…", none: "Keine Ergebnisse", done: "Erledigt.", noAccess: "Kein Zugriff", notAvailable: "Nicht verfügbar", sortBy: "Sortieren nach {n}", unknownPerson: "Unbekannte Person", refGone: "Gelöscht", refUnreachable: "App antwortet nicht", refUnknownApp: "App nicht in diesem Arbeitsbereich", recordUri: "Die URI eines Datensatzes: clegra://app/entität/id" },
  };
  const tr = (k, n) => String((STR[String(locale).split("-")[0].toLowerCase()] || STR.en)[k] || STR.en[k]).replace("{n}", n === undefined ? "" : n);
  // The app's labels in the reader's language (hostContext.locale): each call sends its labels' other locales (_meta.${PROTOCOL_ID}.l10n); English when the app lacks the reader's.
  let l10n = {};
  const L = (s) => { if (typeof s !== "string") return s; const lang = String(locale).split("-")[0].toLowerCase(); const d = l10n[locale] || l10n[lang] || l10n.en; const out = d && d[s]; return typeof out === "string" ? out : s; };
  // Records of other apps, as the workspace host resolved them for this viewer (_meta.${META_KEY}.resolved: uri → { state, title? }, spec §3.2).
  let resolved = {};
  const learn = (r) => { const m = r && ((r._meta && r._meta["${META_KEY}"]) || (r.result && r.result._meta && r.result._meta["${META_KEY}"])); if (m && m.resolved && typeof m.resolved === "object") resolved = Object.assign({}, resolved, m.resolved); const add = m && m.l10n; if (!add || typeof add !== "object") return; for (const [k, d] of Object.entries(add)) if (d && typeof d === "object") l10n[k] = Object.assign(l10n[k] || {}, d); };
  let refs = {};
  const STATE_WORD = { "no-access": "noAccess", gone: "refGone", unreachable: "refUnreachable", "unknown-app": "refUnknownApp" };
  // A record of another app: its title or its state as the host says it; without the host's word, the app and entity the URI names, never a title.
  const crossRef = (v) => {
    const r = resolved[v];
    if (r && r.state === "ok" && typeof r.title === "string") return esc(r.title);
    if (r && STATE_WORD[r.state]) return '<span class="muted" title="' + esc(v) + '">' + esc(tr(STATE_WORD[r.state])) + "</span>";
    const m = /^${PROTOCOL_ID}:\\/\\/([^/]+)\\/([^/]+)\\//.exec(String(v));
    return '<span class="muted" title="' + esc(v) + '">' + esc(m ? m[1] + " · " + m[2] : v) + "</span>";
  };
  const fmt = (v, col) => {
    if (col && col.ref && typeof col.ref === "object" && col.ref.kind && typeof v === "string" && v) return crossRef(v);
    if (col && col.ref && refs[col.name] && refs[col.name][v]) return esc(refs[col.name][v]);
    // A person by name; one the app can't name is an unknown person, never the bare id.
    if (col && col.role === "person" && !col.ref && refs[col.name] && v !== null && v !== undefined && v !== "") return refs[col.name][v] ? esc(refs[col.name][v]) : '<span class="muted">' + esc(tr("unknownPerson")) + "</span>";
    if (v === null || v === undefined || v === "") return '<span class="muted">—</span>';
    if (col && col.role === "amount" && typeof v === "number") { try { return esc(new Intl.NumberFormat(locale, { style: "currency", currency: col.currency || "EUR" }).format(v)); } catch { return esc(v); } }
    if (col && col.role === "date" && typeof v === "string" && /^\\d{4}-\\d{2}-\\d{2}/.test(v)) { try { return esc(new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(v.length === 10 ? v + "T12:00:00" : v))); } catch { return esc(v); } }
    if (col && col.enum && col.labels) { const label = L(col.labels[v] ?? v); const tone = col.tones && col.tones[v]; return col.role === "status" ? '<span class="badge ' + (tone ? "t-" + tone : "") + '">' + esc(label) + "</span>" : esc(label); }
    if (typeof v === "number") return esc(new Intl.NumberFormat(locale).format(v));
    if (typeof v === "boolean") return v ? "✓" : "—";
    if (typeof v === "object") return esc(JSON.stringify(v));
    return esc(v);
  };
  const resize = () => notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: Math.ceil(document.body.getBoundingClientRect().height) });
  const say = (el, text, error) => { let m = el.querySelector(":scope > .msg"); if (!m) { m = document.createElement("div"); m.className = "msg"; el.appendChild(m); } m.className = "msg" + (error ? " err" : ""); m.textContent = text; m.hidden = !text; resize(); if (text && m.scrollIntoView) m.scrollIntoView({ block: "nearest" }); };
  const resultOf = (r) => { learn(r); return (r && r.structuredContent) || (r && r.result && r.result.structuredContent) || r || {}; };
  const errorOf = (r) => { const s = resultOf(r); return (r && r.isError) ? L((s.error && s.error.message) || (r.content && r.content[0] && r.content[0].text) || "Failed") : null; };

  function actionForm(container, action, record, recordTitle) {
    const schema = action.input || {};
    const props = schema.properties || {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const keys = Object.keys(props).filter((k) => k !== "id");
    // What is wrong with each field, said under it; true when something was said.
    const showErrors = (form, errs) => { let any = false; form.querySelectorAll("[data-err]").forEach((d) => { const m = errs[d.dataset.err]; d.textContent = m || ""; const el = form.elements[d.dataset.err]; if (el && el.classList) { el.classList.toggle("bad", Boolean(m)); el.setAttribute("aria-invalid", m ? "true" : "false"); } if (m) any = true; }); resize(); return any; };
    const run = async (args, form) => {
      const button = form && form.querySelector("button.primary"); if (button) button.disabled = true;
      say(container, tr("working"));
      try {
        // record_title: what the host's own approval prompt can show beside the id; the app never trusts it (it names the record itself).
        const r = await callTool(action.tool, Object.assign({}, record ? { id: record.id } : {}, record && recordTitle ? { record_title: recordTitle } : {}, args)); const e = errorOf(r);
        if (e) { const fields = resultOf(r).error && resultOf(r).error.fields; if (form && fields && showErrors(form, fields)) { say(container, ""); return; } return say(container, e, true); }
        if (form) form.remove();
        const s = resultOf(r); say(container, L(s.message) || tr("done")); tellModel(action, r, s);
        if (lastCall && (s.record || !record)) { try { await reload(); } catch (e) { return fail(e); } const box = root.querySelector(".box"); if (box) say(box, L(s.message) || tr("done")); }
      }
      catch (e) { say(container, String(e && e.message || e), true); }
      finally { if (button) button.disabled = false; }
    };
    if (!keys.length) return run({}, null);
    const open = container.querySelector(":scope > form.act"); if (open) open.remove();
    const f = document.createElement("form"); f.className = "act"; f.noValidate = true;
    f.innerHTML = keys.map((k) => { const p = props[k]; const must = required.has(k);
      const label = esc(L(p.title) || k) + (p.currency ? " (" + esc(p.currency) + ")" : "") + (must ? ' <span class="req" title="' + esc(tr("required")) + '">*</span>' : "");
      const attrs = ' name="' + esc(k) + '"' + (must ? ' aria-required="true"' : "");
      const err = '<div class="ferr" data-err="' + esc(k) + '" role="alert"></div>';
      // Another record's id: a picker over that entity's list (searched by text when it can be), showing titles.
      if (p.ref && p.ref.tool) return "<label>" + label + "<br>" + (p.ref.search ? '<input type="search" data-ref-search="' + esc(k) + '" placeholder="' + esc(tr("search")) + '" aria-label="' + esc(tr("search")) + '"> ' : "") + "<select" + attrs + ' data-ref="' + esc(k) + '"><option value="">' + esc(tr("choose")) + "</option></select></label>" + err;
      if (Array.isArray(p.enum)) return "<label>" + label + "<br><select" + attrs + ">" + (must ? "" : '<option value="">—</option>') + p.enum.map((v) => '<option value="' + esc(v) + '">' + esc(L((p.labels && p.labels[v]) || v)) + "</option>").join("") + "</select></label>" + err;
      if (p.type === "boolean") return '<label><input type="checkbox" name="' + esc(k) + '"> ' + esc(L(p.title) || k) + "</label>";
      const num = p.type === "number" || p.type === "integer";
      // A record of another app: its URI (a workspace host offers its own picker over every app of the kind).
      if (p.ref && p.ref.kind) return "<label>" + label + "<br><input" + attrs + ' type="text" placeholder="${PROTOCOL_ID}://…" spellcheck="false"></label>' + err;
      return "<label>" + label + "<br><input" + attrs + ' type="' + (num ? "number" : p.format === "date" ? "date" : "text") + '"' + (num && p.type === "number" ? ' step="any"' : "") + (typeof p.minimum === "number" ? ' min="' + p.minimum + '"' : "") + (typeof p.maximum === "number" ? ' max="' + p.maximum + '"' : "") + (typeof p.maxLength === "number" ? ' maxlength="' + p.maxLength + '"' : "") + "></label>" + err; }).join("") + '<div class="row"><button class="primary" type="button">' + esc(L(action.title)) + "</button></div>";
    // The latest ask per field wins: an earlier, slower answer (the first full list) never replaces what was searched after it.
    const asked = {};
    const loadRef = async (k, q) => {
      const p = props[k]; const sel = f.elements[k]; if (!sel) return; const keep = sel.value; const turn = asked[k] = (asked[k] || 0) + 1;
      try { const r = await callTool(p.ref.tool, Object.assign({ limit: 25 }, q ? { query: q } : {})); if (turn !== asked[k] || errorOf(r)) return; const rows = resultOf(r).rows || [];
        sel.innerHTML = '<option value="">' + esc(tr(rows.length ? "choose" : "none")) + "</option>" + rows.map((row) => '<option value="' + esc(row.id) + '">' + esc(row[p.ref.title] === undefined || row[p.ref.title] === null ? row.id : row[p.ref.title]) + "</option>").join("");
        if (keep && rows.some((row) => row.id === keep)) sel.value = keep; else if (q && rows.length === 1) sel.value = rows[0].id; resize(); } catch {}
    };
    const check = (k, el) => { const p = props[k]; if (p.type === "boolean") return null; const v = el.value;
      if (v === "") return required.has(k) ? tr("required") : null;
      if (p.type === "number" || p.type === "integer") { const n = Number(v); if (!Number.isFinite(n) || (p.type === "integer" && !Number.isInteger(n))) return tr("number"); if (typeof p.minimum === "number" && n < p.minimum) return tr("min", fmt(p.minimum)); if (typeof p.maximum === "number" && n > p.maximum) return tr("max", fmt(p.maximum)); return null; }
      if (p.format === "date" && !/^\\d{4}-\\d{2}-\\d{2}$/.test(v)) return tr("date");
      if (p.ref && p.ref.kind && typeof p.pattern === "string" && !new RegExp(p.pattern).test(v)) return tr("recordUri");
      if (typeof p.minLength === "number" && v.length < p.minLength) return tr("tooShort", p.minLength);
      if (typeof p.maxLength === "number" && v.length > p.maxLength) return tr("tooLong", p.maxLength);
      return null; };
    // A click, not a form submission: views run in a sandbox without allow-forms.
    f.onsubmit = (e) => e.preventDefault();
    f.querySelector("button.primary").onclick = () => {
      const args = {}; const errs = {};
      for (const k of keys) { const el = f.elements[k]; const p = props[k]; if (!el) continue; const bad = check(k, el); if (bad) errs[k] = bad; if (p.type === "boolean") args[k] = el.checked; else if (el.value !== "") args[k] = (p.type === "number" || p.type === "integer") ? Number(el.value) : el.value; }
      if (showErrors(f, errs)) { const first = f.querySelector(".bad"); if (first && first.focus) first.focus(); return; }
      run(args, f);
    };
    container.appendChild(f);
    for (const k of keys) if (props[k].ref && props[k].ref.tool) { loadRef(k, ""); const box = f.querySelector('[data-ref-search="' + k + '"]'); let timer; if (box) box.oninput = () => { clearTimeout(timer); timer = setTimeout(() => loadRef(k, box.value.trim()), 250); }; }
    resize();
  }
  function actionsBar(el, actions, record, recordTitle) {
    if (!actions || !actions.length) return;
    const bar = document.createElement("div"); bar.className = "row actions";
    for (const a of actions) { const b = document.createElement("button"); b.textContent = L(a.title); b.onclick = () => actionForm(el, a, record, recordTitle); bar.appendChild(b); }
    el.appendChild(bar);
  }
  // A change made in the view, told to the model for its next turn (MCP Apps ui/update-model-context: the host keeps the
  // last one). The text is the app's own result text, as the model would have read it from the call.
  const tellModel = (action, r, s) => {
    if (bridge !== "mcp") return;
    const said = (r && Array.isArray(r.content) && r.content[0] && typeof r.content[0].text === "string") ? r.content[0].text : String(s.message || "");
    request("ui/update-model-context", { content: [{ type: "text", text: "The person used «" + L(action.title) + "» (" + action.tool + ") in the app's view: " + said }], structuredContent: { tool: action.tool, result: s } }, 10000)
      .catch((e) => console.warn("[${PROTOCOL_ID}] the host did not take the model context", e));
  };
  let lastCall = null; let last = null;
  // Where «back» returns: the lists and searches a record was opened from, each with the call that draws it again.
  const trail = [];
  const reload = async () => { if (!lastCall) return; const r = await callTool(lastCall.name, lastCall.args); const e = errorOf(r); if (e) throw new Error(e); render(resultOf(r)); };
  const open = async (name, args, el) => {
    const from = { s: last, call: lastCall };
    if (el) el.setAttribute("aria-busy", "true");
    notice(tr("opening"), "busy");
    try { const r = await callTool(name, args); const e = errorOf(r); if (e) return fail(e); const s = resultOf(r); if (!s || !s.view) return fail(tr("noData", name)); if (from.s) trail.push(from); lastCall = { name, args }; notice(null); render(s); }
    catch (e) { fail(e); }
    finally { if (el) el.removeAttribute("aria-busy"); }
  };
  const backBar = () => {
    if (!trail.length) return;
    const prev = trail[trail.length - 1];
    const b = document.createElement("button"); b.className = "back"; b.textContent = "‹ " + L((prev.s.view && prev.s.view.title) || "");
    b.onclick = async () => { trail.pop(); lastCall = prev.call; notice(null); if (prev.call) { try { await reload(); return; } catch {} } render(prev.s); };
    b.dataset.back = "1";
    root.appendChild(b);
  };

  function recordBox(view, record) {
    const el = document.createElement("div"); el.className = "box";
    const title = view.fields.find((f) => f.role === "title");
    const named = record[title ? title.name : "id"];
    el.innerHTML = "<h2>" + esc(named) + "</h2><dl>" + view.fields.filter((f) => f.name !== "id" && f.role !== "title" && record[f.name] !== undefined).map((f) => "<dt>" + esc(L(f.label)) + "</dt><dd>" + fmt(record[f.name], f) + "</dd>").join("") + "</dl>";
    actionsBar(el, view.actions, record, named === undefined || named === null ? "" : String(named));
    return el;
  }
  function fragmentBox(fr) {
    const el = document.createElement("div"); el.className = "box";
    const d = fr.data || {};
    if (fr.state && fr.state !== "ok") { el.innerHTML = '<span class="muted">' + esc(tr(fr.state === "no-access" ? "noAccess" : "notAvailable")) + "</span>"; return el; }
    if (fr.template === "record" && fr.view) return recordBox(fr.view, fr.data);
    let h = fr.title ? "<h3>" + esc(L(fr.title)) + "</h3>" : "";
    if (fr.template === "stat") { const v = typeof d.value === "number" ? (d.format === "money" ? new Intl.NumberFormat(locale, { style: "currency", currency: d.currency || "EUR" }).format(d.value) : d.format === "percent" ? new Intl.NumberFormat(locale, { style: "percent" }).format(d.value) : new Intl.NumberFormat(locale).format(d.value)) : d.value; h += '<div class="muted">' + esc(L(d.label)) + '</div><div class="stat">' + esc(v) + "</div>" + (d.hint ? '<div class="muted">' + esc(L(d.hint)) + "</div>" : ""); }
    else if (fr.template === "card") h += "<h2>" + esc(d.title) + "</h2>" + (d.subtitle ? '<div class="muted">' + esc(d.subtitle) + "</div>" : "") + (d.status ? '<span class="badge">' + esc(L(d.status)) + "</span>" : "") + "<dl>" + (d.fields || []).map((f) => "<dt>" + esc(L(f.label)) + "</dt><dd>" + esc(f.value) + "</dd>").join("") + "</dl>";
    else if (fr.template === "list") h += (d.items || []).map((i) => "<div style='padding:6px 0;border-bottom:1px solid var(--line)'><b>" + esc(i.title) + "</b>" + (i.status ? ' <span class="badge">' + esc(L(i.status)) + "</span>" : "") + (i.subtitle ? '<div class="muted">' + esc(i.subtitle) + "</div>" : "") + "</div>").join("") || '<span class="muted">—</span>';
    else if (fr.template === "chart") { const pts = d.points || []; const max = Math.max(1, ...pts.map((p) => Math.abs(Number(p.value) || 0))); h += '<div class="bar">' + pts.map((p) => "<span>" + esc(L(p.label)) + '</span><i style="width:' + Math.round((Math.abs(Number(p.value) || 0) / max) * 100) + '%"></i><span class="muted">' + esc(d.format === "money" ? new Intl.NumberFormat(locale, { style: "currency", currency: d.currency || "EUR", maximumFractionDigits: 0 }).format(p.value) : p.value) + "</span>").join("") + "</div>"; }
    else h += "<pre>" + esc(JSON.stringify(d, null, 2)) + "</pre>";
    el.innerHTML = h;
    actionsBar(el, fr.actions, null);
    return el;
  }
  function render(s) {
    shown = true; last = s;
    refs = (s && s.refs) || {};
    const v = s && s.view;
    root.innerHTML = "";
    if (s && s.error) { root.innerHTML = '<div class="box err">' + esc(L(s.error.message) || s.error.code) + "</div>"; return resize(); }
    if (!v) { root.innerHTML = '<div class="box muted">' + esc(JSON.stringify(s)) + "</div>"; return resize(); }
    if (v.kind === "list") {
      const box = document.createElement("div"); box.className = "box";
      const cols = v.columns;
      box.innerHTML = "<h2>" + esc(L(v.title)) + (typeof s.total === "number" ? ' <span class="muted">· ' + esc(s.total) + "</span>" : "") + "</h2>" +
        "<table><thead><tr>" + cols.map((c) => { const on = v.sort && v.sort.field === c.name ? v.sort.dir : null;
          // A sortable column's header sorts by it: first ascending, again descending. The app checks the field (and refuses one the caller may not see).
          return c.sort && v.tool ? '<th class="sort" tabindex="0" role="columnheader" data-sort="' + esc(c.name) + '" aria-sort="' + (on === "asc" ? "ascending" : on === "desc" ? "descending" : "none") + '" title="' + esc(tr("sortBy", L(c.label))) + '">' + esc(L(c.label)) + (on ? (on === "asc" ? " ▲" : " ▼") : "") + "</th>" : "<th>" + esc(L(c.label)) + "</th>"; }).join("") + "</tr></thead><tbody>" +
        (s.rows || []).map((r, i) => '<tr class="link" tabindex="0" data-i="' + i + '">' + cols.map((c) => "<td" + (c.role === "amount" || c.type === "number" ? ' class="num"' : "") + ">" + fmt(r[c.name], c) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table>" + ((s.rows || []).length ? "" : '<p class="muted">—</p>');
      if (v.tool && !lastCall) lastCall = { name: v.tool, args: v.args || {} };
      box.querySelectorAll("tr.link").forEach((row) => { const go = () => open(v.getTool, { id: s.rows[Number(row.dataset.i)].id }, row); row.onclick = go; row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } }; });
      box.querySelectorAll("th.sort").forEach((th) => { const go = async () => { const field = th.dataset.sort; const args = Object.assign({}, v.args || {}, { sort: field, dir: v.sort && v.sort.field === field && v.sort.dir === "asc" ? "desc" : "asc" }); delete args.cursor;
        notice(tr("opening"), "busy"); try { const r = await callTool(v.tool, args); const e = errorOf(r); if (e) return fail(e); lastCall = { name: v.tool, args }; notice(null); render(resultOf(r)); } catch (e) { fail(e); } };
        th.onclick = go; th.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } }; });
      if (s.next && v.tool) { const more = document.createElement("button"); more.textContent = "…"; more.style.marginTop = "8px"; more.onclick = async () => { notice(tr("opening"), "busy"); try { const r = await callTool(v.tool, Object.assign({}, v.args || {}, { cursor: s.next })); const e = errorOf(r); if (e) return fail(e); notice(null); render(resultOf(r)); } catch (e) { fail(e); } }; box.appendChild(more); }
      root.appendChild(box);
    } else if (v.kind === "record") {
      if (v.tool && s.record && s.record.id !== undefined) lastCall = { name: v.tool, args: { id: s.record.id } };
      backBar();
      root.appendChild(recordBox(v, s.record));
    } else if (v.kind === "fragment") {
      root.appendChild(fragmentBox(Object.assign({ title: v.title }, s)));
    } else if (v.kind === "dashboard") {
      const h = document.createElement("h2"); h.textContent = L(v.title); root.appendChild(h);
      const g = document.createElement("div"); g.className = "grid"; for (const fr of s.fragments || []) g.appendChild(fragmentBox(fr)); root.appendChild(g);
    } else if (v.kind === "search") {
      const box = document.createElement("div"); box.className = "box";
      box.innerHTML = (s.results || []).map((r, i) => "<div class='hit' data-i='" + i + "' style='padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer'><b>" + esc(r.title) + "</b> <span class='muted'>" + esc(L(r.entityLabel || "")) + "</span>" + (r.status ? ' <span class="badge">' + esc(L(r.status)) + "</span>" : "") + (r.subtitle ? "<div class='muted'>" + esc(r.subtitle) + "</div>" : "") + "</div>").join("") || '<span class="muted">—</span>';
      box.querySelectorAll(".hit").forEach((el) => el.onclick = () => open("fetch", { id: s.results[Number(el.dataset.i)].id }, el));
      root.appendChild(box);
    }
    resize();
  }
  const applyContext = (ctx) => { if (!ctx) return; if (ctx.theme) document.documentElement.dataset.theme = ctx.theme; if (ctx.locale) locale = ctx.locale; const vars = ctx.styles && ctx.styles.variables; if (vars) for (const [k, v] of Object.entries(vars)) if (v) document.documentElement.style.setProperty(k, v); };
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const m = e.data; if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && pending.has(m.id) && !m.method) { const p = pending.get(m.id); pending.delete(m.id); return m.error ? p.reject(new Error(m.error.message || "error")) : p.resolve(m.result); }
    // The result of the call that opened the view, once. Hosts send tool-result again for the view's own calls (MCP Apps,
    // interactive phase) and may repeat it: the view already drew those from the call's answer, and the person's place
    // (a record opened from the list, the way back) is never replaced by an older result.
    if (m.method === "ui/notifications/tool-result") { if (shown) return; const s = resultOf(m.params); if ((s && s.view) || !BOOT) render(s); return; }
    // A new language: everything is drawn again in it, the app's labels from the locales its results sent (the data stay as they are: asking again would answer in the token's language).
    if (m.method === "ui/notifications/host-context-changed") { const before = locale; applyContext(m.params); if (locale !== before && last) render(last); return; }
    if (m.method === "ui/resource-teardown" && m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, result: {} });
  });
  const boot = async () => {
    if (BOOT && !shown) { lastCall = { name: BOOT.tool, args: BOOT.args || {} }; try { const r = await callTool(BOOT.tool, BOOT.args || {}); const e = errorOf(r); if (e) { root.innerHTML = '<div class="box err">' + esc(e) + "</div>"; resize(); } else render(resultOf(r)); } catch (e) { root.innerHTML = '<div class="box err">' + esc(e.message || e) + "</div>"; resize(); } }
  };
  // ChatGPT's window.openai: the opening result (toolOutput = structuredContent) and its _meta apart (toolResponseMetadata:
  // the MCP result envelope, the _meta under mcp_tool_result / call_tool_result), its locale. openai:set_globals carries
  // only what changed (layout, theme, widget state…): it never replaces what the person opened since.
  const openaiMeta = (m) => { if (!m || typeof m !== "object") return null; for (const c of [m, m._meta, m.mcp_tool_result && m.mcp_tool_result._meta, m.call_tool_result && m.call_tool_result._meta]) if (c && typeof c === "object" && c["${META_KEY}"]) return c; return null; };
  const fromOpenai = (g) => {
    if (!g || typeof g !== "object") return;
    const before = locale; if (typeof g.locale === "string" && g.locale) locale = g.locale;
    const meta = openaiMeta(g.toolResponseMetadata); if (meta) learn({ _meta: meta });
    if (!shown && g.toolOutput && typeof g.toolOutput === "object") return render(g.toolOutput);
    if (shown && (locale !== before || meta) && last) render(last);
  };
  if (window.openai) fromOpenai(window.openai);
  window.addEventListener("openai:set_globals", (e) => fromOpenai(e && e.detail && e.detail.globals));
  ready.then(() => setTimeout(boot, 250), (e) => { if (!shown) fail(e); });
  new ResizeObserver(resize).observe(document.body);
})();
`

/** The view document; `boot` names the tool a page calls for its own data when no tool result opens it. */
export function viewHtml(title: string, boot: { tool: string; args?: Record<string, unknown> } | null = null): string {
  const bootJson = JSON.stringify(boot).replace(/</g, "\\u003c")
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.replace(/[<&]/g, "")}</title><style>${STYLE}</style></head><body><div id="status" role="status" aria-live="polite" hidden></div><div id="root"><div class="box muted">…</div></div><script>${SCRIPT.replace("__BOOT__", bootJson)}</script></body></html>`
}

const URL_PAGE_SCRIPT = `
(() => {
  const PAGE = __PAGE__;
  const frame = document.getElementById("page"); const statusLine = document.getElementById("status");
  let locale = navigator.language || "en";
  const STR = {
    en: { signingIn: "Signing in…", notOpened: "The page did not open: this host may not let the view sign in to an embedded page.", noBridge: "This host does not connect the view to the app", noAnswer: "The host did not answer ({n}).", refused: "The host refused the call ({n})." },
    it: { signingIn: "Accesso in corso…", notOpened: "La pagina non si è aperta: questo host potrebbe non permettere alla vista di accedere a una pagina incorporata.", noBridge: "Questo host non collega la vista all'app", noAnswer: "L'host non ha risposto ({n}).", refused: "L'host ha rifiutato la chiamata ({n})." },
    es: { signingIn: "Iniciando sesión…", notOpened: "La página no se abrió: puede que este host no permita a la vista iniciar sesión en una página incrustada.", noBridge: "Este host no conecta la vista con la app", noAnswer: "El host no respondió ({n}).", refused: "El host rechazó la llamada ({n})." },
    fr: { signingIn: "Connexion…", notOpened: "La page ne s'est pas ouverte : cet hôte ne permet peut-être pas à la vue de se connecter à une page intégrée.", noBridge: "Cet hôte ne relie pas la vue à l'app", noAnswer: "L'hôte n'a pas répondu ({n}).", refused: "L'hôte a refusé l'appel ({n})." },
    de: { signingIn: "Anmeldung…", notOpened: "Die Seite wurde nicht geöffnet: Dieser Host erlaubt der Ansicht vielleicht nicht, sich bei einer eingebetteten Seite anzumelden.", noBridge: "Dieser Host verbindet die Ansicht nicht mit der App", noAnswer: "Der Host hat nicht geantwortet ({n}).", refused: "Der Host hat den Aufruf abgelehnt ({n})." },
  };
  const tr = (k, n) => String((STR[String(locale).split("-")[0].toLowerCase()] || STR.en)[k]).replace("{n}", n === undefined ? "" : n);
  const notice = (text, error) => { statusLine.hidden = !text; statusLine.textContent = text || ""; statusLine.className = error ? "error" : ""; statusLine.setAttribute("role", error ? "alert" : "status"); };
  let nextId = 1; const pending = new Map();
  const post = (m) => window.parent.postMessage(m, "*");
  const request = (method, params, wait) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); post({ jsonrpc: "2.0", id, method, params }); setTimeout(() => { if (pending.delete(id)) reject(new Error(tr("noAnswer", method + (params && params.name ? " " + params.name : "")))); }, wait); });
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const m = e.data; if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); return m.error ? p.reject(new Error(m.error.message || "error")) : p.resolve(m.result); }
    if (m.method === "ui/resource-teardown" && m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, result: {} });
  });
  let bridge = null;
  const ready = request("ui/initialize", { protocolVersion: "${MCP_APPS_PROTOCOL_VERSION}", appInfo: { name: "${PROTOCOL_ID}-url-page", version: "1.0.0" }, appCapabilities: {} }, 10000).then(
    (r) => { bridge = "mcp"; if (r && r.hostContext && r.hostContext.locale) locale = r.hostContext.locale; post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }); post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 720 } }); },
    (e) => { if (window.openai && typeof window.openai.callTool === "function") { bridge = "openai"; if (window.openai.locale) locale = window.openai.locale; return; } throw new Error(tr("noBridge") + " (" + String((e && e.message) || e) + ")"); });
  // The ticket (spec §5.1), asked for the viewer over the host's bridge, as the view's other calls.
  const callTool = async (name, args) => {
    await ready;
    let r;
    try { r = bridge === "mcp" ? await request("tools/call", { name, arguments: args }, 30000) : await window.openai.callTool(name, args); }
    catch (e) { const why = String((e && e.message) || e); throw new Error(why.startsWith(tr("noAnswer", "")) ? why : tr("refused", name) + " " + why); }
    const s = r && r.structuredContent;
    if (!r || r.isError || !s) throw new Error((s && s.error && s.error.message) || (r && r.content && r.content[0] && r.content[0].text) || tr("refused", name));
    return s;
  };
  const open = async () => {
    if (!PAGE.embed) { frame.src = PAGE.url; return; }
    notice(tr("signingIn"));
    // location.origin is this document's: the one that posts the ticket, so the one the ticket is for.
    const t = await callTool(PAGE.embed.tool, { page: PAGE.embed.page, origin: location.origin });
    // A form posted into the frame: the ticket never sits in a URL, the history or a Referer.
    const form = document.createElement("form"); form.method = "post"; form.action = t.action; form.target = frame.name; form.hidden = true;
    const field = document.createElement("input"); field.type = "hidden"; field.name = t.field; field.value = t.ticket; form.appendChild(field);
    document.body.appendChild(form);
    const late = setTimeout(() => notice(tr("notOpened"), true), 20000);
    frame.addEventListener("load", () => { clearTimeout(late); notice(null); }, { once: true });
    form.submit(); form.remove();
  };
  ready.then(open).catch((e) => notice(String((e && e.message) || e), true));
})();
`

/**
 * A custom page whose content is a site: an iframe in the view, the site's origin allowed as a frame (MCP Apps CSP
 * `frameDomains`). A page on the app's own site (`embed`) is opened signed in: the view asks the app for a ticket
 * (`clegra_embed`, for this document's origin) over the host's bridge and posts it into the frame (spec §5.1).
 * A page on another site is framed as it is.
 */
export function urlPageHtml(title: string, url: string, embed: { tool: string; page: string } | null): string {
  const page = JSON.stringify({ url, embed }).replace(/</g, "\\u003c")
  const name = `${PROTOCOL_ID}-page`
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.replace(/[<&]/g, "")}</title><style>html,body{margin:0;height:100%;font:13px system-ui,sans-serif}iframe{border:0;width:100%;height:100vh;display:block}#status{position:fixed;top:8px;left:8px;right:8px;padding:6px 10px;border-radius:8px;background:#f5f5f7;color:#6e6e73;border:1px solid #e5e5ea}#status[hidden]{display:none}#status.error{color:#c62828;border-color:#c62828}</style></head><body><div id="status" role="status" aria-live="polite" hidden></div><iframe id="page" name="${name}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerpolicy="no-referrer" title="${title.replace(/"/g, "")}"></iframe><script>${URL_PAGE_SCRIPT.replace("__PAGE__", () => page)}</script></body></html>`
}
