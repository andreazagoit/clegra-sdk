/**
 * A ready-made login for an app that has none: accounts with an email and a password (PBKDF2-SHA256), made by the
 * app (its administrator's screen, a command), and the app's own sign-in page at `/signin`. The session is a random
 * token in a frame-ready cookie (`frameCookie`), kept as a hash. It is the `login` of `createSignIn` (with `active`), and
 * the app's pages read the same session (`login.session(request)`). The sign-in page is never framed (ACC-4).
 */
import { frameCookie, frameCookieName, readCookie } from "./cookies"
import { hashPassword, PASSWORD_ITERATIONS, randomToken, sha256, verifyPassword } from "../crypto"
import { escapeHtml, hidden, page, pageLocale, textsOf } from "./pages"
import type { Person } from "../define"
import type { Login } from "./module"
import type { SignInStore } from "./store"

export type PasswordAccount = Person & { email: string; disabled?: boolean }

export type PasswordLoginOptions = {
  store: SignInStore
  /** The app's public origin: the session cookie is `Secure; SameSite=None; Partitioned` over https (and on a loopback address). */
  origin: string
  /** The app's title on the sign-in page, in its languages. */
  title: Record<string, string>
  locale?: string
  /** Where the sign-in page lives (default `/signin`; signing out: `<path>/out`). */
  path?: string
  sessionDays?: number
  /** PBKDF2 iterations (default 600 000; lower only in tests). */
  iterations?: number
}

export type PasswordLogin = Login & {
  accounts: {
    create(input: { email: string; name: string; password: string; tenant?: string }): Promise<PasswordAccount>
    update(id: string, input: Partial<{ name: string; password: string; disabled: boolean }>): Promise<PasswordAccount | null>
    remove(id: string): Promise<boolean>
    list(tenant?: string): Promise<PasswordAccount[]>
    get(id: string): Promise<PasswordAccount | null>
  }
  /** Whether the account still exists and is not disabled: give it to `createSignIn`'s `active`. */
  active(person: Person): Promise<boolean>
}

const COOKIE = "app_session"
const MIN_PASSWORD = 10
type StoredAccount = PasswordAccount & { hash: string }

