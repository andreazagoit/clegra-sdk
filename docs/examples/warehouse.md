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
  always take the tenant first. The app definition (`lib/clegra.ts`) calls those same functions with
  `ctx.installation`. Filters, sort, search and the cursor arrive already checked, and the list functions turn them
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
- **Its own site in Clegra.** With Clegra's core configured, `site` in `lib/clegra.ts` makes the app's real pages
  (dashboard, stock board, products, movements, orders) its site in a Clegra client, framed at the app's origin and
  signed in with a one-minute site ticket (spec §5.1). `siteProxy` in `proxy.ts` says who may frame each page (the
  session's client, else no one); the root layout loads the bridge (`<ClegraSite />`) and takes the caller's theme
  and language; `lib/session.ts` takes `getClegraCaller` as a viewer of the company's installation, with the
  caller's permissions.
- **Its own `resolve`.** better-auth is the authorization server. The app verifies better-auth's access tokens
  itself and reads the person's role live (`lib/clegra-auth.ts`), following the recipe in [auth.md](../auth.md).
- **Clegra companies too.** With `CLEGRA_ISSUER` (and the other `CLEGRA_*` variables, `clegraFromEnv`) it also accepts
  the tokens of Clegra's core, verified by the SDK (spec §7, «Clegra tokens»). Such a tenant is `<company>@<issuer>`: a
  `tenant` row of kind `workspace` beside the organizations', which gets its own copy of the demo data on its first
  call. A Clegra person is not a better-auth user, so who registered a movement is a person id of the tenant (their
  pairwise id), named in `person`; what they may do is the app's own roles.

The tests run the Clegra app over its real HTTP path on an in-memory PGlite. They cover tenant isolation, the
purchase-cost permission, list filters, sort, search and cursor, and the actions and artifacts.
