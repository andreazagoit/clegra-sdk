import type { Filter, ListResult, Query } from "@clegra/sdk"

/**
 * THE COURIER'S DATA, IN MEMORY: invented shipments and pickups, one set per
 * tenant (`<installation>@<issuer>`, or the app's own tenant). A real app keeps
 * them in its own database and reads the courier's state through the
 * courier's API; this example keeps everything in this process, so a restart
 * starts again from the seed. Nothing here knows about Clegra: the app
 * (app.ts) calls these functions with the tenant the SDK took from the
 * verified caller.
 */

export const SHIPMENT_STATUSES = ["in_transit", "late", "delivered"] as const
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number]
export const PICKUP_STATUSES = ["booked", "done", "cancelled"] as const
export type PickupStatus = (typeof PICKUP_STATUSES)[number]

export type Shipment = {
  id: string
  trackingNumber: string
  customer: string
  status: ShipmentStatus
  expectedDelivery: string
  deliveredOn?: string
  destination: string
  parcels: number
  cost: number
}

export type Pickup = {
  id: string
  title: string
  date: string
  parcels: number
  depot: string
  status: PickupStatus
  note?: string
  bookedBy?: string
}

type TenantData = {
  shipments: Shipment[]
  pickups: Pickup[]
  /** Who booked pickups, by id: their names, as the caller's token gave them. */
  people: Map<string, string>
  /** The last status of each shipment that people were told about (the delivery check tells each change once). */
  told: Map<string, ShipmentStatus>
  nextPickup: number
}

export class CourierError extends Error {
  constructor(
    readonly code: "invalid_input" | "not_found" | "conflict",
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message)
    this.name = "CourierError"
  }
}

const seedShipments = (): Shipment[] => [
  { id: "AC1001", trackingNumber: "AC1001", customer: "Northwind Furniture Ltd", status: "in_transit", expectedDelivery: "2026-11-18", destination: "12 High Street, Leeds", parcels: 3, cost: 42.5 },
  { id: "AC1002", trackingNumber: "AC1002", customer: "Bluebell Bakery", status: "late", expectedDelivery: "2026-11-10", destination: "4 Mill Lane, Bristol", parcels: 1, cost: 12 },
  { id: "AC1003", trackingNumber: "AC1003", customer: "Harbor Tools Co.", status: "delivered", expectedDelivery: "2026-11-08", deliveredOn: "2026-11-08", destination: "88 Dock Road, Liverpool", parcels: 8, cost: 120 },
  { id: "AC1004", trackingNumber: "AC1004", customer: "Greenleaf Garden Supply", status: "in_transit", expectedDelivery: "2026-11-19", destination: "7 Orchard Way, York", parcels: 2, cost: 24.9 },
  { id: "AC1005", trackingNumber: "AC1005", customer: "Quayside Books", status: "delivered", expectedDelivery: "2026-11-12", deliveredOn: "2026-11-11", destination: "21 Quay Street, Cardiff", parcels: 5, cost: 38 },
]

const seedPickups = (): Pickup[] => [{ id: "PK1", title: "Pickup PK1 on 2026-11-10", date: "2026-11-10", parcels: 4, depot: "North depot", status: "done" }]

const seed = (): TenantData => {
  const shipments = seedShipments()
  return { shipments, pickups: seedPickups(), people: new Map(), told: new Map(shipments.map((s) => [s.id, s.status])), nextPickup: 2 }
}

const empty = (): TenantData => ({ shipments: [], pickups: [], people: new Map(), told: new Map(), nextPickup: 1 })

const today = () => new Date().toISOString().slice(0, 10)

/** A record matches a filter: a value, `{ in }`, or a range (`{ gte, lte }`, dates compared as text). */
function matches(value: unknown, filter: Filter): boolean {
  if (filter !== null && typeof filter === "object") {
    if ("in" in filter) return filter.in.some((v) => v === value)
    if (value === undefined || value === null) return false
    const v = value as string | number
    return (filter.gte === undefined || v >= filter.gte) && (filter.lte === undefined || v <= filter.lte)
  }
  return value === filter
}

/** A list query over records in memory: filters, words in the caller's search fields, order, pages (the cursor is an offset). */
export function listOf<T extends Record<string, unknown>>(records: T[], query: Query, defaultSort: { field: keyof T & string; dir: "asc" | "desc" }): ListResult<T> {
  let rows = records.filter((r) => Object.entries(query.filters).every(([field, filter]) => matches(r[field], filter)))
  if (query.text) {
    const words = query.text.toLowerCase().split(/\s+/).filter(Boolean)
    const fields = query.textFields ?? []
    rows = rows.filter((r) => {
      const text = fields.map((f) => String(r[f] ?? "")).join(" ").toLowerCase()
      return words.every((w) => text.includes(w))
    })
  }
  const { field, dir } = query.sort ?? defaultSort
  rows = [...rows].sort((a, b) => {
    const x = a[field] as string | number | undefined
    const y = b[field] as string | number | undefined
    const order = x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : x < y ? -1 : 1
    return dir === "desc" ? -order : order
  })
  const offset = query.cursor === undefined ? 0 : Number(query.cursor)
  if (!Number.isInteger(offset) || offset < 0) throw new CourierError("invalid_input", `"${query.cursor}" is not a cursor of this list`)
  const page = rows.slice(offset, offset + query.limit)
  return { rows: page, total: rows.length, ...(offset + query.limit < rows.length ? { next: String(offset + query.limit) } : {}) }
}

