// The «StageFunnel» component (spec §5.4 rule 6): one of the CRM's own A2UI components, a page drawn inside any
// A2UI surface (an answer, a home widget, a dashboard). The host gives it everything: the props
// (ui/notifications/tool-result's structuredContent), the theme, the language and the app's accent (host context).
// It reads nothing itself and has no network access; it reports its height so the host sizes the block.
export const funnelHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stage funnel</title>
<style>
:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif);--bar:var(--clegra-app-accent,#3b82f6)}
html,body{margin:0;background:transparent;color:var(--color-text-primary,CanvasText)}
body{padding:2px 0 4px}
.row{display:grid;grid-template-columns:minmax(72px,30%) 1fr auto;gap:10px;align-items:center;margin:0 0 8px;font-size:13px}
.track{height:22px;border-radius:6px;background:var(--color-background-tertiary,rgba(127,127,127,.12));overflow:hidden}
.bar{height:100%;border-radius:6px;background:var(--bar);min-width:4px;transition:width .3s ease}
.label{color:var(--color-text-secondary,GrayText);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.figure{font-variant-numeric:tabular-nums;text-align:right;min-width:3ch}
.money{display:block;font-size:11px;color:var(--color-text-secondary,GrayText)}
.empty{font-size:13px;color:var(--color-text-secondary,GrayText)}
</style></head>
<body><div id="funnel"></div>
<script>
(() => {
  let id = 0; const pending = new Map(); let props = null; let locale = "en";
  const post = (m) => parent.postMessage(m, "*");
  const req = (method, params) => new Promise((ok, ko) => { const i = ++id; pending.set(i, { ok, ko }); post({ jsonrpc: "2.0", id: i, method, params }); });
  const WORDS = { en: { empty: "No deals yet" }, it: { empty: "Ancora nessuna trattativa" } };
  const words = () => WORDS[String(locale).slice(0, 2)] || WORDS.en;
  // The host's look: its standard variables, the accent among Clegra's own (--clegra-…).
  const themed = (ctx) => {
    if (!ctx) return;
    if (ctx.theme === "dark" || ctx.theme === "light") document.documentElement.style.colorScheme = ctx.theme;
    if (typeof ctx.locale === "string") locale = ctx.locale;
    const vars = Object.assign({}, ctx.styles && ctx.styles.variables, ctx._meta && ctx._meta["clegra/ui"] && ctx._meta["clegra/ui"].variables);
    for (const [k, v] of Object.entries(vars)) if (/^--[a-z0-9-]+$/.test(k) && typeof v === "string") document.documentElement.style.setProperty(k, v);
  };
  const size = () => post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: Math.ceil(document.body.getBoundingClientRect().height) } });
  const draw = () => {
    const root = document.getElementById("funnel");
    root.textContent = "";
    const stages = props && Array.isArray(props.stages) ? props.stages : [];
    const top = Math.max(1, ...stages.map((s) => Number(s.count) || 0));
    if (!stages.some((s) => s.count > 0)) { const p = document.createElement("p"); p.className = "empty"; p.textContent = words().empty; root.append(p); }
    else for (const s of stages) {
      const row = document.createElement("div"); row.className = "row";
      const label = document.createElement("span"); label.className = "label"; label.textContent = String(s.label);
      const track = document.createElement("div"); track.className = "track";
      const bar = document.createElement("div"); bar.className = "bar"; bar.style.width = (100 * (Number(s.count) || 0) / top) + "%"; track.append(bar);
      const figure = document.createElement("span"); figure.className = "figure"; figure.textContent = new Intl.NumberFormat(locale).format(Number(s.count) || 0);
      if (typeof s.value === "number") { const m = document.createElement("span"); m.className = "money"; m.textContent = new Intl.NumberFormat(locale, { style: "currency", currency: props.currency || "EUR", maximumFractionDigits: 0 }).format(s.value); figure.append(m); }
      row.append(label, track, figure); root.append(row);
    }
    size();
  };
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data; if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.ko(m.error) : p.ok(m.result); return; }
    if (m.method === "ui/notifications/tool-result") { props = (m.params && m.params.structuredContent) || null; draw(); }
    if (m.method === "ui/notifications/host-context-changed") { themed(m.params); draw(); }
  });
  new ResizeObserver(size).observe(document.body);
  req("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "crm-stage-funnel", version: "1.0.0" }, appCapabilities: {} }).then((init) => {
    themed(init && init.hostContext);
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  });
})();
</script></body></html>`
