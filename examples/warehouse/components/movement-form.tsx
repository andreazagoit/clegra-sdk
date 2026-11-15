import { registerMovementAction } from "@/app/actions"
import { ActionForm } from "@/components/action-form"
import { MOVEMENT_KIND_LABELS } from "@/lib/labels"
import { MOVEMENT_KINDS, type Product } from "@/lib/warehouse"

/** Register goods in, goods out or an adjustment: for one product, or with a product picker. */
export function MovementForm({ product, products }: { product?: Product; products?: Product[] }) {
  return (
    <ActionForm action={registerMovementAction} submit="Register" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        {product ? (
          <input type="hidden" name="productId" value={product.id} />
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            Product
            <select name="productId" required className="field min-w-64">
              {(products ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} · {p.name} ({p.stock} {p.unit})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm">
          Kind
          <select name="kind" defaultValue="in" className="field">
            {MOVEMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {MOVEMENT_KIND_LABELS[k].en}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Quantity
          <input name="quantity" type="number" step="1" required className="field w-28" placeholder="e.g. 10" />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Note
          <input name="note" maxLength={500} className="field" placeholder="Supplier delivery, stocktake, …" />
        </label>
      </div>
      <p className="text-xs text-stone-500">For an adjustment, give the difference you counted: −2 for two missing, 3 for three found.</p>
    </ActionForm>
  )
}
