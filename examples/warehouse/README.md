# Warehouse — a MAP reference app

A small warehouse app: products, stock movements and customer orders of a shop. It is an
ordinary Next.js App Router app with its own users, to which MAP was added, so ChatGPT,
Claude, Clegra or any MCP client can connect to it. All companies, people and data are invented.

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
  (`npm run db:migrate`). The other reference app (the CRM) uses Drizzle; MAP doesn't care.
- **The app's functions** (`lib/warehouse.ts`), such as `listProducts`, `registerMovement` and
  `confirmOrder`, are always scoped by the tenant: an organization, or a workspace host's
  installation. The pages and server actions call them.
- **The MAP definition** is `lib/clegra.ts`. It is one `defineApp`, and its handlers call
  those same functions with the tenant the SDK verified (`ctx.installation`):
  - entities `product`, `movement` and `order`;
  - actions `register_movement`, `confirm_order` (always confirmed first) and `create_order`;
  - fragments, pages (one is the app's own `/embed/stock` board) and an agent.
- **Who is calling** (`lib/clegra-auth.ts`): the app verifies better-auth's access tokens
  itself in `auth.resolve`, in about 40 lines with `jose`. A token counts only if all of these hold:
  - it is a JWT (`typ: at+jwt`) signed with better-auth's own keys, by its issuer;
  - it was issued for this MCP server alone (`aud`) and has not expired;
  - it is not DPoP-bound and carries the `clegra` scope and the organization;
  - the person is still a member of that organization, with their role read live.
- **Workspace hosts** (a Clegra node, `CLEGRA_ISSUERS`): the SDK verifies their tokens itself.
  Their tenant is `<installation>@<issuer>`, never an organization (`lib/tenants.ts`). Each
  installation gets its own copy of the demo data (Aurora Hardware) on its first call, in one
  transaction. A host's person is not a better-auth user: their name comes from the token and is
  kept in `person` when they change something, so lists show who did it.
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
  - Deploy the app (below), or tunnel the local server and set `CLEGRA_PUBLIC_URL` to the
    tunnel's https origin.
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
  CLEGRA_TOKEN=$(cd examples/apps/warehouse && CLEGRA_OAUTH_EMAIL=ada.fernley@aurora.example npm run --silent token -- http://localhost:3930) \
    npm run clegra:check -- http://localhost:3930
  ```

## Deploy (Vercel + Neon Postgres)

1. Create a Postgres database (for example Neon, in an EU region).
   - The app uses the pooled URL (the `-pooler` host, with `?sslmode=require`).
   - Migrations and the seed run from your machine:

     ```sh
     DATABASE_URL='postgres://…' npm run db:migrate
     DATABASE_URL='postgres://…' DEMO_PASSWORD='…' npm run db:seed
     ```

2. Create a Vercel project with Root Directory `examples/apps/warehouse` and framework
   Next.js. Set these environment variables:
   - `DATABASE_URL`
   - `CLEGRA_PUBLIC_URL`: the production origin, e.g. `https://warehouse.example.com`
   - `BETTER_AUTH_SECRET` (`openssl rand -base64 32`)
   - `DEMO_PASSWORD` and `DEMO_SIGNIN=1`, for a demo
   - optionally `CLEGRA_ISSUERS`: workspace hosts (e.g. a Clegra node) whose tokens are
     accepted, as `issuer|jwksUri`, comma-separated. Each installation gets its own copy of the
     demo data
3. Deploy, then run the token script and `clegra check` against the public URL.

Nothing is written to disk at runtime: sessions, OAuth clients, signing keys, rate limits and
Clegra apps' idempotency store (also the used embed tickets) all live in Postgres. `/embed/*` pages may be
framed only by the hosts declared in `lib/clegra.ts` (`EMBED_HOSTS`), signed in with a one-minute ticket
(spec §5.1); every other page can't be framed at all.

## Tests

`npm test` uses real better-auth tokens from the in-process OAuth flow, on an in-memory PGlite. It covers:

- tenant isolation, also for a workspace host's installations (a host token signed with a local key set);
- the `004_tenants.sql` migration on a database that already has data;
- the purchase-cost permission;
- list filters, sort, search and the cursor;
- the actions and fragments;
- the metadata and the 401 response;
- the token checks (another audience, tampered, expired, opaque, DPoP-bound, missing scope or organization);
- role changes and removed members, with tokens issued before;
- the consent steps;
- the conformance suite.

## Public demo

https://modelapp-warehouse-demo.vercel.app (MCP at `/mcp`). Invented data. The sign-in page has "Enter as …" buttons, so no password is needed.
