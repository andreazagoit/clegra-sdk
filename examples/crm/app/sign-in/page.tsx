import { verifyOAuthQueryParams } from "@better-auth/oauth-provider"
import { redirect } from "next/navigation"

import { auth } from "@/lib/auth"
import { DEMO_USERS } from "@/lib/demo-data"
import { oauthQueryOf, restartable, restartAuthorization, TOO_OLD_MESSAGE } from "@/lib/oauth-pages"
import { sessionMember } from "@/lib/session"

import { buttonClass, Card, inputClass, Notice, param, secondaryButtonClass } from "../_components/ui"
import { demoSignInAction, signInAction } from "./actions"

export const metadata = { title: "Sign in" }

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  // Opened by an OAuth authorization (an MCP client connecting): sign in here, then better-auth continues it.
  let oauthQuery = oauthQueryOf(sp)
  let error = param(sp.error)
  // Opened again after its ten minutes (a tab left open, a page restored): the same authorization, signed anew;
  // or, much later, the app has moved on: say so, and offer a plain sign-in.
  if (oauthQuery && !(await verifyOAuthQueryParams(oauthQuery, (await auth().$context).secret))) {
    if (restartable(oauthQuery)) redirect(restartAuthorization(oauthQuery, { signedIn: false }))
    oauthQuery = null
    error = TOO_OLD_MESSAGE
  }
  if (!oauthQuery && !error && (await sessionMember())) redirect("/")
  const demo = process.env.DEMO_SIGNIN === "1"
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">CRM</h1>
      <p className="mb-6 text-zinc-500">{oauthQuery ? "Sign in to connect an app to your CRM." : "Sign in to your sales team."}</p>
      <Notice error={error} />
      <Card>
        <form action={signInAction} className="flex flex-col gap-3">
          {oauthQuery ? <input type="hidden" name="oauth_query" value={oauthQuery} /> : null}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Email</span>
            <input name="email" type="email" autoComplete="email" required className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Password</span>
            <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
          </label>
          <button type="submit" className={buttonClass}>Sign in</button>
        </form>
      </Card>
      {demo ? (
        <Card title="Demo accounts" className="mt-4">
          <div className="flex flex-col gap-2">
            {DEMO_USERS.map((u) => (
              <form key={u.email} action={demoSignInAction.bind(null, u.email)}>
                {oauthQuery ? <input type="hidden" name="oauth_query" value={oauthQuery} /> : null}
                <button type="submit" className={`${secondaryButtonClass} w-full text-left`}>Enter as {u.label}</button>
              </form>
            ))}
          </div>
          <p className="mt-3 text-xs text-zinc-500">Invented people and data. The demo password stays on the server.</p>
        </Card>
      ) : null}
    </main>
  )
}
