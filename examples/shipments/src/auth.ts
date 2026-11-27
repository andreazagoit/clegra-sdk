import type { AuthOptions } from "@clegra/sdk"
import { createSignIn, MemorySignInStore, passwordLogin, type PasswordLogin, type SignIn, type SignInApp, type SignInStore } from "@clegra/sdk/signin"

/**
 * WHO MAY CALL: the courier's customers' people, with the app's OWN sign-in (`@clegra/sdk/signin`). The courier has
 * no login of its own, so the SDK's password login is it: accounts are made by the courier (`login.accounts.create`,
 * one tenant per customer company), and any client (Clegra, Claude, ChatGPT) acts with a delegation the person gave
 * on the app's consent page, revocable here. Never an account of another system.
 *
 * SEVERAL COMPANIES PER SERVER: a courier hosts one server for all its customers. The tenant is the account's
 * `installation` (the customer company): two companies never reach each other's shipments.
 *
 *   SHIPMENTS_PUBLIC_URL   the app's public address (its MCP address is <url>/mcp; its sign-in at <url>/signin)
 *   SHIPMENTS_SIGNIN_KEY   the sign-in's signing key, a private Ed25519 JWK (`newSignInKey()`); required in production
 *   CLEGRA_CLIENT_ORIGINS  the workspace clients that may frame its consent (web_message), separated by commas
 */
export type ShipmentsAuth = { auth: AuthOptions & { resource: string }; signIn: SignIn; login: PasswordLogin }

export function shipmentsAuth(app: SignInApp, env: Record<string, string | undefined> = process.env, store: SignInStore = new MemorySignInStore()): ShipmentsAuth {
  const base = env.SHIPMENTS_PUBLIC_URL?.trim().replace(/\/+$/, "")
  if (!base) throw new Error("SHIPMENTS_PUBLIC_URL is not set: the app's public address (its MCP address is <SHIPMENTS_PUBLIC_URL>/mcp)")
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error(`SHIPMENTS_PUBLIC_URL: "${base}" is not an address`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`SHIPMENTS_PUBLIC_URL: "${base}" is not an http(s) address`)
  if (url.search || url.hash || url.pathname !== "/") throw new Error(`SHIPMENTS_PUBLIC_URL: "${base}" must be an origin, without a path, a query or a fragment`)
  const clientOrigins = (env.CLEGRA_CLIENT_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean)
  const keys = env.SHIPMENTS_SIGNIN_KEY ? [JSON.parse(env.SHIPMENTS_SIGNIN_KEY)] : undefined
  const login = passwordLogin({ store, origin: base, title: app.manifest().title, frameAncestors: clientOrigins })
  const signIn = createSignIn(app, { issuer: base, resource: `${base}/mcp`, login, permissionsOf: (a) => login.permissionsOf(a), store, clientOrigins, keys })
  return { auth: { signIn, resource: signIn.resource }, signIn, login }
}
