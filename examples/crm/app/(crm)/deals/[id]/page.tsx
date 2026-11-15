import Link from "next/link"
import { notFound } from "next/navigation"

import { callsWith, getCompany, getDeal, listContacts, personNames } from "@/lib/crm"
import { formatDate, formatMoney, INDUSTRY_LABELS, STAGE_LABELS } from "@/lib/format"
import { requireMember } from "@/lib/session"

import { buttonClass, Card, inputClass, NoAccess, Notice, PageTitle, param, secondaryButtonClass, StageBadge } from "../../../_components/ui"
import { logCallAction, markWonAction, setStageAction } from "../../actions"

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }

export async function generateMetadata({ params }: Props) {
  const member = await requireMember()
  const deal = await getDeal(member.orgId, (await params).id)
  return { title: deal?.name ?? "Deal" }
}

const MOVABLE = ["lead", "qualified", "proposal", "lost"] as const

export default async function DealPage({ params, searchParams }: Props) {
  const member = await requireMember()
  if (!member.can("deals.view")) return <NoAccess what="deals" />
  const { id } = await params
  const sp = await searchParams
  const deal = await getDeal(member.orgId, id)
  if (!deal) notFound()
  const [company, contacts, owners] = await Promise.all([
    getCompany(member.orgId, deal.company),
    listContacts(member.orgId, { filters: { company: deal.company }, sort: { field: "name", dir: "asc" }, limit: 50 }),
    personNames(member.orgId, [deal.owner]),
  ])
  const calls = await callsWith(member.orgId, contacts.rows.map((c) => c.id), 10)
  const callers = await personNames(member.orgId, [...new Set(calls.map((c) => c.person))])
  const contactName = Object.fromEntries(contacts.rows.map((c) => [c.id, c.name]))
  const open = deal.stage !== "won" && deal.stage !== "lost"
  const edit = member.can("deals.edit") && open
  const here = `/deals/${deal.id}`

  return (
    <>
      <p className="mb-2"><Link href="/deals" className="text-zinc-500 hover:text-zinc-900">← Deals</Link></p>
      <PageTitle actions={<StageBadge stage={deal.stage} />}>{deal.name}</PageTitle>
      <Notice notice={param(sp.notice)} error={param(sp.error)} />
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Deal" className="md:col-span-2">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2">
            <dt className="text-zinc-500">Company</dt>
            <dd>{company ? `${company.name} · ${company.city} · ${INDUSTRY_LABELS[company.industry]}` : deal.company}</dd>
            <dt className="text-zinc-500">Stage</dt>
            <dd>{STAGE_LABELS[deal.stage]}</dd>
            {member.can("deals.values") ? (
              <>
                <dt className="text-zinc-500">Value</dt>
                <dd className="tabular-nums">{formatMoney(deal.value)}</dd>
              </>
            ) : null}
            <dt className="text-zinc-500">{open ? "Close date" : "Closed"}</dt>
            <dd>{formatDate(deal.closeDate)}</dd>
            <dt className="text-zinc-500">Owner</dt>
            <dd>{owners[deal.owner] ?? "Unknown person"}</dd>
            {deal.wonNote ? (
              <>
                <dt className="text-zinc-500">Won note</dt>
                <dd>{deal.wonNote}</dd>
              </>
            ) : null}
          </dl>
        </Card>
        <Card title="Change">
          {edit ? (
            <div className="flex flex-col gap-4">
              <form action={setStageAction.bind(null, deal.id)} className="flex items-center gap-2">
                <input type="hidden" name="returnTo" value={here} />
                <select name="stage" defaultValue={deal.stage} className={inputClass} aria-label="New stage">
                  {MOVABLE.map((s) => (
                    <option key={s} value={s}>{STAGE_LABELS[s]}</option>
                  ))}
                </select>
                <button type="submit" className={secondaryButtonClass}>Move</button>
              </form>
              <form action={markWonAction.bind(null, deal.id)} className="flex flex-col gap-2">
                <input type="hidden" name="returnTo" value={here} />
                <input name="note" maxLength={500} placeholder="Note (optional)" className={inputClass} />
                <button type="submit" className={buttonClass}>Mark as won</button>
              </form>
            </div>
          ) : (
            <p className="text-zinc-500">{open ? "You can't change deals." : "This deal is closed."}</p>
          )}
        </Card>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card title={`Contacts at ${company?.name ?? "the company"}`}>
          <ul className="flex flex-col gap-3">
            {contacts.rows.map((c) => (
              <li key={c.id} className="flex flex-col gap-1">
                <span><span className="font-medium">{c.name}</span> <span className="text-zinc-500">{c.email}</span></span>
                <span className="text-xs text-zinc-500">{c.lastCall ? `Last call ${formatDate(c.lastCall)}` : "Never called"}</span>
                {member.can("contacts.edit") ? (
                  <form action={logCallAction.bind(null, c.id)} className="flex gap-2">
                    <input type="hidden" name="returnTo" value={here} />
                    <input name="note" required maxLength={500} placeholder="What was said" className={`${inputClass} flex-1`} aria-label={`Call note for ${c.name}`} />
                    <button type="submit" className={secondaryButtonClass}>Log call</button>
                  </form>
                ) : null}
              </li>
            ))}
            {contacts.rows.length === 0 ? <li className="text-zinc-500">No contacts yet.</li> : null}
          </ul>
        </Card>
        <Card title="Recent calls">
          {calls.length ? (
            <ul className="divide-y divide-zinc-100">
              {calls.map((call) => (
                <li key={call.id} className="py-2">
                  <span className="text-zinc-500">{formatDate(call.calledOn)} · {contactName[call.contact]} · {callers[call.person] ?? "Unknown person"}</span>
                  {call.note ? <p>{call.note}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-zinc-500">No calls yet.</p>
          )}
        </Card>
      </div>
    </>
  )
}
