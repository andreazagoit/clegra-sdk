# A second app: a warehouse

> Non-normative. Runnable code: [`examples/warehouse`](../../examples/warehouse) (its README
> has the setup and the demo people). Invented data. The example is still changing, so the code is the reference
> where the two differ.

A small shop's warehouse: **products**, **stock movements** and customer **orders**. It is an ordinary Next.js App
Router app with its own sign-in (better-auth with organizations, the organization being the tenant), made a
Clegra app afterwards. It exists to show that the data layer is the app's own choice: the [CRM](crm.md) uses Drizzle, the warehouse
uses **plain SQL**.

What it shows:

- **Plain SQL, no ORM.** The app has one `sql(text, params)` and one `transaction(fn)` over `pg` or PGlite
  (`lib/db.ts`), and its functions (`listProducts`, `registerMovement`, `confirmOrder`, … in `lib/warehouse.ts`)
  always take the tenant first. The app definition (`clegra/`: one file per entity, action, artifact, page and
  agent, assembled in `clegra/app.ts`) calls those same functions with `ctx.installation`. Filters, sort, search and the cursor arrive already checked, and the list functions turn them
  into SQL.
- **A field permission.** `product.purchaseCost` carries `permission: "products.cost"`, which admins have and members
  don't. The SDK keeps it out of members' rows and records, and refuses it in their filters, sorts and search. The
  `stock_value` artifact, which is computed at purchase cost, requires the same permission.
- **A confirmed action.** `confirm_order` takes all of an order's goods out of stock at once, so it is
  `confirm: "always"`. The person confirms in the host, and a plain client that can elicit is asked by the server.
  A second confirmation of the same order is a `conflict`. `register_movement` and `create_order` are
  `confirm: "optional"`.
- **Kinds.** `product` is kind `product` (SKU as `sku`, sale price as `price`, and a GTIN as `gtin`: a key, filtered
  exactly in SQL; the demo GTINs are in the restricted-circulation range 20–29, so no real product has them).
  `order` is kind `order` (number, date, customer and total as `orderNumber`, `orderDate`, `customer`,
  `totalPrice`). Stock movements have no kind: they are the warehouse's own.
- **Definition apart from runtime.** `clegra/app.ts` is the pure `defineApp`; `clegra/serve.ts` serves it
  (`serve(warehouse, { auth, store, people, site, clientOrigins })`) with the app's Postgres as the write store, and
  `lib/app.ts` makes it once for the MCP route and `proxy.ts`.
- **Its own site in Clegra.** With `CLEGRA_CLIENT_ORIGINS` set, `site` in `clegra/serve.ts` makes the app's real
  pages (dashboard, stock board, products, movements, orders) its site in a Clegra client, framed at the app's origin
  by those origins only (spec §5.1); the person signs in there with the warehouse's own sign-in. `siteProxy` in
  `proxy.ts` sets who may frame each page; the root layout loads the bridge (`<ClegraSite />`).
- **Its own `resolve`.** better-auth is the authorization server. The app verifies better-auth's access tokens
  itself and reads the person's role live (`lib/clegra-auth.ts`), following the recipe in [auth.md](../auth.md).
- **The installation's schedule in tests.** The low-stock schedule runs as the installation; its tests use the
  development sign-in (`devSignIn` beside the app's own `resolve`), whose tenants are `<installation>@clegra-dev`, each
  seeded with its own copy of the demo company.

The tests run the Clegra app over its real HTTP path on an in-memory PGlite. They cover tenant isolation, the
purchase-cost permission, list filters, sort, search and cursor, and the actions and artifacts.
