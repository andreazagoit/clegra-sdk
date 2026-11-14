// The «Forecast» custom page: an MCP Apps view (plain HTML + the MCP Apps
// bridge). It reads open deals with tools/call through the host, which applies
// the caller's permissions; it has no network access of its own.
export const forecastHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Forecast</title>
<style>:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif)}body{margin:0;padding:16px;background:transparent;color:var(--color-text-primary,CanvasText)}
h2{margin:0 0 12px;font-size:18px}.row{display:grid;grid-template-columns:110px 1fr 48px;gap:10px;align-items:center;margin:6px 0}.total{font-size:28px;font-weight:600;margin-top:14px}.muted{opacity:.65;font-size:13px}</style></head>
<body><h2>Weighted forecast</h2><div id="sliders"></div><div class="total" id="total">…</div><div class="muted" id="note"></div>
<script>
(() => {
  const P = { lead: 10, qualified: 30, proposal: 60 };
  let deals = []; let id = 0; const pending = new Map();
  const post = (m) => parent.postMessage(m, "*");
  const req = (method, params) => new Promise((ok, ko) => { const i = ++id; pending.set(i, { ok, ko }); post({ jsonrpc: "2.0", id: i, method, params }); });
  addEventListener("message", (e) => { const m = e.data; if (m && m.jsonrpc === "2.0" && m.id !== undefined && pending.has(m.id) && !m.method) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.ko(m.error) : p.ok(m.result); } });
  const fmt = (n) => new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
  const draw = () => {
    const total = deals.reduce((s, d) => s + (d.value || 0) * (P[d.stage] || 0) / 100, 0);
    document.getElementById("total").textContent = fmt(total);
    document.getElementById("note").textContent = deals.length + " open deals";
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: document.body.scrollHeight + 16 } }, "*");
  };
  const sliders = document.getElementById("sliders");
  for (const s of Object.keys(P)) {
    const row = document.createElement("label"); row.className = "row";
    row.innerHTML = "<span>" + s + '</span><input type="range" min="0" max="100" value="' + P[s] + '"><span>' + P[s] + "%</span>";
    const input = row.querySelector("input"); input.oninput = () => { P[s] = Number(input.value); row.lastChild.textContent = input.value + "%"; draw(); };
    sliders.appendChild(row);
  }
  // The host's theme, not the system's: CanvasText follows color-scheme.
  const themed = (ctx) => { if (ctx && (ctx.theme === "dark" || ctx.theme === "light")) document.documentElement.style.colorScheme = ctx.theme; };
  addEventListener("message", (e) => { if (e.data && e.data.method === "ui/notifications/host-context-changed") themed(e.data.params); });
  req("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "crm-forecast", version: "1.0.0" }, appCapabilities: {} }).then(async (init) => {
    themed(init && init.hostContext);
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    const r = await req("tools/call", { name: "deal_list", arguments: { stage: { in: ["lead", "qualified", "proposal"] }, limit: 100 } });
    deals = (r && r.structuredContent && r.structuredContent.rows) || [];
    draw();
  }).catch((e) => { document.getElementById("note").textContent = "Couldn't read deals: " + (e.message || e); });
})();
</script></body></html>`
