import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { consentAction } from "@/app/actions"
import { ActionForm } from "@/components/action-form"
import { getAuth } from "@/lib/auth"
import { oauthQueryOf } from "@/lib/auth-http"
import { getViewer } from "@/lib/session"

export const metadata: Metadata = { title: "Connect an app" }

const SCOPES: Record<string, string> = {
  modelapp: "Use the warehouse for you: see products, movements and orders, and make the changes your role allows (it asks before changes)",
  openid: "Know who you are",
  profile: "See your name",
  email: "See your email address",
  offline_access: "Stay connected until you disconnect it",
}

/**
 * better-auth's consent page (mcp plugin `consentPage`): who is asking, for which organization, and what for.
 * The page carries the signed authorization request (`…&sig=…`); the answer goes to /oauth2/consent.
 */
export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const oauthQuery = oauthQueryOf(sp)
  const viewer = await getViewer()
  if (!viewer) redirect(oauthQuery ? `/sign-in?${oauthQuery}` : "/sign-in")
  if (!oauthQuery || typeof sp.client_id !== "string") return <Shell><p className="text-sm text-stone-600">This page is part of connecting an app; open it from the app that asks.</p></Shell>
  const clientId = sp.client_id
  const client = (await (await getAuth()).api.getOAuthClientPublic({ query: { client_id: clientId }, headers: await headers() }).catch(() => null)) as { client_name?: string; client_uri?: string } | null
  const scopes = (typeof sp.scope === "string" ? sp.scope : "").split(" ").filter(Boolean)
  const name = client?.client_name ?? "An unnamed app"
  return (
    <Shell>
      <h1>
        Connect {name} to {viewer.orgName}?
      </h1>
      <dl className="card grid gap-3 p-4 text-sm">
        <div>
          <dt className="text-xs text-stone-500">App</dt>
          <dd className="mt-0.5 font-medium">{name}</dd>
          <dd className="break-all font-mono text-xs text-stone-500">{clientId}</dd>
          {client?.client_uri ? <dd className="break-all text-xs text-stone-500">{client.client_uri}</dd> : null}
        </div>
        <div>
          <dt className="text-xs text-stone-500">Organization</dt>
          <dd className="mt-0.5 font-medium">
            {viewer.orgName} <span className="font-normal text-stone-500">· as {viewer.name} ({viewer.role})</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">It may</dt>
          <dd>
            <ul className="mt-1 list-disc pl-5 text-stone-700">
              {scopes.map((s) => (
                <li key={s}>{SCOPES[s] ?? s}</li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
      <div className="flex gap-3">
        <ActionForm action={consentAction} submit="Allow">
          <input type="hidden" name="oauth_query" value={oauthQuery} />
          <input type="hidden" name="decision" value="accept" />
        </ActionForm>
        <ActionForm action={consentAction} submit="Deny" quiet>
          <input type="hidden" name="oauth_query" value={oauthQuery} />
          <input type="hidden" name="decision" value="deny" />
        </ActionForm>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 px-4 py-10">{children}</main>
}