/** A shipment whose status changed since people were last told: what the delivery check sends. */
export type StatusChange = { shipment: Shipment; status: "delivered" | "late" }

export type Courier = ReturnType<typeof createCourier>

/** The courier's data for every tenant, in memory. Each tenant starts from the same invented shipments. */
export function createCourier() {
  const tenants = new Map<string, TenantData>()
  const of = (tenant: string): TenantData => {
    let data = tenants.get(tenant)
    if (!data) tenants.set(tenant, (data = seed()))
    return data
  }
  const shipmentOf = (tenant: string, id: string): Shipment => {
    const shipment = of(tenant).shipments.find((s) => s.id === id)
    if (!shipment) throw new CourierError("not_found", `There is no shipment ${id}.`)
    return shipment
  }

  return {
    listShipments: (tenant: string, query: Query) => listOf(of(tenant).shipments, query, { field: "expectedDelivery", dir: "desc" }),
    getShipment: (tenant: string, id: string) => of(tenant).shipments.find((s) => s.id === id) ?? null,
    listPickups: (tenant: string, query: Query) => listOf(of(tenant).pickups, query, { field: "date", dir: "desc" }),
    getPickup: (tenant: string, id: string) => of(tenant).pickups.find((p) => p.id === id) ?? null,
    shipments: (tenant: string): readonly Shipment[] => of(tenant).shipments,
    pickups: (tenant: string): readonly Pickup[] => of(tenant).pickups,
    personNames: (tenant: string, ids: string[]) => Object.fromEntries(ids.flatMap((id) => (of(tenant).people.has(id) ? [[id, of(tenant).people.get(id)!]] : []))),

    /** Books a pickup at the depot on a date (today or later). */
    bookPickup(tenant: string, input: { date: string; parcels: number; depot: string; note?: string; by?: { id: string; name?: string } }): Pickup {
      if (input.date < today()) throw new CourierError("invalid_input", "The pickup's date has already passed.", { date: "The date has already passed." })
      const data = of(tenant)
      const id = `PK${data.nextPickup++}`
      const pickup: Pickup = { id, title: `Pickup ${id} on ${input.date}`, date: input.date, parcels: input.parcels, depot: input.depot, status: "booked", ...(input.note ? { note: input.note } : {}), ...(input.by ? { bookedBy: input.by.id } : {}) }
      if (input.by?.name) data.people.set(input.by.id, input.by.name)
      data.pickups.push(pickup)
      return pickup
    },

    /** Cancels a booked pickup; one done or already cancelled stays as it is. */
    cancelPickup(tenant: string, id: string): Pickup {
      const pickup = of(tenant).pickups.find((p) => p.id === id)
      if (!pickup) throw new CourierError("not_found", `There is no pickup ${id}.`)
      if (pickup.status !== "booked") throw new CourierError("conflict", `Pickup ${id} is ${pickup.status === "done" ? "done" : "already cancelled"}: only a booked pickup can be cancelled.`)
      pickup.status = "cancelled"
      return pickup
    },

    /** What the courier reports for a shipment (a real app reads it from the courier's API; tests and demos call it). */
    report(tenant: string, id: string, status: ShipmentStatus, on: string = today()): Shipment {
      const shipment = shipmentOf(tenant, id)
      shipment.status = status
      if (status === "delivered") shipment.deliveredOn = on
      else delete shipment.deliveredOn
      return shipment
    },

    /** The shipments delivered or late since people were last told, each change once. */
    statusChanges(tenant: string): StatusChange[] {
      const data = of(tenant)
      const changes: StatusChange[] = []
      for (const shipment of data.shipments) {
        if (data.told.get(shipment.id) === shipment.status) continue
        data.told.set(shipment.id, shipment.status)
        if (shipment.status === "delivered" || shipment.status === "late") changes.push({ shipment, status: shipment.status })
      }
      return changes
    },

    /** Everything kept for the tenant, as one object; null when nothing is kept. */
    exportTenant(tenant: string) {
      const data = of(tenant)
      if (!data.shipments.length && !data.pickups.length) return null
      return { shipments: data.shipments, pickups: data.pickups, people: Object.fromEntries(data.people) }
    },

    /** Deletes everything kept for the tenant (it stays empty: no new seed). Idempotent; the counts say what this call deleted. */
    deleteTenant(tenant: string): Record<string, number> {
      const data = of(tenant)
      const counts = { shipments: data.shipments.length, pickups: data.pickups.length }
      tenants.set(tenant, empty())
      return counts
    },
  }
}
