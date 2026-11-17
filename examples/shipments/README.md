# Shipments: an example Clegra app

A courier's shipments and pickups as a Clegra app (`@clegra/sdk`): one `defineApp`
object that the SDK serves as a manifest for workspace hosts (a Clegra node)
and as a plain MCP server for ChatGPT, Claude and any MCP client. It runs on
Node's own HTTP server (`@clegra/sdk/node`), has no UI of its own, and keeps its
invented data **in memory** (`MemoryStore` for writes, `src/courier.ts` for the
data): a restart starts again from the seed. So it has no database, no
migrations, no re-key script and no Docker image; a real courier app would
keep the same definition and put `SqlStore` and its own tables behind it, as
the CRM and warehouse examples do.

It is also an **in-process fixture for a workspace host's tests** (below).

| File | What it is |
|---|---|
| `src/app.ts` | The app: `defineShipmentsApp({ auth, store?, courier? })` |
| `src/courier.ts` | The courier's data in memory, one set per tenant, and the list query over it |
| `src/auth.ts` | Who may call: `SHIPMENTS_PUBLIC_URL` and `CLEGRA_ISSUERS` |
| `src/main.ts` | Runs it (`npm start`, `npm run dev`) |
| `src/fixture.ts` | The fixture for host tests |
| `test/app.test.ts` | In-process tests, the conformance checks included |

## What it shows

**Entities** (fields carry their meaning; search, fetch and the resolver are derived):

