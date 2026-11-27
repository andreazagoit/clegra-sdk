import { definePage } from "@clegra/sdk"

import { shipment } from "../entities/shipment"
import { l } from "../labels"

/** A shipment's record page, in sections (it replaces the default record page, named after the entity). */
export const shipmentRecord = definePage({
  name: "shipment",
  record: shipment,
  sections: [
    { title: l("Delivery", "Consegna"), fields: ["customer", "destination", "status", "expectedDelivery", "deliveredOn"] },
    { title: l("Parcels and cost", "Colli e costo"), fields: ["parcels", "cost"] },
  ],
})
