import Link from "next/link"

import { companyNames, listCompanies, listDeals, personNames, STAGES, type ListQuery, type Stage } from "@/lib/crm"
import { formatDate, formatMoney, STAGE_LABELS } from "@/lib/format"
import { requireMember } from "@/lib/session"

import { buttonClass, Card, inputClass, NoAccess, Notice, PageTitle, param, secondaryButtonClass, StageBadge, Td, TextLink, Th } from "../../_components/ui"
import { createDealAction } from "../actions"

export const metadata = { title: "Deals" }

const PAGE_SIZE = 20
type Search = Promise<Record<string, string | string[] | undefined>>

export default async function DealsPage({ searchParams }: { searchParams: Search }) {
  const member = await requireMember()
  if (!member.can("deals.view")) return <NoAccess what="deals" />
  const sp = await searchParams
  const q = param(sp.q)?.trim() ?? ""
  const stage = STAGES.find((s) => s === param(sp.stage))
  const money = member.can("deals.values")
  // Sorting by value is for people who may see values.
  const sortable = money ? (["value", "closeDate"] as const) : (["closeDate"] as const)
  const sort = sortable.find((f) => f === param(sp.sort))
  const dir = param(sp.dir) === "desc" ? "desc" : "asc"
  const cursor = param(sp.cursor)

  const query: ListQuery = {
    filters: stage ? { stage } : {},
    ...(q ? { text: q, textFields: ["name"] } : {}),
    ...(sort ? { sort: { field: sort, dir } } : {}),
    ...(cursor && /^\d+$/.test(cursor) ? { cursor } : {}),
    limit: PAGE_SIZE,
  }
  const [deals, companies] = await Promise.all([listDeals(member.orgId, query), listCompanies(member.orgId, { sort: { field: "name", dir: "asc" }, limit: 200 })])
  const [names, owners] = await Promise.all([companyNames(member.orgId, [...new Set(deals.rows.map((d) => d.company))]), personNames(member.orgId, [...new Set(deals.rows.map((d) => d.owner))])])

  const href = (change: Record<string, string | undefined>) => {
    const next = new URLSearchParams()
    const values = { q: q || undefined, stage, sort, dir: sort ? dir : undefined, ...change }
    for (const [k, v] of Object.entries(values)) if (v) next.set(k, v)
    const s = next.toString()
    return s ? `/deals?${s}` : "/deals"
  }
  const sortLink = (field: (typeof sortable)[number], label: string) => {
    const active = sort === field
    const nextDir = active && dir === "asc" ? "desc" : "asc"
    return (
      <Link href={href({ sort: field, dir: nextDir, cursor: undefined })} className="hover:text-zinc-900" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
        {label} {active ? (dir === "asc" ? "↑" : "↓") : ""}
      </Link>
    )
  }

  return (
    <>
      <PageTitle>Deals</PageTitle>
      <Notice notice={param(sp.notice)} error={param(sp.error)} />
      <form className="mb-4 flex flex-wrap items-center gap-2" action="/deals">
        <input name="q" defaultValue={q} placeholder="Search deals" className={`${inputClass} w-64`} />
        <select name="stage" defaultValue={stage ?? ""} className={inputClass} aria-label="Stage">
          <option value="">All stages</option>
          {STAGES.map((s: Stage) => (
            <option key={s} value={s}>{STAGE_LABELS[s]}</option>
          ))}
        </select>
        {sort ? <input type="hidden" name="sort" value={sort} /> : null}
        {sort ? <input type="hidden" name="dir" value={dir} /> : null}
        <button type="submit" className={secondaryButtonClass}>Filter</button>
        {q || stage ? <Link href="/deals" className="text-zinc-500 hover:text-zinc-900">Clear</Link> : null}
      </form>
      <Card>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Deal</Th>
              <Th>Company</Th>
              <Th>Stage</Th>
              {money ? <Th className="text-right">{sortLink("value", "Value")}</Th> : null}
              <Th>{sortLink("closeDate", "Close date")}</Th>
              <Th>Owner</Th>
            </tr>
          </thead>
          <tbody>
            {deals.rows.map((d) => (
              <tr key={d.id} data-deal={d.id}>
                <Td><TextLink href={`/deals/${d.id}`}>{d.name}</TextLink></Td>
                <Td>{names[d.company] ?? d.company}</Td>
                <Td><StageBadge stage={d.stage} /></Td>
                {money ? <Td className="text-right tabular-nums">{formatMoney(d.value)}</Td> : null}
                <Td>{formatDate(d.closeDate)}</Td>
                <Td>{owners[d.owner] ?? "Unknown person"}</Td>
              </tr>
            ))}
            {deals.rows.length === 0 ? (
              <tr><Td className="text-zinc-500">No deals match.</Td></tr>
            ) : null}
          </tbody>
        </table>
        <div className="mt-3 flex items-center gap-3 text-zinc-500">
          <span>{deals.total === 1 ? "1 deal" : `${deals.total} deals`}</span>
          {cursor ? <Link href={href({ cursor: undefined })} className="hover:text-zinc-900">First page</Link> : null}
          {deals.next ? <Link href={href({ cursor: deals.next })} className="hover:text-zinc-900">Next page →</Link> : null}
        </div>
      </Card>
      {member.can("deals.edit") ? (
        <Card title="New deal" className="mt-4">
          <form action={createDealAction} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">Name</span>
              <input name="name" required minLength={2} maxLength={120} className={`${inputClass} w-64`} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">Company</span>
              <select name="company" required className={inputClass}>
                {companies.rows.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">Value (EUR)</span>
              <input name="value" type="number" min={0} step="0.01" required className={`${inputClass} w-32`} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">Close date</span>
              <input name="closeDate" type="date" required className={inputClass} />
            </label>
            <button type="submit" className={buttonClass}>Create deal</button>
          </form>
        </Card>
      ) : null}
    </>
  )
}
