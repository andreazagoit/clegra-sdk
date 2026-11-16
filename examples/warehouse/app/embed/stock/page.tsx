import type { Metadata } from "next"
import { getEmbedCaller } from "modelapp/next"

import { warehouseApp } from "@/lib/app"
import { sql } from "@/lib/db"
import { STOCK_STATUS_LABELS } from "@/lib/labels"
import { isWorkspaceInstallation, provisionWorkspace } from "@/lib/tenants"
import { listProducts, type StockStatus } from "@/lib/warehouse"

export const metadata: Metadata = { title: "Stock board" }

const BAR: Record<StockStatus, string> = { ok: "bg-teal-600", low: "bg-amber-500", out: "bg-red-600" }

/** Every product's stock against its reorder level, lowest first: a board a host frames (the MAP page `stock`). */
export default async function StockBoard() {
  // The caller the host's sign-in ticket named (spec §5.1): in a frame on another site the site's own session cookie
  // is a third-party one and never arrives.
  const caller = await getEmbedCaller(warehouseApp, "stock")
  if (!caller) return <p className="text-stone-600" data-signed-out>This board opens inside an app that connects to the warehouse (Clegra, ChatGPT, Claude). Open it from there.</p>
  if (!caller.can("products.view")) return <p className="text-stone-600">You may not see the stock.</p>
  // The tenant exactly as the MCP handlers get it: an organization, or a workspace host's installation (its own copy
  // of the demo company, made on its first call).
  const tenantId = caller.installation
  if (isWorkspaceInstallation(tenantId)) await provisionWorkspace(tenantId)
  const [org] = await sql<{ name: string | null }>(`SELECT o.name FROM tenant t LEFT JOIN "organization" o ON o.id = t.organization_id WHERE t.id = $1`, [tenantId])
  const { rows } = await listProducts(tenantId, { sort: { field: "stock", dir: "asc" }, limit: 200 })
  const ordered = [...rows].sort((a, b) => a.stock / Math.max(a.reorderLevel, 1) - b.stock / Math.max(b.reorderLevel, 1))
  const counts = { ok: 0, low: 0, out: 0 }
  for (const p of rows) counts[p.stockStatus]++
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold" data-viewer={caller.person?.name ?? ""}>Stock levels · {org?.name ?? "Workspace"}</p>
        <p className="flex gap-3 text-xs text-stone-500">
          {(["out", "low", "ok"] as const).map((s) => (
            <span key={s} className="flex items-center gap-1">
              <span className={`inline-block size-2 rounded-full ${BAR[s]}`} /> {STOCK_STATUS_LABELS[s].en} {counts[s]}
            </span>
          ))}
        </p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {ordered.map((p) => {
          // The bar's full width is twice the reorder level; the tick marks the level itself.
          const scale = Math.max(p.reorderLevel * 2, p.stock, 1)
          return (
            <li key={p.id} className="grid grid-cols-[minmax(8rem,14rem)_1fr_3.5rem] items-center gap-2" title={`${p.name}: ${p.stock} in stock, reorder at ${p.reorderLevel}`}>
              <span className="truncate text-stone-700">{p.name}</span>
              <span className="relative h-3 rounded bg-stone-100">
                <span className={`absolute inset-y-0 left-0 rounded ${BAR[p.stockStatus]}`} style={{ width: `${(Math.max(p.stock, 0) / scale) * 100}%` }} />
                <span className="absolute -inset-y-0.5 w-px bg-stone-900" style={{ left: `${(p.reorderLevel / scale) * 100}%` }} />
              </span>
              <span className="text-right tabular-nums text-stone-600">
                {p.stock}/{p.reorderLevel}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
