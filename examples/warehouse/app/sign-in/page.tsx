import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { demoSignInAction, signInAction } from "@/app/actions"
import { ActionForm } from "@/components/action-form"
import { COMPANIES, DEMO_USERS } from "@/lib/demo"
import { getViewer } from "@/lib/session"

export const metadata: Metadata = { title: "Sign in" }

export default async function SignInPage() {
  if (await getViewer()) redirect("/")
  const demo = process.env.DEMO_SIGNIN === "1"
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <div>
        <p className="text-sm font-medium text-accent">Warehouse</p>
        <h1 className="mt-1">Sign in</h1>
      </div>
      <ActionForm action={signInAction} submit="Sign in" className="card flex flex-col gap-3 p-4">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input name="email" type="email" autoComplete="username" required className="field" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input name="password" type="password" autoComplete="current-password" required className="field" />
        </label>
      </ActionForm>
      {demo ? (
        <section className="flex flex-col gap-2">
          <h2>Demo people</h2>
          {DEMO_USERS.map((u) => (
            <ActionForm key={u.email} action={demoSignInAction} quiet submit={`Enter as ${u.name} (${u.role}, ${COMPANIES[u.company].name})`}>
              <input type="hidden" name="email" value={u.email} />
            </ActionForm>
          ))}
        </section>
      ) : null}
    </main>
  )
}
