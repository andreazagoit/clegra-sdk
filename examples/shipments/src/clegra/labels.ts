import { PICKUP_STATUSES, SHIPMENT_STATUSES } from "../courier"

/** A label in the app's two languages. */
export type Label = { en: string; it: string }
export const l = (en: string, it: string): Label => ({ en, it })

export const PERMISSIONS = {
  "shipments.view": { label: l("See shipments and pickups", "Vedere le spedizioni e i ritiri"), default: true },
  "shipments.prices": { label: l("See shipping costs", "Vedere i costi di spedizione") },
  "shipments.book": { label: l("Book and cancel pickups", "Prenotare e annullare i ritiri") },
} as const
export type Permission = keyof typeof PERMISSIONS

export const SHIPMENT_STATUS_LABELS = {
  in_transit: l("In transit", "In transito"),
  late: l("Late", "In ritardo"),
  delivered: l("Delivered", "Consegnata"),
} satisfies Record<(typeof SHIPMENT_STATUSES)[number], Label>

export const PICKUP_STATUS_LABELS = {
  booked: l("Booked", "Prenotato"),
  done: l("Done", "Effettuato"),
  cancelled: l("Cancelled", "Annullato"),
} satisfies Record<(typeof PICKUP_STATUSES)[number], Label>

/** The namespaced kind of a courier's shipment (spec §3.1): the tracking number is its key. */
export const SHIPMENT_KIND = "com.clegra.shipment"
