# Warehouse — a reference Clegra app

A small warehouse app: products, stock movements and customer orders of a shop. It is an
ordinary Next.js App Router app with its own users, made a Clegra app with the `@clegra/sdk` package, so
Clegra, ChatGPT, Claude or any MCP client can connect to it. All companies, people and data are invented.

## Run it locally

```sh
npm run setup   # writes .env.local (generated secrets), creates the tables, seeds the demo data
npm run dev     # http://localhost:3930
```

No Postgres is needed locally. Without `DATABASE_URL` the app uses PGlite (Postgres in
WebAssembly) in `.data/`. PGlite allows one process at a time, so stop the dev server before
running `db:migrate` or `db:seed`. In production `DATABASE_URL` and `CLEGRA_PUBLIC_URL` are
required: the app refuses to start without them. Every variable is listed in `.env.example`.

## Demo people

With `DEMO_SIGNIN=1`, the sign-in page has one-click «Enter as …» buttons. To sign in by
typing instead, the password is `DEMO_PASSWORD` in `.env.local`. `npm run setup` generates it,
and it is never committed.

| Person | Role | Company |
| --- | --- | --- |
| Ada Fernley — `ada.fernley@aurora.example` | admin | Aurora Hardware (25 products, 62 movements, 12 orders) |
| Luke Marsh — `luke.marsh@aurora.example` | member | Aurora Hardware |
| Sophie Green — `sophie.green@hummingbird.example` | admin | Hummingbird Crafts (6 products, 3 orders) |
| Owen Rivers — `owen.rivers@hummingbird.example` | member | Hummingbird Crafts |

Admins may do everything. Members can see and move stock and see orders. They never see
purchase costs or the stock value, and they can't confirm orders (`lib/permissions.ts`).
The same rules apply in the pages and over MCP.

## How it is built

- **Sign-in and OAuth**: better-auth, with email and password and the organization plugin.
  The tenant is the session's active organization (each organization gets its `tenant` row
  when it is created). The same instance is the authorization
  server for MCP clients, through its `jwt`, `mcp` and `cimd` plugins (`lib/auth.ts`).
- **Data: plain SQL, on purpose.** There is no ORM: one `sql(text, params)` and one
  `transaction(fn)` (`lib/db.ts`) run over a `pg` Pool or PGlite. The schema is `.sql` files in
  `db/migrations`. better-auth's tables come from its own migration plan, in the same database
  (`npm run db:migrate`). The other reference app (the CRM) uses Drizzle; the `@clegra/sdk` package doesn't care.
- **The app's functions** (`lib/warehouse.ts`), such as `listProducts`, `registerMovement` and
  `confirmOrder`, are always scoped by the tenant: an organization, or a Clegra
  company. The pages and server actions call them.
- **The app definition** is `lib/clegra.ts`. It is one `defineApp`, and its handlers call
  those same functions with the tenant the SDK verified (`ctx.installation`):
  - entities `product`, `movement` and `order`;
  - actions `register_movement`, `confirm_order` (always confirmed first) and `create_order`;
  - artifacts, pages and an agent.
- **Who is calling** (`lib/clegra-auth.ts`): the app verifies better-auth's access tokens
  itself in `auth.resolve`, in about 40 lines with `jose`. A token counts only if all of these hold:
  - it is a JWT (`typ: at+jwt`) signed with better-auth's own keys, by its issuer;
  - it was issued for this MCP server alone (`aud`) and has not expired;
  - it is not DPoP-bound and carries the `clegra` scope and the organization;
  - the person is still a member of that organization, with their role read live.
- **People of Clegra companies** (Clegra's core, `CLEGRA_ISSUER` and the other `CLEGRA_*` variables): the SDK verifies
  the core's tokens itself (DPoP). Their tenant is `<company>@<issuer>`, never an organization (`lib/tenants.ts`). Each
  company gets its own copy of the demo data (Aurora Hardware) on its first call, in one transaction. A Clegra person
  is not a better-auth user: their name comes from the token and is kept in `person` when they change something, so
  lists show who did it. What they may do is the warehouse's own roles (`SqlStore`'s third table, migration
  `007_clegra_roles.sql`): a company administrator has everything, a member the defaults until an administrator
  assigns more (`app.roles`).
