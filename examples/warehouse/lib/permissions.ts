/**
 * What each role of an organization may do. One table, read by the pages,
 * the server actions and the app definition alike.
 */
export const PERMISSIONS = {
  "products.view": { en: "See products and stock", it: "Vedere prodotti e giacenze" },
  "products.cost": { en: "See purchase costs and stock value", it: "Vedere costi d'acquisto e valore del magazzino" },
  "stock.move": { en: "Register stock movements", it: "Registrare movimenti di magazzino" },
  "orders.view": { en: "See orders", it: "Vedere gli ordini" },
  "orders.manage": { en: "Create and confirm orders", it: "Creare e confermare ordini" },
} as const

export type Permission = keyof typeof PERMISSIONS
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[]

/** The organization roles (better-auth's organization plugin): the creator is an admin. */
export type Role = "owner" | "admin" | "member"

const MEMBER: Permission[] = ["products.view", "stock.move", "orders.view"]

export function permissionsFor(role: string): Permission[] {
  if (role === "owner" || role === "admin") return [...ALL_PERMISSIONS]
  if (role === "member") return [...MEMBER]
  // An unknown role (e.g. a custom one added later) gets nothing until it is listed here.
  return []
}
