# A second app: a warehouse

> Non-normative. Runnable code: [`examples/apps/warehouse`](../../../examples/apps/warehouse) (its README
> has the setup and the demo people). Invented data. The example is still changing, so the code is the reference
> where the two differ.

A small shop's warehouse: **products**, **stock movements** and customer **orders**. It is an ordinary Next.js App
Router app with its own sign-in (better-auth with organizations, the organization being the tenant), to which MAP was
added. It exists to show that MAP doesn't care about the data layer: the [CRM](crm.md) uses Drizzle, the warehouse
uses **plain SQL**.

What it shows:

- **Plain SQL, no ORM.** The app has one `sql(text, params)` and one `transaction(fn)` over `pg` or PGlite
  (`lib/db.ts`), and its functions (`listProducts`, `registerMovement`, `confirmOrder`, … in `lib/warehouse.ts`)
  always take the tenant first. The MAP definition (`lib/clegra.ts`) calls those same functions with
  `ctx.installation`. Filters, sort, search and the cursor arrive already checked, and the list functions turn them
  into SQL.
- **A field permission.** `product.purchaseCost` carries `permission: "products.cost"`, which admins have and members
  don't. clegra keeps it out of members' rows and records, and refuses it in their filters, sorts and search. The
  `stock_value` fragment, which is computed at purchase cost, requires the same permission.
- **A confirmed action.** `confirm_order` takes all of an order's goods out of stock at once, so it is
  `confirm: "always"`. The person confirms in the host, and a plain client that can elicit is asked by the server.
  A second confirmation of the same order is a `conflict`. `register_movement` and `create_order` are
  `confirm: "optional"`.
- **Kinds.** `product` is kind `product` (SKU as `sku`, sale price as `price`, and a GTIN as `gtin`: a key, filtered
  exactly in SQL; the demo GTINs are in the restricted-circulation range 20–29, so no real product has them).
  `order` is kind `order` (number, date, customer and total as `orderNumber`, `orderDate`, `customer`,
  `totalPrice`). Stock movements have no kind: they are the warehouse's own.
- **An embedded page.** The page `stock` is `url: "/embed/stock"`: a real page of the app, the stock board, framed by
  hosts at the app's public origin and signed in with a one-minute ticket (spec §5.1): `EMBED_HOSTS` and `embed` in
  `lib/clegra.ts`, `embedProxy` in `proxy.ts`, `getEmbedCaller` in `app/embed/stock/page.tsx`.
- **Its own `resolve`.** better-auth is the authorization server. The app verifies better-auth's access tokens
  itself and reads the person's role live (`lib/clegra-auth.ts`), following the recipe in [auth.md](../auth.md).
- **Workspace hosts too.** With `CLEGRA_ISSUERS` (`issuer|jwksUri`, comma-separated) it also accepts a workspace
  host's tokens (a Clegra node), verified by the SDK. Such a tenant is `<installation>@<issuer>`: a `tenant` row of
  kind `workspace` beside the organizations', which gets its own copy of the demo data on its first call. A host's
  person is not a better-auth user, so who registered a movement is a person id of the tenant, named in `person`.

The tests run the Clegra app over its real HTTP path on an in-memory PGlite. They cover tenant isolation, the
purchase-cost permission, list filters, sort, search and cursor, and the actions and fragments.