- **What a host runs as the installation** (the SDK's dev authority's workspace host with no person, in development
  and tests):
  - the schedule `low_stock_check` (every 60 minutes) runs the app-only action `check_low_stock`. It sends a
    notification of the declared type `low_stock` to the company's administrators (`to: "admins"`), once per
    product at or under its reorder level, until it is back in stock (`stock_alert`);
  - the lifecycle: `clegra_installation` keeps the state the host last told (`installation_state`), `clegra_export`
    gives the installation's data as one JSON file, and `clegra_delete` deletes them (idempotent, with counts). These
    are for a workspace host's installations only; an organization's data belong to its own sign-in.
    `db/migrations/006_clegra_lifecycle.sql` also re-runs `SqlStore.schema()`: the SDK's second table (later runs)
    is cleared by every delete.
- **Page actions**: «New order» on the orders list.
- **Wiring**: `app/api/clegra/[...path]/route.ts` (`toNextHandlers`) and `withClegra` in
  `next.config.ts`. The rewrites put `/mcp`, `/.well-known/clegra.json` and the OAuth metadata
  at the root of the site.

## Connect an MCP client

The MCP address is `<site>/mcp`, for example `http://localhost:3930/mcp` locally. The client
finds the authorization server on its own: a 401 response points to
`/.well-known/oauth-protected-resource/mcp`, which names better-auth at `<site>/api/auth`. The
person then goes through these steps:

1. Sign in on `/sign-in`. The demo buttons work here too, and the authorization continues afterwards.
2. Agree on `/oauth/consent`, which shows the app, the organization and what the app may do.
3. The client gets a token for that organization, with the permissions of the person's role.

- **MCP Inspector**: `npx @modelcontextprotocol/inspector`. Choose transport «Streamable HTTP»
  with URL `http://localhost:3930/mcp`, then connect and follow the OAuth flow.
- **Claude and ChatGPT** need a public https address. They identify themselves with a Client ID
  Metadata Document, an https URL. Dynamic client registration is off.
  - Tunnel the local server (e.g. `cloudflared tunnel --url http://localhost:3930`) and set `CLEGRA_PUBLIC_URL` to
    the tunnel's https origin.
  - Then add `<site>/mcp` as a custom connector in Claude (Settings → Connectors) or ChatGPT
    (developer mode → connectors).
- **An access token by script**, for `clegra check` or curl. It runs the real flow over HTTP:
  sign in → authorize (PKCE, `resource`) → consent → token. Credentials come only from the
  environment or `.env.local`. For a demo person, the email is enough:

  ```sh
  CLEGRA_OAUTH_EMAIL=luke.marsh@aurora.example npm run --silent token -- http://localhost:3930
  ```

- **The conformance check**, from the repository root:

  ```sh
  CLEGRA_TOKEN=$(cd examples/warehouse && CLEGRA_OAUTH_EMAIL=ada.fernley@aurora.example npm run --silent token -- http://localhost:3930) \
    npm run clegra:check -- http://localhost:3930
  ```

## Runtime

Nothing is written to disk at runtime: sessions, OAuth clients, signing keys, rate limits and
the SDK's idempotency store (`clegra_store`, also the used site tickets) all live in Postgres.

## In a Clegra client: the app's own site

With Clegra's core configured (`CLEGRA_ISSUER`), a Clegra client shows the warehouse as its own site (spec §5.1): it
frames the real pages (dashboard, stock board, products, movements, orders) at the app's origin, the person signed in
with a one-minute site ticket. `proxy.ts` (`siteProxy`) is the one place that says who may frame a page: the
session's client only, and no one outside a Clegra session, so sign-in and consent can't be clickjacked. The root
layout loads the bridge (`<ClegraSite />`) and starts in the client's theme and language. `lib/session.ts` takes the
Clegra caller (`getClegraCaller`) as a viewer of its company's installation, with the permissions the warehouse's
roles give them there; their changes are recorded with their name.

## Tests

`npm test` uses real better-auth tokens from the in-process OAuth flow, on an in-memory PGlite. It covers:

- tenant isolation, also for Clegra companies (app tokens from a test core, `testCore` of `@clegra/sdk/testing`), and their roles;
- the `004_tenants.sql` migration on a database that already has data;
- the low-stock schedule, its notifications and the lifecycle (state, export, delete), as the installation (`installationClient`);
- the purchase-cost permission;
- list filters, sort, search and the cursor;
- the actions and artifacts;
- the metadata and the 401 response;
- the token checks (another audience, tampered, expired, opaque, DPoP-bound, missing scope or organization);
- role changes and removed members, with tokens issued before;
- the consent steps;
- the app's own site: a site ticket exchanged once for the session, the caller a viewer of the company's installation;
- the conformance suite, also as a Clegra company's person (the site's checks).
