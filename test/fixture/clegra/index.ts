import { AuthError, serve, type CallerResolver } from "@clegra/sdk"
import { createSignIn, MemorySignInStore, passwordLogin, type SignIn, type SignInAccount } from "@clegra/sdk/signin"

import { definition } from "./app"

// A tiny Clegra app for the real-Next test, with its own sign-in (the SDK's password login and sign-in module): the
// person signs in on the app's own page, also inside a workspace client's frame (the test's harness, FIXTURE_CLIENT),
// where its pages (app/board, app/notes) are shown (spec §5.1). One random bearer (FIXTURE_TOKEN) stands for an
// authorization server of the app's own (`auth.resolve`), enough to run `clegra check` with a token.
const base = process.env.CLEGRA_PUBLIC_URL ?? "http://127.0.0.1:3941"
const resource = `${base}/mcp`
const clientOrigins = process.env.FIXTURE_CLIENT ? [process.env.FIXTURE_CLIENT] : []

// One store and one login for the whole process (next dev may load this module more than once).
type Shared = { store: MemorySignInStore; login: ReturnType<typeof passwordLogin>; signIn: SignIn; seeded: Promise<unknown> }
const g = globalThis as { __fixture?: Shared }
if (!g.__fixture) {
  const store = new MemorySignInStore()
  const login = passwordLogin({ store, origin: base, title: { en: "Fixture notes" }, iterations: 1000, frameAncestors: clientOrigins })
  const keys = process.env.FIXTURE_SIGNIN_KEY ? [JSON.parse(process.env.FIXTURE_SIGNIN_KEY)] : undefined
  const signIn = createSignIn(definition, { issuer: base, resource, login, permissionsOf: (a) => login.permissionsOf(a), store, clientOrigins, keys })
  const seeded = process.env.FIXTURE_ACCOUNT ? login.accounts.create({ ...(JSON.parse(process.env.FIXTURE_ACCOUNT) as { email: string; password: string }), name: "Ada", installation: "org-a", permissions: "all" }) : Promise.resolve()
  g.__fixture = { store, login, signIn, seeded }
}
export const { login, signIn } = g.__fixture

const resolve: CallerResolver = (token, _request, info) => {
  if (!process.env.FIXTURE_TOKEN || token !== process.env.FIXTURE_TOKEN) return null
  if (info.resource !== resource) throw new AuthError("the token is for another server")
  return { installation: "org-a", person: { id: "u1", name: "Test person" }, permissions: "all" }
}

export const app = serve(definition, {
  auth: { resource, signIn, resolve },
  clientOrigins,
  ...(clientOrigins.length ? { site: { start: "/board" } } : {}),
})

/** Who is signed in on this page (the app's own session). */
export async function currentPerson(): Promise<SignInAccount | null> {
  const { headers } = await import("next/headers")
  const h = await headers()
  await g.__fixture!.seeded
  return login.session(new Request(base, { headers: { cookie: h.get("cookie") ?? "" } }))
}
