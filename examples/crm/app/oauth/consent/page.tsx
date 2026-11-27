import { verifyOAuthQueryParams } from "@better-auth/oauth-provider"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { auth } from "@/lib/auth"
import { oauthQueryOf, restartable, restartAuthorization, TOO_OLD_MESSAGE } from "@/lib/oauth-pages"
import { currentMember } from "@/lib/session"

import { buttonClass, Card, secondaryButtonClass } from "../../_components/ui"
import { consentAction } from "./actions"

export const metadata = { title: "Connect an app" }

const SCOPE_WORDS: Record<string, string> = {
  clegra: "Read and change the CRM's companies, contacts and deals, as you can",
  openid: "Know who you are",
  profile: "See your name",
  email: "See your email address",
  offline_access: "Stay connected until you disconnect it",
}

// better-auth's consent page (mcp({ consentPage })): who is asking, for which organization, to do what.
export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const oauthQuery = oauthQueryOf(sp)
  const requestHeaders = await headers()
  if (!oauthQuery) return <Message title="Nothing to connect">This page opens when an app asks to connect to your CRM. Start connecting from that app.</Message>
  // Opened after its ten minutes: the same authorization, signed anew (back here, or to the sign-in page).
  if (!(await verifyOAuthQueryParams(oauthQuery, (await auth().$context).secret))) {
    if (!restartable(oauthQuery)) return <Message title="This page is too old">{TOO_OLD_MESSAGE}</Message>
    redirect(restartAuthorization(oauthQuery, { signedIn: false }))
  }
  const member = await currentMember()
  if (!member) redirect(`/sign-in?${oauthQuery}`)
  const params = new URLSearchParams(oauthQuery)
  const clientId = params.get("client_id") ?? ""
  const client = (await auth().api.getOAuthClientPublic({ query: { client_id: clientId }, headers: requestHeaders }).catch(() => null)) as { client_name?: string; client_uri?: string } | null
  const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean)
  const name = client?.client_name || "An app"

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Connect {name} to the CRM?</h1>
      <p className="mb-6 text-zinc-500">
        Signed in as {member.user.name} ({member.user.email}).
      </p>
      <Card>
        <dl className="grid grid-cols-[7rem_1fr] gap-y-2" data-consent>
          <dt className="text-zinc-500">App</dt>
          <dd>
            <span className="font-medium" data-client-name>{name}</span>
            <span className="block break-all text-xs text-zinc-500" data-client-id>{clientId}</span>
            {client?.client_uri ? <span className="block break-all text-xs text-zinc-500">{client.client_uri}</span> : null}
          </dd>
          <dt className="text-zinc-500">Organization</dt>
          <dd className="font-medium" data-organization>{member.organizationName}</dd>
          <dt className="text-zinc-500">It may</dt>
          <dd>
            <ul className="list-disc pl-4">
              {scopes.map((s) => (
                <li key={s}>{SCOPE_WORDS[s] ?? s}</li>
              ))}
            </ul>
          </dd>
          {params.get("resource") ? (
            <>
              <dt className="text-zinc-500">At</dt>
              <dd className="break-all text-xs text-zinc-500">{params.get("resource")}</dd>
            </>
          ) : null}
        </dl>
        <p className="mt-4 text-xs text-zinc-500">It acts with your permissions in {member.organizationName}, never more. Only allow apps you trust.</p>
        <div className="mt-4 flex gap-2">
          <form action={consentAction.bind(null, oauthQuery, true)}>
            <button type="submit" className={buttonClass}>Allow</button>
          </form>
          <form action={consentAction.bind(null, oauthQuery, false)}>
            <button type="submit" className={secondaryButtonClass}>Deny</button>
          </form>
        </div>
      </Card>
    </main>
  )
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <h1 className="mb-2 text-xl font-semibold tracking-tight">{title}</h1>
      <p className="text-zinc-500">{children}</p>
    </main>
  )
}
