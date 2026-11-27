import type { App } from "./app"
import type { SessionReader } from "./confirm"
import type { Context, EntityHandle, Grant, PageHandle } from "./define"
import { localize } from "./labels"
import type { PageSession } from "./session"
import { escapeHtml, pageLocale } from "./signin/pages"

/**
 * GENERATED PAGES, for an app without a site of its own (`serve(app, { pages: "generated" })`): a record at its web
 * URL and the list pages of entities that have `list`, read-only, drawn from the definitions. They work opened
 * directly in any browser with the app's own sign-in (PAGE-1), or in a transferred session (session transfer).
 */

type Input = {
  app: App
  request: Request
  origin: string
  session: PageSession | null
  banner(session: PageSession): string
  sessions: SessionReader | undefined
  clientOrigins: string[]
  context(grant: Grant): Context
}

const STYLE = `:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--bg:#fff;--accent:#0a66d8}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--bg:#1c1c1e;--accent:#4c9bff}}
body{font:15px/1.45 system-ui,-apple-system,sans-serif;color:var(--fg);background:var(--bg);margin:0}
main{max-width:880px;margin:24px auto;padding:0 16px}h1{font-size:22px;margin:0 0 4px}.m{color:var(--muted)}
table{border-collapse:collapse;width:100%;margin-top:16px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:13px}a{color:var(--accent);text-decoration:none}.s{display:inline-block;padding:1px 8px;border:1px solid var(--line);border-radius:10px;font-size:12px}`

/** The grant a page session stands for: the app's own session reads and writes as the person; a transferred one has its grant's scopes. */
function grantOf(session: PageSession): Grant {
  if (session.transferred) return { id: session.transferred.grant, clientId: session.transferred.clientId, ...(session.transferred.clientName ? { clientName: session.transferred.clientName } : {}), person: session.person, scopes: session.transferred.scopes }
  return { id: `session:${session.person.id}`, clientId: "web", person: session.person, scopes: ["web.read", "web.write"] }
}

const frame = (allowed: boolean, origins: string[]) => (allowed && origins.length ? origins.join(" ") : "'none'")

function html(input: Input, title: string, body: string, framable: boolean, status = 200): Response {
  const lang = pageLocale(input.request, null, input.app.locale)
  const banner = input.session ? input.banner(input.session) : ""
  return new Response(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${banner}<main>${body}</main></body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      vary: "Cookie, Authorization",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors ${frame(framable, input.clientOrigins)}`,
    },
  })
}

function signIn(input: Input): Response {
  const url = new URL(input.request.url)
  const to = input.sessions?.signInUrl?.(url.pathname + url.search, input.request)
  if (to) return new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } })
  return html(input, "Sign in", `<p>Sign in to ${escapeHtml(localize(input.app.config.title, input.app.locale, input.app.locale))} to see this page.</p>`, false, 401)
}

const show = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v))

export async function renderRecord(input: Input & { entity: EntityHandle; vars: Record<string, string> }): Promise<Response> {
  if (!input.session) return signIn(input)
  const ctx = input.context(grantOf(input.session))
  const c = input.entity.config
  const row = (await c.get(input.vars, ctx)) as Record<string, unknown> | null
  const framable = [...input.app.pages.values()].some((p) => p.config.role === "record" && p.config.entity === input.entity && p.config.frame)
  if (!row) return html(input, ctx.t(c.title), `<h1>${escapeHtml(ctx.t(c.title))}</h1><p class="m">Not found.</p>`, framable, 404)
  const title = show(row[c.card.title])
  const subtitle = c.card.subtitle ? show(row[c.card.subtitle]) : ""
  const status = c.card.status ? show(row[c.card.status]) : ""
  const rows = Object.entries(row)
    .filter(([k]) => k !== c.card.title)
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(show(v))}</td></tr>`)
    .join("")
  return html(input, title, `<p class="m">${escapeHtml(ctx.t(c.title))}</p><h1>${escapeHtml(title)}</h1>${subtitle ? `<p class="m">${escapeHtml(subtitle)}</p>` : ""}${status ? `<span class="s">${escapeHtml(status)}</span>` : ""}<table>${rows}</table>`, framable)
}

export async function renderList(input: Input & { page: PageHandle; urlOf(entity: EntityHandle, record: Record<string, unknown>): string }): Promise<Response> {
  if (!input.session) return signIn(input)
  const ctx = input.context(grantOf(input.session))
  const p = input.page.config
  if (p.allow && !(await p.allow(ctx))) return html(input, ctx.t(p.title), `<p class="m">You may not open this page.</p>`, false, 403)
  const entity = p.entity!
  const c = entity.config
  const url = new URL(input.request.url)
  const out = await c.list!({ text: url.searchParams.get("q") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined, limit: 50 }, ctx)
  const roles = (["subtitle", "status", "date", "amount"] as const).filter((r) => c.card[r])
  const head = `<tr><th></th>${roles.map((r) => `<th>${escapeHtml(String(c.card[r]))}</th>`).join("")}</tr>`
  const body = out.rows
    .map((r) => {
      const row = r as Record<string, unknown>
      return `<tr><td><a href="${escapeHtml(input.urlOf(entity, row))}">${escapeHtml(show(row[c.card.title]))}</a></td>${roles.map((role) => `<td>${escapeHtml(show(row[c.card[role]!]))}</td>`).join("")}</tr>`
    })
    .join("")
  const next = out.next ? `<p><a href="?cursor=${encodeURIComponent(out.next)}">→</a></p>` : ""
  return html(input, ctx.t(p.title), `<h1>${escapeHtml(ctx.t(p.title))}</h1><table>${head}${body}</table>${next}`, Boolean(p.frame))
}
