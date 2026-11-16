import { getEmbedCaller } from "modelapp/next"

import { boardDeals, companyNames, isWorkspaceInstallation, provisionWorkspace, STAGES } from "@/lib/crm"
import { formatDate, formatMoney, STAGE_LABELS } from "@/lib/format"
import { crmApp } from "@/modelapp"

import { NoAccess } from "../../_components/ui"

export const metadata = { title: "Pipeline board" }

// The pipeline as a board, by stage, with totals: the MAP page `board`, framed by a host. Who looks is the caller the
// host's sign-in ticket named (spec §5.1), never the CRM's own session: in a frame on another site that cookie is a
// third-party one and never arrives.
export default async function PipelineBoard() {
  const caller = await getEmbedCaller(crmApp, "board")
  if (!caller) return <SignedOut />
  if (!caller.can("deals.view")) return <NoAccess what="the pipeline" />
  // The tenant exactly as the MCP handlers get it: an organization, or a workspace host's installation.
  if (isWorkspaceInstallation(caller.installation)) await provisionWorkspace(caller.installation)
  const orgId = caller.installation
  const money = caller.can("deals.values")
  const deals = await boardDeals(orgId)
  const names = await companyNames(orgId, [...new Set(deals.map((d) => d.company))])
  return (
    <div className="grid grid-cols-5 gap-2" data-board data-viewer={caller.person?.name ?? ""}>
      {STAGES.map((stage) => {
        const column = deals.filter((d) => d.stage === stage)
        const total = column.reduce((s, d) => s + d.value, 0)
        return (
          <section key={stage} className="flex min-w-0 flex-col gap-2 rounded-lg bg-zinc-100 p-2" data-stage={stage}>
            <header className="flex items-baseline justify-between gap-1 px-1">
              <h2 className="font-semibold">{STAGE_LABELS[stage]}</h2>
              <span className="text-zinc-500">{column.length}{money ? ` · ${formatMoney(total)}` : ""}</span>
            </header>
            {column.map((d) => (
              <a key={d.id} href={`/deals/${d.id}`} target="_blank" rel="noopener" className="block rounded-md border border-zinc-200 bg-white p-2 shadow-xs hover:border-zinc-400">
                <span className="block truncate font-medium">{d.name}</span>
                <span className="block truncate text-zinc-500">{names[d.company]}</span>
                <span className="mt-1 flex justify-between text-xs text-zinc-500">
                  <span>{formatDate(d.closeDate)}</span>
                  {money ? <span className="tabular-nums text-zinc-700">{formatMoney(d.value)}</span> : null}
                </span>
              </a>
            ))}
          </section>
        )
      })}
    </div>
  )
}

function SignedOut() {
  return (
    <p className="text-zinc-600" data-signed-out>
      This board opens inside an app that connects to the CRM (Clegra, ChatGPT, Claude). Open it from there, or open{" "}
      <a href="/" target="_blank" rel="noopener" className="underline">
        the CRM
      </a>
      .
    </p>
  )
}
