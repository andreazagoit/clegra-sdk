/**
 * THE SDK'S MCP APPS VIEW (spec §12): one HTML document that draws every
 * derived result (a list, a record, a fragment, a dashboard) for hosts that
 * show MCP Apps views: ChatGPT, Claude, and a workspace host's frames.
 *
 * It speaks the MCP Apps bridge (JSON-RPC 2.0 over postMessage:
 * `ui/initialize`, `ui/notifications/tool-result`, `tools/call`,
 * `ui/notifications/size-changed`) and, where present, ChatGPT's
 * `window.openai` (toolOutput, callTool). Data arrives as the tool result's
 * `structuredContent`; a page opened with no tool call (`boot`) asks for its
 * own data with `tools/call`. No network access: the host relays every call,
 * with its permissions and confirmations.
 */

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
dl{display:grid;grid-template-columns:minmax(90px,max-content) 1fr;gap:6px 14px;margin:8px 0}dt{color:var(--fg2)}dd{margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.stat{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}
button{font:inherit;border:1px solid var(--line);background:var(--bg2);color:var(--fg);border-radius:8px;padding:5px 12px;cursor:pointer}button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.actions{margin-top:10px}
form.act{margin-top:8px;display:grid;gap:6px}input,select,textarea{font:inherit;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.bar{display:grid;grid-template-columns:minmax(70px,max-content) 1fr max-content;gap:6px 10px;align-items:center}.bar i{display:block;height:10px;background:var(--accent);border-radius:4px}
.msg{margin-top:8px;font-size:13px}.err{color:#c62828}
`

const SCRIPT = `
(() => {
  const BOOT = __BOOT__;
  const root = document.getElementById("root");
  let nextId = 1; const pending = new Map(); let gotResult = false; let locale = navigator.language || "en";
  const post = (m) => window.parent.postMessage(m, "*");
  const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); post({ jsonrpc: "2.0", id, method, params }); });
  const notify = (method, params) => post({ jsonrpc: "2.0", method, params });
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const callTool = async (name, args) => {
    if (window.openai && typeof window.openai.callTool === "function") return window.openai.callTool(name, args);
    return request("tools/call", { name, arguments: args });
  };
  let refs = {};
  const fmt = (v, col) => {
    if (col && col.ref && refs[col.name] && refs[col.name][v]) return esc(refs[col.name][v]);
    if (v === null || v === undefined || v === "") return '<span class="muted">—</span>';
    if (col && col.role === "amount" && typeof v === "number") { try { return esc(new Intl.NumberFormat(locale, { style: "currency", currency: col.currency || "EUR" }).format(v)); } catch { return esc(v); } }
    if (col && col.role === "date" && typeof v === "string" && /^\\d{4}-\\d{2}-\\d{2}/.test(v)) { try { return esc(new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(v.length === 10 ? v + "T12:00:00" : v))); } catch { return esc(v); } }
    if (col && col.enum && col.labels) { const label = col.labels[v] ?? v; const tone = col.tones && col.tones[v]; return col.role === "status" ? '<span class="badge ' + (tone ? "t-" + tone : "") + '">' + esc(label) + "</span>" : esc(label); }
    if (typeof v === "number") return esc(new Intl.NumberFormat(locale).format(v));
    if (typeof v === "boolean") return v ? "✓" : "—";
    if (typeof v === "object") return esc(JSON.stringify(v));
    return esc(v);
  };
  const resize = () => notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  const say = (el, text, error) => { let m = el.querySelector(":scope > .msg"); if (!m) { m = document.createElement("div"); m.className = "msg"; el.appendChild(m); } m.className = "msg" + (error ? " err" : ""); m.textContent = text; resize(); };
  const resultOf = (r) => (r && r.structuredContent) || (r && r.result && r.result.structuredContent) || r || {};
  const errorOf = (r) => { const s = resultOf(r); return (r && r.isError) ? ((s.error && s.error.message) || (r.content && r.content[0] && r.content[0].text) || "Failed") : null; };

  function actionForm(container, action, record) {
    const props = (action.input && action.input.properties) || {};
    const keys = Object.keys(props).filter((k) => k !== "id");
    const run = async (args) => {
      try { const r = await callTool(action.tool, Object.assign({}, record ? { id: record.id } : {}, args)); const e = errorOf(r); if (e) return say(container, e, true); const s = resultOf(r); say(container, s.message || "Done."); if (record && s.record) reload(); }
      catch (e) { say(container, String(e && e.message || e), true); }
    };
    if (!keys.length) return run({});
    const f = document.createElement("form"); f.className = "act";
    f.innerHTML = keys.map((k) => { const p = props[k]; const label = esc(p.title || k);
      if (Array.isArray(p.enum)) return "<label>" + label + '<br><select name="' + esc(k) + '">' + p.enum.map((v) => "<option>" + esc(v) + "</option>").join("") + "</select></label>";
      if (p.type === "boolean") return '<label><input type="checkbox" name="' + esc(k) + '"> ' + label + "</label>";
      return "<label>" + label + '<br><input name="' + esc(k) + '" type="' + (p.type === "number" || p.type === "integer" ? "number" : p.format === "date" ? "date" : "text") + '"></label>'; }).join("") + '<div class="row"><button class="primary" type="submit">' + esc(action.title) + "</button></div>";
    f.onsubmit = (e) => { e.preventDefault(); const args = {}; for (const k of keys) { const el = f.elements[k]; const p = props[k]; if (!el) continue; if (p.type === "boolean") args[k] = el.checked; else if (el.value !== "") args[k] = (p.type === "number" || p.type === "integer") ? Number(el.value) : el.value; } f.remove(); run(args); };
    container.appendChild(f); resize();
  }
  function actionsBar(el, actions, record) {
    if (!actions || !actions.length) return;
    const bar = document.createElement("div"); bar.className = "row actions";
    for (const a of actions) { const b = document.createElement("button"); b.textContent = a.title; b.onclick = () => actionForm(el, a, record); bar.appendChild(b); }
    el.appendChild(bar);
  }
  let lastCall = null;
  const reload = async () => { if (!lastCall) return; const r = await callTool(lastCall.name, lastCall.args); render(resultOf(r)); };

  function recordBox(view, record) {
    const el = document.createElement("div"); el.className = "box";
    const title = view.fields.find((f) => f.role === "title");
    el.innerHTML = "<h2>" + esc(record[title ? title.name : "id"]) + "</h2><dl>" + view.fields.filter((f) => f.name !== "id" && f.role !== "title" && record[f.name] !== undefined).map((f) => "<dt>" + esc(f.label) + "</dt><dd>" + fmt(record[f.name], f) + "</dd>").join("") + "</dl>";
    actionsBar(el, view.actions, record);
    return el;
  }
  function fragmentBox(fr) {
    const el = document.createElement("div"); el.className = "box";
    const d = fr.data || {};
    if (fr.state && fr.state !== "ok") { el.innerHTML = '<span class="muted">' + esc(fr.state === "no-access" ? "No access" : "Not available") + "</span>"; return el; }
    if (fr.template === "record" && fr.view) return recordBox(fr.view, fr.data);
    let h = fr.title ? "<h3>" + esc(fr.title) + "</h3>" : "";
    if (fr.template === "stat") { const v = typeof d.value === "number" ? (d.format === "money" ? new Intl.NumberFormat(locale, { style: "currency", currency: d.currency || "EUR" }).format(d.value) : d.format === "percent" ? new Intl.NumberFormat(locale, { style: "percent" }).format(d.value) : new Intl.NumberFormat(locale).format(d.value)) : d.value; h += '<div class="muted">' + esc(d.label) + '</div><div class="stat">' + esc(v) + "</div>" + (d.hint ? '<div class="muted">' + esc(d.hint) + "</div>" : ""); }
    else if (fr.template === "card") h += "<h2>" + esc(d.title) + "</h2>" + (d.subtitle ? '<div class="muted">' + esc(d.subtitle) + "</div>" : "") + (d.status ? '<span class="badge">' + esc(d.status) + "</span>" : "") + "<dl>" + (d.fields || []).map((f) => "<dt>" + esc(f.label) + "</dt><dd>" + esc(f.value) + "</dd>").join("") + "</dl>";
    else if (fr.template === "list") h += (d.items || []).map((i) => "<div style='padding:6px 0;border-bottom:1px solid var(--line)'><b>" + esc(i.title) + "</b>" + (i.status ? ' <span class="badge">' + esc(i.status) + "</span>" : "") + (i.subtitle ? '<div class="muted">' + esc(i.subtitle) + "</div>" : "") + "</div>").join("") || '<span class="muted">—</span>';
    else if (fr.template === "chart") { const pts = d.points || []; const max = Math.max(1, ...pts.map((p) => Math.abs(Number(p.value) || 0))); h += '<div class="bar">' + pts.map((p) => "<span>" + esc(p.label) + '</span><i style="width:' + Math.round((Math.abs(Number(p.value) || 0) / max) * 100) + '%"></i><span class="muted">' + esc(d.format === "money" ? new Intl.NumberFormat(locale, { style: "currency", currency: d.currency || "EUR", maximumFractionDigits: 0 }).format(p.value) : p.value) + "</span>").join("") + "</div>"; }
    else h += "<pre>" + esc(JSON.stringify(d, null, 2)) + "</pre>";
    el.innerHTML = h;
    actionsBar(el, fr.actions, null);
    return el;
  }
  function render(s) {
    gotResult = true;
    refs = (s && s.refs) || {};
    const v = s && s.view;
    root.innerHTML = "";
    if (s && s.error) { root.innerHTML = '<div class="box err">' + esc(s.error.message || s.error.code) + "</div>"; return resize(); }
    if (!v) { root.innerHTML = '<div class="box muted">' + esc(JSON.stringify(s)) + "</div>"; return resize(); }
    if (v.kind === "list") {
      const box = document.createElement("div"); box.className = "box";
      const cols = v.columns;
      box.innerHTML = "<h2>" + esc(v.title) + (typeof s.total === "number" ? ' <span class="muted">· ' + esc(s.total) + "</span>" : "") + "</h2>" +
        "<table><thead><tr>" + cols.map((c) => "<th>" + esc(c.label) + "</th>").join("") + "</tr></thead><tbody>" +
        (s.rows || []).map((r, i) => '<tr class="link" data-i="' + i + '">' + cols.map((c) => "<td" + (c.role === "amount" || c.type === "number" ? ' class="num"' : "") + ">" + fmt(r[c.name], c) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table>" + ((s.rows || []).length ? "" : '<p class="muted">—</p>');
      box.querySelectorAll("tr.link").forEach((tr) => tr.onclick = async () => { const row = s.rows[Number(tr.dataset.i)]; lastCall = { name: v.getTool, args: { id: row.id } }; const r = await callTool(v.getTool, { id: row.id }); render(resultOf(r)); });
      if (s.next && v.tool) { const more = document.createElement("button"); more.textContent = "…"; more.style.marginTop = "8px"; more.onclick = async () => { const r = await callTool(v.tool, Object.assign({}, v.args || {}, { cursor: s.next })); render(resultOf(r)); }; box.appendChild(more); }
      root.appendChild(box);
    } else if (v.kind === "record") {
      root.appendChild(recordBox(v, s.record));
    } else if (v.kind === "fragment") {
      root.appendChild(fragmentBox(Object.assign({ title: v.title }, s)));
    } else if (v.kind === "dashboard") {
      const h = document.createElement("h2"); h.textContent = v.title; root.appendChild(h);
      const g = document.createElement("div"); g.className = "grid"; for (const fr of s.fragments || []) g.appendChild(fragmentBox(fr)); root.appendChild(g);
    } else if (v.kind === "search") {
      const box = document.createElement("div"); box.className = "box";
      box.innerHTML = (s.results || []).map((r) => "<div style='padding:6px 0;border-bottom:1px solid var(--line)'><b>" + esc(r.title) + "</b> <span class='muted'>" + esc(r.entityLabel || "") + "</span>" + (r.subtitle ? "<div class='muted'>" + esc(r.subtitle) + "</div>" : "") + "</div>").join("") || '<span class="muted">—</span>';
      root.appendChild(box);
    }
    resize();
  }
  const applyContext = (ctx) => { if (!ctx) return; if (ctx.theme) document.documentElement.dataset.theme = ctx.theme; if (ctx.locale) locale = ctx.locale; const vars = ctx.styles && ctx.styles.variables; if (vars) for (const [k, v] of Object.entries(vars)) if (v) document.documentElement.style.setProperty(k, v); };
  window.addEventListener("message", (e) => {
    const m = e.data; if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && pending.has(m.id) && !m.method) { const p = pending.get(m.id); pending.delete(m.id); return m.error ? p.reject(new Error(m.error.message || "error")) : p.resolve(m.result); }
    if (m.method === "ui/notifications/tool-result") { const s = resultOf(m.params); if (s && s.view) render(s); else if (!BOOT) render(s); return; }
    if (m.method === "ui/notifications/tool-input") { if (m.params && m.params.arguments && lastCall === null && BOOT === null) lastCall = null; return; }
    if (m.method === "ui/notifications/host-context-changed") { applyContext(m.params); return; }
    if (m.method === "ui/resource-teardown" && m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, result: {} });
  });
  const boot = async () => {
    if (BOOT && !gotResult) { lastCall = { name: BOOT.tool, args: BOOT.args || {} }; try { const r = await callTool(BOOT.tool, BOOT.args || {}); const e = errorOf(r); if (e) { root.innerHTML = '<div class="box err">' + esc(e) + "</div>"; resize(); } else render(resultOf(r)); } catch (e) { root.innerHTML = '<div class="box err">' + esc(e.message || e) + "</div>"; resize(); } }
  };
  if (window.openai && window.openai.toolOutput) { render(window.openai.toolOutput); }
  window.addEventListener("openai:set_globals", () => { if (window.openai && window.openai.toolOutput) render(window.openai.toolOutput); });
  request("ui/initialize", { protocolVersion: "${MCP_APPS_PROTOCOL_VERSION}", appInfo: { name: "mcpw-view", version: "1.0.0" }, appCapabilities: {} })
    .then((r) => { applyContext(r && r.hostContext); notify("ui/notifications/initialized", {}); setTimeout(boot, 250); resize(); })
    .catch(() => setTimeout(boot, 0));
  new ResizeObserver(resize).observe(document.body);
})();
`

/** The view document; `boot` names the tool a page calls for its own data when no tool result opens it. */
export function viewHtml(title: string, boot: { tool: string; args?: Record<string, unknown> } | null = null): string {
  const bootJson = JSON.stringify(boot).replace(/</g, "\\u003c")
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.replace(/[<&]/g, "")}</title><style>${STYLE}</style></head><body><div id="root"><div class="box muted">…</div></div><script>${SCRIPT.replace("__BOOT__", bootJson)}</script></body></html>`
}

/** A custom page whose content is the developer's own site: an iframe in the view, the site's origin allowed as a frame. */
export function urlPageHtml(title: string, url: string): string {
  const safe = url.replace(/"/g, "&quot;")
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/[<&]/g, "")}</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100vh;display:block}</style></head><body><iframe src="${safe}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerpolicy="no-referrer" title="${title.replace(/"/g, "")}"></iframe><script>window.parent.postMessage({jsonrpc:"2.0",id:1,method:"ui/initialize",params:{protocolVersion:"${MCP_APPS_PROTOCOL_VERSION}",appInfo:{name:"mcpw-url-page",version:"1.0.0"},appCapabilities:{}}},"*");addEventListener("message",e=>{if(e.data&&e.data.id===1){window.parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/initialized",params:{}},"*");window.parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:720}},"*")}})</script></body></html>`
}
