import Link from "next/link"

import { boardDeals, companyNames, STAGES } from "@/lib/crm"
import { formatDate, formatMoney, STAGE_LABELS } from "@/lib/format"
import { requireMember } from "@/lib/session"

import { NoAccess, PageTitle } from "../../_components/ui"

export const metadata = { title: "Board" }

// The pipeline as a board, by stage, with each column's count and total. A page of the CRM like the others: for its
// own users, and for a Clegra client's person when the CRM is shown as its site there (lib/session.ts).
export default async function BoardPage() {
  const member = await requireMember()
  if (!member.can("deals.view")) return <NoAccess what="the pipeline" />
  const money = member.can("deals.values")
  const deals = await boardDeals(member.orgId)
  const names = await companyNames(member.orgId, [...new Set(deals.map((d) => d.company))])
  return (
    <>
      <PageTitle>Board</PageTitle>
      <div className="grid gap-3 md:grid-cols-5" data-board data-viewer={member.user.name}>
        {STAGES.map((stage) => {
          const column = deals.filter((d) => d.stage === stage)
          const total = column.reduce((s, d) => s + d.value, 0)
          return (
            <section key={stage} className="flex min-w-0 flex-col gap-2 rounded-lg bg-zinc-100 p-2" data-stage={stage}>
              <header className="flex items-baseline justify-between gap-1 px-1">
                <h2 className="font-semibold">{STAGE_LABELS[stage]}</h2>
                <span className="text-zinc-500">
                  {column.length}
                  {money ? ` · ${formatMoney(total)}` : ""}
                </span>
              </header>
              {column.map((d) => (
                <Link key={d.id} href={`/deals/${d.id}`} className="block rounded-md border border-zinc-200 bg-white p-2 shadow-xs hover:border-zinc-400">
                  <span className="block truncate font-medium">{d.name}</span>
                  <span className="block truncate text-zinc-500">{names[d.company]}</span>
                  <span className="mt-1 flex justify-between text-xs text-zinc-500">
                    <span>{formatDate(d.closeDate)}</span>
                    {money ? <span className="tabular-nums text-zinc-700">{formatMoney(d.value)}</span> : null}
                  </span>
                </Link>
              ))}
            </section>
          )
        })}
      </div>
    </>
  )
}
