import { definePage } from "@clegra/sdk"

import { lateShipments } from "../artifacts/late-shipments"
import { shipment } from "../entities/shipment"
import { l } from "../labels"

export const shipments = definePage({ name: "shipments", title: l("Shipments", "Spedizioni"), icon: "package", list: shipment, badge: lateShipments, columns: ["trackingNumber", "customer", "status", "expectedDelivery", "cost"] })
