import type { Category, MovementKind, OrderStatus, StockStatus, Unit } from "./warehouse"

/** The UI's words for the stored values, in English and Italian: shared by the pages and the app definition. */
export const CATEGORY_LABELS: Record<Category, { en: string; it: string }> = {
  fasteners: { en: "Fasteners", it: "Viteria" },
  tools: { en: "Tools", it: "Utensili" },
  electrical: { en: "Electrical", it: "Materiale elettrico" },
  plumbing: { en: "Plumbing", it: "Idraulica" },
  paint: { en: "Paint", it: "Vernici" },
  garden: { en: "Garden", it: "Giardino" },
  household: { en: "Household", it: "Casa" },
}

export const UNIT_LABELS: Record<Unit, { en: string; it: string }> = {
  pcs: { en: "pieces", it: "pezzi" },
  box: { en: "boxes", it: "scatole" },
  kg: { en: "kg", it: "kg" },
  m: { en: "metres", it: "metri" },
  l: { en: "litres", it: "litri" },
}

export const STOCK_STATUS_LABELS: Record<StockStatus, { en: string; it: string }> = {
  ok: { en: "In stock", it: "Disponibile" },
  low: { en: "Low", it: "Sotto scorta" },
  out: { en: "Out of stock", it: "Esaurito" },
}

export const MOVEMENT_KIND_LABELS: Record<MovementKind, { en: string; it: string }> = {
  in: { en: "Goods in", it: "Carico" },
  out: { en: "Goods out", it: "Scarico" },
  adjustment: { en: "Adjustment", it: "Rettifica" },
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, { en: string; it: string }> = {
  draft: { en: "Draft", it: "Bozza" },
  confirmed: { en: "Confirmed", it: "Confermato" },
  shipped: { en: "Shipped", it: "Spedito" },
  cancelled: { en: "Cancelled", it: "Annullato" },
}
