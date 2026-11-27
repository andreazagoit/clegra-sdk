import { definePage } from "@clegra/sdk"

import { bookPickup } from "../actions/book-pickup"
import { pickup } from "../entities/pickup"
import { l } from "../labels"

export const pickups = definePage({ name: "pickups", title: l("Pickups", "Ritiri"), icon: "calendar-clock", list: pickup, actions: [bookPickup], columns: ["date", "title", "parcels", "depot", "status", "bookedBy"] })
