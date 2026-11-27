import { MemoryStore, serve, type PageSession, type ServedApp } from "@clegra/sdk"
import { createSignIn, MemorySignInStore, passwordLogin, type SignIn } from "@clegra/sdk/signin"

import { definition } from "./app"

// A tiny Clegra app for the real-Next test, with its own sign-in (the SDK's password login and sign-in module). The
// test's OAuth client is a Client ID Metadata Document the fixture "fetches" in process (FIXTURE_CLIENT_ID), so no
// https server is needed: everything else is the real flow (sign-in page, consent, code, token with PKCE).
const base = process.env.CLEGRA_PUBLIC_URL ?? "http://127.0.0.1:3941"
const clientId = process.env.FIXTURE_CLIENT_ID
const redirect = process.env.FIXTURE_REDIRECT

// One of everything for the whole process (next dev may load this module more than once).
type Shared = { login: ReturnType<typeof passwordLogin>; signIn: SignIn; served: ServedApp; seeded: Promise<unknown> }
const g = globalThis as { __fixture?: Shared }
if (!g.__fixture) {
  const store = new MemorySignInStore()
  const login = passwordLogin({ store, origin: base, title: { en: "Fixture notes" }, iterations: 1000 })
  const keys = process.env.FIXTURE_SIGNIN_KEY ? [JSON.parse(process.env.FIXTURE_SIGNIN_KEY)] : undefined
  const signIn = createSignIn(definition, {
    issuer: base,
    resource: `${base}/mcp`,
    login,
    active: (p) => login.active(p),
    store,
    ...(keys ? { keys } : {}),
    clientMetadata: {
      lookup: async () => ["93.184.215.14"],
      fetch: async (url) => (String(url) === clientId ? Response.json({ client_id: clientId, client_name: "Test client", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) : new Response("not found", { status: 404 })),
    },
  })
  const served = serve(definition, { origin: base, auth: { signIn }, store: new MemoryStore(), confirmWaitMs: 0 })
  const seeded = process.env.FIXTURE_ACCOUNT ? login.accounts.create({ ...(JSON.parse(process.env.FIXTURE_ACCOUNT) as { email: string; password: string }), name: "Ada" }) : Promise.resolve()
  g.__fixture = { login, signIn, served, seeded }
}
export const { served } = g.__fixture

/** Who is signed in on this page: the app's own session or a transferred one (session transfer). */
export async function currentSession(path: string): Promise<{ session: PageSession | null; banner: string }> {
  const { headers } = await import("next/headers")
  const h = await headers()
  await g.__fixture!.seeded
  const request = new Request(`${base}${path}`, { headers: { cookie: h.get("cookie") ?? "" } })
  const session = await served.session(request)
  return { session, banner: session ? served.banner(session, request) : "" }
}
