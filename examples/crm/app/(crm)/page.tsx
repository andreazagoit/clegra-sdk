import Link from "next/link"

import { closingSoon, companyNames, openPipeline, pipelineByStage } from "@/lib/crm"
import { formatDate, formatMoney, STAGE_LABELS } from "@/lib/format"
import { requireMember } from "@/lib/session"

import { Card, NoAccess, PageTitle, secondaryButtonClass, StageBadge, TextLink } from "../_components/ui"

export const metadata = { title: "Pipeline" }

export default async function PipelinePage() {
  const member = await requireMember()
  if (!member.can("deals.view")) return <NoAccess what="the pipeline" />
  const money = member.can("deals.values")
  const [stages, open, soon] = await Promise.all([pipelineByStage(member.orgId), openPipeline(member.orgId), closingSoon(member.orgId, 60)])
  const companies = await companyNames(member.orgId, [...new Set(soon.map((d) => d.company))])
  return (
    <>
      <PageTitle actions={<Link href="/board" className={secondaryButtonClass}>Open the board</Link>}>Pipeline</PageTitle>
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Open pipeline">
          <p className="text-2xl font-semibold">{money ? formatMoney(open.value) : open.count}</p>
          <p className="text-zinc-500">{open.count === 1 ? "1 open deal" : `${open.count} open deals`}</p>
        </Card>
        <Card title="Deals by stage" className="md:col-span-2">
          <ul className="grid grid-cols-5 gap-2">
            {stages.map((s) => (
              <li key={s.stage} className="rounded-md bg-zinc-50 p-2">
                <Link href={`/deals?stage=${s.stage}`} className="block">
                  <span className="text-xs text-zinc-500">{STAGE_LABELS[s.stage]}</span>
                  <span className="block text-lg font-semibold">{s.count}</span>
                  {money ? <span className="block text-xs text-zinc-500">{formatMoney(s.value)}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card title="Closing in the next 60 days" className="mt-4">
        {soon.length ? (
          <ul className="divide-y divide-zinc-100">
            {soon.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-2">
                <TextLink href={`/deals/${d.id}`}>{d.name}</TextLink>
                <span className="text-zinc-500">{companies[d.company]}</span>
                <StageBadge stage={d.stage} />
                <span className="ml-auto text-zinc-600">{formatDate(d.closeDate)}</span>
                {money ? <span className="w-24 text-right tabular-nums">{formatMoney(d.value)}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-zinc-500">Nothing closes in the next 60 days.</p>
        )}
      </Card>
    </>
  )
}