| Entity | Kind | Notes |
|---|---|---|
| `shipment` | `com.clegra.shipment` (namespaced, defined in the manifest's `kinds`) | `trackingNumber` is the kind's key (`as`, exact filter): another app of the workspace (a shop's orders) finds the same shipment by it. `cost` is money behind `shipments.prices`; `customer` and `destination` are outsiders' text (`untrusted`). `status` and `expectedDelivery` are filters (the host derives the status choice and the period pill) |
| `pickup` | `event` | `date` is its `startDate`, the depot its `location`; `bookedBy` a person named from the token of who booked it |

A shipment is not an `order` (an order is what a customer bought; a shipment
is what the courier carries), so it gets a namespaced kind rather than a
published one that only resembles it.

**Actions**

| Action | Tool | Confirm | Permission | Notes |
|---|---|---|---|---|
| Book a pickup | `book_pickup` | always | `shipments.book` | At the installation's `depot` setting, today or later. Not listed to plain clients |
| Cancel pickup | `pickup_cancel_pickup` | always | `shipments.book` | On a booked pickup's record; a done or cancelled one is a `conflict` |
| Check deliveries | `check_deliveries` | never | `shipments.view` | `visibility: "app"`: the host's machinery, run by the schedule below |

**Pages and navigation**: one section «Courier»: `shipments` (list, its badge
the `late_shipments` stat), `pickups` (list, primary action «Book a pickup»),
`overview` (dashboard: late shipments, shipping costs, shipments by status as
a pie, upcoming pickups; primary action «Book a pickup»); the shipment's
record page in two sections (delivery; parcels and cost).

**Fragments**: `late_shipments` (stat, the badge), `shipping_costs` (stat,
money, behind `shipments.prices`), `shipments_by_status` (chart),
`upcoming_pickups` (list, with «Book a pickup» inside).

**Schedule and notifications**: `delivery_check` runs `check_deliveries`
every 15 minutes as the installation. Each shipment that became delivered or
late since the last run is told once, as the typed notification `delivered` or
`late`, to `{ permission: "shipments.view" }` (everyone of the installation who
sees shipments). People mute either type per app.

**Lifecycle**: `clegra_export` gives the tenant's shipments, pickups and the
names of who booked them as one JSON file; `clegra_delete` deletes them (the
tenant then stays empty; asking again answers zero counts).

**Agent**: `logistics` (tier `fast`), on the shipments, the pickups, the two
pickup actions and the four fragments, with three starters.

**Permissions**: `shipments.view` (default on), `shipments.prices`,
`shipments.book`. **Setting**: `depot` (text, required): where the courier
collects the parcels. Labels everywhere are `{ en, it }`; identifiers and data
are English.

## Who may call

Workspace hosts only, in the trusted-issuer mode (spec §7). A courier hosts one
server for all its customer companies, so `CLEGRA_ISSUERS` may name several
nodes; the tenant is `<installation>@<issuer>`, so two nodes never reach each
other's data, even with the same installation id.

| Variable | Meaning |
|---|---|
| `SHIPMENTS_PUBLIC_URL` | The address the nodes install the app from (required); the MCP address, the only token audience, is `<url>/mcp` |
| `CLEGRA_ISSUERS` | The trusted nodes, comma-separated, each `issuer` or `issuer\|jwksUri` (required, at least one, each once) |
| `SHIPMENTS_PORT` | Default `4319` |
| `SHIPMENTS_HOST` | Default `0.0.0.0` (`npm start` only) |

## Run it

From this folder, in the repository (`@clegra/sdk` is the repository's root, a workspace):

```sh
npm run dev      # 127.0.0.1:4319, signed in by the SDK's dev authority; prints a token and the check command
npx @clegra/sdk check http://127.0.0.1:4319 --token <the printed token>   # Conformant.

SHIPMENTS_PUBLIC_URL=https://shipments.example.com CLEGRA_ISSUERS=https://node.example.com npm start
```

`npm run dev` is refused when `NODE_ENV` is `production` and answers loopback
callers only. Its test people are the fixture's (Ada: everything; Bruno: sees
shipments only). Stop it with Ctrl-C.

## Tests

```sh
npm test         # in-process: the manifest, conformance (checkApp), lists and money, pickups, the schedule, pages, lifecycle, auth
npm run typecheck
```

## The fixture for host tests

`src/fixture.ts` (also importable as `clegra-example-shipments/fixture` inside
this repository's workspace):

| Export | What it is |
|---|---|
| `createShipmentsApp({ courier?, installation? })` | The app in-process, for `app.fetch(request, { remoteAddress: "127.0.0.1" })`: dev authority (`app.devToken()`, `app.devConfirmation()`, the clients of `@clegra/sdk/testing`), `MemoryStore`, data in memory |
| `shipmentsManifest` | The manifest (`Manifest`, plain JSON) exactly as served at `/.well-known/clegra.json` by a server at `SHIPMENTS_URL` (`https://shipments.example.com`, MCP at `/mcp`) trusting `https://node.example.com`. The dev app's manifest differs only in `auth` |
| `SHIPMENTS_PEOPLE` | `ada` (all permissions, «Ada Rossi»), `bruno` (`shipments.view`, «Bruno Verdi») |
| `SHIPMENTS_INSTALLATION` | `"test"`, the dev tokens' default installation |
| `SHIPMENTS_SETTINGS` | `{ depot: "North depot" }`: what a host sends as `_meta.clegra.settings` (booking needs it) |
| `devTenant(installation?)` | The tenant the handlers see for a dev token's installation: `<installation>@clegra-dev` |
| `createCourier()`, `Courier` | The data; `courier.report(tenant, id, status)` plays the courier (a delivery, a delay) before a `delivery_check` run |
| `PERMISSIONS` | The permission ids and labels |

The seed per tenant: shipments `AC1001`–`AC1005` (two in transit, one late,
two delivered) and pickup `PK1` (done); new pickups are `PK2`, `PK3`, …
These change only with a new version of this example (CHANGELOG.md).

```ts
import { createCourier, createShipmentsApp, devTenant, SHIPMENTS_SETTINGS } from "clegra-example-shipments/fixture"
import { installationClient } from "@clegra/sdk/testing"

const courier = createCourier()
const app = createShipmentsApp({ courier })
courier.report(devTenant(), "AC1001", "delivered")
const host = await installationClient(app, { installation: "test", permissions: ["shipments.view"] })
const run = await host.schedule("delivery_check", SHIPMENTS_SETTINGS) // _meta.clegra.notifications: one «delivered»
```