export function passwordLogin(options: PasswordLoginOptions): PasswordLogin {
  const store = options.store
  const origin = new URL(options.origin).origin
  // Browsers treat a loopback address as a secure context: Secure (and partitioned) cookies work there too.
  const secure = new URL(origin).protocol === "https:" || /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)$/i.test(new URL(origin).hostname)
  const path = (options.path ?? "/signin").replace(/\/$/, "")
  const sessionMs = (options.sessionDays ?? 7) * 24 * 3600_000
  const iterations = options.iterations ?? PASSWORD_ITERATIONS
  const locale = options.locale ?? "en"
  const emailKey = (email: string) => `account-email:${email.trim().toLowerCase()}`
  const public_ = ({ hash: _h, ...a }: StoredAccount): PasswordAccount => a

  const byId = async (id: string) => (await store.get(`account:${id}`)) as StoredAccount | null
  const safeReturn = (value: string | null) => (value && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/")

  async function session(request: Request): Promise<Person | null> {
    const token = readCookie(request, frameCookieName(COOKIE, secure))
    if (!token) return null
    const s = (await store.get(`session:${await sha256(token)}`)) as { account: string } | null
    if (!s) return null
    const a = await byId(s.account)
    if (!a || a.disabled) return null
    return { id: a.id, name: a.name, email: a.email, ...(a.tenant ? { tenant: a.tenant } : {}) }
  }

  function signInPage(request: Request, returnTo: string, error = "", status = 200) {
    const l = pageLocale(request, null, locale)
    const t = textsOf(l)
    const appTitle = options.title[l] ?? options.title[locale] ?? Object.values(options.title)[0] ?? ""
    return page({
      title: t.signInTitle(appTitle),
      locale: l,
      status,
      frameAncestors: [],
      body: `<h1>${escapeHtml(t.signInTitle(appTitle))}</h1>${error ? `<p class="e">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${escapeHtml(path)}">${hidden({ return: returnTo })}
<label for="email">${escapeHtml(t.email)}</label><input id="email" name="email" type="email" autocomplete="username" required autofocus>
<label for="password">${escapeHtml(t.password)}</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<div class="b"><button class="p" type="submit">${escapeHtml(t.signIn)}</button></div></form>`,
    })
  }

  async function signIn(request: Request): Promise<Response> {
    const t = textsOf(pageLocale(request, null, locale))
    const sentFrom = request.headers.get("origin")
    if (sentFrom && sentFrom !== origin) return new Response("the sign-in comes from another site", { status: 403 })
    const form = new URLSearchParams(await request.text())
    const returnTo = safeReturn(form.get("return"))
    const email = (form.get("email") ?? "").trim().toLowerCase()
    // Five wrong attempts per address in 15 minutes; a right one is never counted.
    if (Number((await store.get(`#hit#signin:${email}`)) ?? 0) >= 5) return signInPage(request, returnTo, t.tooMany, 429)
    const id = (await store.get(emailKey(email))) as string | null
    const account = id ? await byId(id) : null
    // The same work whether the account exists or not: the answer's timing does not tell.
    const ok = await verifyPassword(form.get("password") ?? "", account?.hash ?? `pbkdf2-sha256$${iterations}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)
    if (!account || !ok || account.disabled) {
      await store.hit(`signin:${email}`, 15 * 60_000)
      return signInPage(request, returnTo, t.wrong, 401)
    }
    const token = randomToken()
    await store.set(`session:${await sha256(token)}`, { account: account.id }, sessionMs)
    return new Response(null, { status: 303, headers: { location: returnTo, "set-cookie": frameCookie({ name: COOKIE, value: token, secure, maxAgeSeconds: sessionMs / 1000 }), "cache-control": "no-store" } })
  }

  async function signOut(request: Request): Promise<Response> {
    const token = readCookie(request, frameCookieName(COOKIE, secure))
    if (token) await store.delete(`session:${await sha256(token)}`)
    return new Response(null, { status: 303, headers: { location: path, "set-cookie": frameCookie({ name: COOKIE, value: "", secure, maxAgeSeconds: 0 }), "cache-control": "no-store" } })
  }

  const checkPassword = (password: string) => {
    if (password.length < MIN_PASSWORD) throw new Error(`a password has at least ${MIN_PASSWORD} characters`)
  }

  return {
    session,
    signInUrl: (returnTo) => `${path}?return=${encodeURIComponent(returnTo)}`,
    async fetch(request) {
      const p = new URL(request.url).pathname
      if (p === path && request.method === "GET") return signInPage(request, safeReturn(new URL(request.url).searchParams.get("return")))
      if (p === path && request.method === "POST") return signIn(request)
      if (p === `${path}/out` && request.method === "POST") return signOut(request)
      return null
    },
    accounts: {
      async create(input) {
        const email = input.email.trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("not an email address")
        checkPassword(input.password)
        if (await store.get(emailKey(email))) throw new Error("an account with this email exists")
        const account: StoredAccount = { id: randomToken(12), email, name: input.name.trim() || email, ...(input.tenant ? { tenant: input.tenant } : {}), hash: await hashPassword(input.password, iterations) }
        await store.set(`account:${account.id}`, account, null)
        await store.set(emailKey(email), account.id, null)
        await store.set(`account-in:${encodeURIComponent(account.tenant ?? "")}:${account.id}`, account.id, null)
        return public_(account)
      },
      async update(id, input) {
        const a = await byId(id)
        if (!a) return null
        if (input.password !== undefined) checkPassword(input.password)
        const next: StoredAccount = { ...a, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.disabled !== undefined ? { disabled: input.disabled } : {}), ...(input.password !== undefined ? { hash: await hashPassword(input.password, iterations) } : {}) }
        await store.set(`account:${id}`, next, null)
        return public_(next)
      },
      async remove(id) {
        const a = await byId(id)
        if (!a) return false
        await store.delete(`account:${id}`)
        await store.delete(emailKey(a.email))
        await store.delete(`account-in:${encodeURIComponent(a.tenant ?? "")}:${id}`)
        return true
      },
      async list(tenant) {
        const out: PasswordAccount[] = []
        for (const { value } of await store.list(`account-in:${encodeURIComponent(tenant ?? "")}:`)) {
          const a = await byId(String(value))
          if (a) out.push(public_(a))
        }
        return out
      },
      async get(id) {
        const a = await byId(id)
        return a ? public_(a) : null
      },
    },
    async active(person) {
      const a = await byId(person.id)
      return Boolean(a && !a.disabled && (a.tenant ?? "") === (person.tenant ?? ""))
    },
  }
}
