import { MemoryStore, type Manifest, type ServedApp } from "@clegra/sdk"
import { devSignIn, DEV_ISSUER } from "@clegra/sdk/signin"

import { shipmentsApp } from "./clegra/app"
import { PERMISSIONS } from "./clegra/labels"
import { createCourier, type Courier } from "./courier"
import { shipmentsAuth } from "./auth"
import { serveShipments } from "./serve"

/**
 * THE IN-PROCESS FIXTURE FOR HOST TESTS: the Shipments app, signed in by the SDK's development sign-in (`devSignIn`),
 * with its data and its write store in memory. A host test calls it through `served.fetch` (no port, no network),
 * with tokens from `served.dev.token()` or the clients of `@clegra/sdk/testing`; `courier.report()` plays the courier
 * (a delivery, a delay) for the delivery check.
 *
 * Stable for host tests: the people, the installation, the seeded data (courier.ts) and `shipmentsManifest` change
 * only with a new version of this example (CHANGELOG.md).
 */

/** The fixture's test people: Ada may do everything, Bruno only sees shipments (no costs, no pickups to book). */
export const SHIPMENTS_PEOPLE = [
  { id: "ada", name: "Ada Rossi", permissions: "all" as const },
  { id: "bruno", name: "Bruno Verdi", permissions: ["shipments.view"] },
]

/** The installation development tokens are for, unless a test names another. */
export const SHIPMENTS_INSTALLATION = "test"

/**
 * The tenant the app's handlers (and so the courier's data) see for a development token's installation:
 * `<installation>@clegra-dev`. Use it with `courier.report()` and the other courier calls.
 */
export const devTenant = (installation: string = SHIPMENTS_INSTALLATION) => `${installation}@${DEV_ISSUER}`

/** The depot setting a workspace host sends with every call (`_meta.clegra.settings`). */
export const SHIPMENTS_SETTINGS = { depot: "North depot" }

export type ShipmentsFixtureOptions = {
  /** The courier's data (default: a new set, seeded per tenant). Keep a handle to play deliveries and delays. */
  courier?: Courier
  /** Default `SHIPMENTS_INSTALLATION`. */
  installation?: string
  /** The development sign-in's issuer (default `http://localhost:3000`; its MCP address is `<issuer>/mcp`). */
  issuer?: string
}

/** The served app for `served.fetch(request, { remoteAddress: "127.0.0.1" })` (development tokens count only from a loopback address). */
export function createShipmentsApp(options: ShipmentsFixtureOptions = {}): ServedApp {
  const signIn = devSignIn(shipmentsApp, { people: SHIPMENTS_PEOPLE, installation: options.installation ?? SHIPMENTS_INSTALLATION, code: "TEST", ...(options.issuer ? { issuer: options.issuer } : {}) })
  return serveShipments({ auth: { signIn }, store: new MemoryStore(), courier: options.courier ?? createCourier() })
}

/** The address a host test installs the fixture from (its MCP address is `<url>/mcp`). */
export const SHIPMENTS_URL = "https://shipments.example.com"

/**
 * The manifest exactly as the app serves it at `/.well-known/clegra.json`, plain JSON, for a server at
 * `SHIPMENTS_URL` with its own sign-in (src/auth.ts). The dev fixture's manifest differs only in `auth`.
 */
export const shipmentsManifest: Manifest = JSON.parse(JSON.stringify(serveShipments({ auth: shipmentsAuth(shipmentsApp, { SHIPMENTS_PUBLIC_URL: SHIPMENTS_URL }).auth }).manifest())) as Manifest

export { createCourier, PERMISSIONS, shipmentsApp, type Courier }
export type { Pickup, Shipment, ShipmentStatus } from "./courier"
