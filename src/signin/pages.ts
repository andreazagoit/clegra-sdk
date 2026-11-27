// The sign-in module's own pages: the consent («Allow <client> to use <app> for you»), the password sign-in, the
// grants page and the error page. Plain HTML in the app's language, no script, never framed (access profile ACC-4).

import { randomToken } from "../crypto"

export type PageLocale = "en" | "it"

const TEXT = {
  en: {
    consentTitle: (client: string, app: string) => `Allow ${client} to use ${app} for you?`,
    consentLead: (app: string) => `It will act as you in ${app}, only with:`,
    consentFrom: "Who is asking, as its own document says:",
    consentRedirect: "It will receive the answer at:",
    unverified: "This application runs on a device or with a custom address: it cannot be verified. Allow it only if you started it yourself.",
    scope: {
      "web.read": "See your data",
      "web.write": "Change your data",
      "web.irreversible": "Ask you to confirm, on this app's own page, sends, payments, shares and deletions",
      bound_browser_session: "Open this app's pages signed in as you, inside the application",
      browser_session: "Give the assistant links that open this app signed in as you",
      offline_access: "Keep working while you are away",
    } as Record<string, string>,
    grantsTitle: (app: string) => `Who can use ${app} for you`,
    grantsNone: "No application can use your account.",
    grantsScopes: "Allowed",
    grantsCreated: "Since",
    grantsUsed: "Last used",
    grantsNever: "never",
    grantsBackground: "Works while you are away",
    grantsBrowser: "Can open the app's pages signed in as you",
    yes: "yes",
    no: "no",
    revoke: "Revoke",
    revoked: "Access revoked.",
    accessLog: "Download the access log",
    signedInAs: (name: string) => `Signed in as ${name}`,
    allow: "Allow",
    deny: "Cancel",
    consentFoot: (app: string) => `You can remove this access at any time in ${app}.`,
    signInTitle: (app: string) => `Sign in to ${app}`,
    email: "Email",
    password: "Password",
    signIn: "Sign in",
    wrong: "Wrong email or password.",
    tooMany: "Too many attempts: try again in a few minutes.",
    error: "This request cannot go on",
    nothingSent: "Nothing was sent to the client.",
  },
  it: {
    consentTitle: (client: string, app: string) => `Permetti a ${client} di usare ${app} per te?`,
    consentLead: (app: string) => `Agirà come te in ${app}, solo con:`,
    consentFrom: "Chi lo chiede, come dice il suo documento:",
    consentRedirect: "Riceverà la risposta a:",
    unverified: "Questa applicazione gira su un dispositivo o con un indirizzo personalizzato: non si può verificare. Consentilo solo se l'hai avviata tu.",
    scope: {
      "web.read": "Vedere i tuoi dati",
      "web.write": "Modificare i tuoi dati",
      "web.irreversible": "Chiederti di confermare, sulla pagina di questa app, invii, pagamenti, condivisioni ed eliminazioni",
      bound_browser_session: "Aprire le pagine di questa app con il tuo accesso, dentro l'applicazione",
      browser_session: "Dare all'assistente link che aprono questa app con il tuo accesso",
      offline_access: "Continuare a lavorare mentre non ci sei",
    } as Record<string, string>,
    grantsTitle: (app: string) => `Chi può usare ${app} per te`,
    grantsNone: "Nessuna applicazione può usare il tuo account.",
    grantsScopes: "Permesso",
    grantsCreated: "Dal",
    grantsUsed: "Ultimo uso",
    grantsNever: "mai",
    grantsBackground: "Lavora mentre non ci sei",
    grantsBrowser: "Può aprire le pagine dell'app con il tuo accesso",
    yes: "sì",
    no: "no",
    revoke: "Revoca",
    revoked: "Accesso revocato.",
    accessLog: "Scarica il registro degli accessi",
    signedInAs: (name: string) => `Accesso come ${name}`,
    allow: "Consenti",
    deny: "Annulla",
    consentFoot: (app: string) => `Puoi togliere questo accesso quando vuoi in ${app}.`,
    signInTitle: (app: string) => `Entra in ${app}`,
    email: "Email",
    password: "Password",
    signIn: "Entra",
    wrong: "Email o password errate.",
    tooMany: "Troppi tentativi: riprova tra qualche minuto.",
    error: "Questa richiesta non può andare avanti",
    nothingSent: "Al client non è stato inviato nulla.",
  },
} satisfies Record<PageLocale, Record<string, unknown>>

export const textsOf = (locale: PageLocale) => TEXT[locale]

/** The page's language: `ui_locales` first, then Accept-Language, then the app's. */
export function pageLocale(request: Request, asked: string | null, fallback: string): PageLocale {
  const wanted = [...(asked ?? "").split(/\s+/), ...(request.headers.get("accept-language") ?? "").split(",").map((p) => p.split(";")[0]!.trim()), fallback]
  for (const w of wanted) {
    const base = w.toLowerCase().split("-")[0]
    if (base === "it" || base === "en") return base
  }
  return "en"
}

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

const STYLE = `:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--bg:#fff;--accent:#0a66d8}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--bg:#1c1c1e;--accent:#4c9bff}}
body{font:15px/1.45 system-ui,-apple-system,sans-serif;color:var(--fg);background:var(--bg);max-width:440px;margin:48px auto;padding:0 16px}
h1{font-size:20px;line-height:1.3;margin:0 0 12px}p{margin:8px 0}.m{color:var(--muted);font-size:13px}.e{color:#c4122f}
ul{padding-left:20px;margin:8px 0 16px}.c{padding:10px 12px;border:1px solid var(--line);border-radius:10px;overflow-wrap:anywhere;margin:12px 0}
label{display:block;margin:12px 0 4px}input{font:inherit;padding:9px 10px;width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit}
.b{display:flex;gap:8px;margin-top:20px}button{font:inherit;padding:9px 16px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button.p{background:var(--accent);border-color:var(--accent);color:#fff}`

/** A page's security headers: no script unless a nonce is given, framable only by `frameAncestors`. */
export function pageHeaders(frameAncestors: string[], nonce?: string): Record<string, string> {
  const ancestors = frameAncestors.length ? frameAncestors.join(" ") : "'none'"
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // same-origin, not no-referrer: under no-referrer a form posted to the app itself says `Origin: null`, and the
    // sign-in and the consent check that their form comes from the app.
    "referrer-policy": "same-origin",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors ${ancestors}${nonce ? `; script-src 'nonce-${nonce}'` : ""}`,
  }
}

export function page(input: { title: string; body: string; locale: PageLocale; status?: number; frameAncestors: string[]; script?: string }): Response {
  const nonce = input.script ? randomToken(16) : undefined
  const script = input.script ? `<script nonce="${nonce}">${input.script}</script>` : ""
  const html = `<!doctype html><html lang="${input.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style>${STYLE}</style></head><body>${input.body}${script}</body></html>`
  return new Response(html, { status: input.status ?? 200, headers: pageHeaders(input.frameAncestors, nonce) })
}

export const hidden = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("")
