import { definePage } from "@clegra/sdk"

import { bookPickup } from "../actions/book-pickup"
import { lateShipments } from "../artifacts/late-shipments"
import { shipmentsByStatus } from "../artifacts/shipments-by-status"
import { shippingCosts } from "../artifacts/shipping-costs"
import { upcomingPickups } from "../artifacts/upcoming-pickups"
import { l } from "../labels"

export const overview = definePage({
  name: "overview",
  title: l("Overview", "Panoramica"),
  icon: "layout-dashboard",
  actions: [bookPickup],
  dashboard: [
    { artifact: lateShipments, params: {}, size: "small" },
    { artifact: shippingCosts, params: {}, size: "small" },
    { artifact: shipmentsByStatus, params: {} },
    { artifact: upcomingPickups, params: { limit: 5 } },
  ],
})
