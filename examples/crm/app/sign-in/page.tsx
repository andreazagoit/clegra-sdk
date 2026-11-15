import { redirect } from "next/navigation"

import { DEMO_USERS } from "@/lib/demo-data"
import { currentMember } from "@/lib/session"

import { buttonClass, Card, inputClass, Notice, param, secondaryButtonClass } from "../_components/ui"
import { demoSignInAction, signInAction } from "./actions"

export const metadata = { title: "Sign in" }

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (await currentMember()) redirect("/")
  const sp = await searchParams
  const demo = process.env.DEMO_SIGNIN === "1"
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">CRM</h1>
      <p className="mb-6 text-zinc-500">Sign in to your sales team.</p>
      <Notice error={param(sp.error)} />
      <Card>
        <form action={signInAction} className="flex flex-col gap-3">
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
