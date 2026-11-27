# The reference app: a CRM

> Non-normative. Runnable code: [`examples/crm`](../../examples/crm). Invented data.

A small sales team's CRM — **companies**, **contacts**, **deals**, **calls** — built the way a developer
already builds a web app: Next.js (App Router), its own sign-in (better-auth: email + password,
organizations as tenants), its own database (Drizzle on Postgres; an embedded PGlite locally). The Clegra
app is added on top in `clegra/`, one file per entity, action, artifact, page and agent, over the functions the pages
already use, assembled in `clegra/app.ts` and served by `clegra/index.ts`.

**The pitch:** the page's «Mark as won» button and the MCP tool `deal_mark_won` call the same
`markWon(orgId, dealId)` in `lib/crm.ts`. Nothing is written twice; the SDK adds the tenant from the
verified caller, the permissions, the confirmations and the MCP surface.

## Files

| File | What it is |
|---|---|
| `db/schema.ts` | The CRM's tables (every row has `org_id`), `tenants`, `people`, the SDK's store table (`clegra_store`). `db/auth-schema.ts` is better-auth's, generated |
| `lib/db.ts` | Postgres (postgres.js) with `DATABASE_URL`; PGlite in `.data/` without; production without it is an error |
| `lib/crm.ts` | The app's functions: `listDeals(orgId, query)` (filters, search, sort, paging in SQL), `markWon`, `setStage`, `logCall`, `createDeal`, pipeline totals, workspace provisioning |
| `lib/auth-options.ts`, `lib/auth.ts` | better-auth: email + password, organizations, and the OAuth server for MCP clients (`jwt` + `mcp` + `cimd`) |
| `lib/site.ts` | The one public address, `CLEGRA_PUBLIC_URL`: the issuer `<origin>/api/auth` and the MCP resource `<origin>/mcp` |
| `lib/session.ts`, `lib/permissions.ts` | Who looks: the signed-in member of the active organization (also inside a Clegra client's frame: the CRM's own sign-in); role → permissions |
| `app/(crm)/…`, `app/layout.tsx`, `proxy.ts` | Pages (pipeline, board, deals, companies, contacts) and server actions: also the CRM's site in a Clegra client (spec §5.1). The root layout loads the bridge (`<ClegraSite />`) and takes the caller's theme and language; `proxy.ts` (`siteProxy`) says who may frame each page |
| `app/sign-in`, `app/oauth/consent` | better-auth's login and consent pages; they also continue an OAuth authorization |
| `clegra/entities/`, `clegra/actions/`, `clegra/artifacts/`, `clegra/components/`, `clegra/pages/`, `clegra/agents/` | One `define*` per file (`defineEntity`, `defineAction`, …): each names the others by their imported handles (`on: deal`, `list: deal`, `badge: openDeals`); `clegra/lib.ts` the shared `tenant()` and `refused()` |
| `clegra/app.ts` | The app definition: `defineApp({ entities: [company, contact, deal], actions: […], pages: […], nav, permissions, settings })`, pure |
| `clegra/index.ts` | The app as it runs: `serveCrm({ auth, clientOrigins, store })` = `serve(crmApp, { auth, store, people, site, clientOrigins })`, and `crm()`, made on first use from the environment |
| `clegra/auth.ts` | The app's own `resolve` for better-auth access tokens and the issuer metadata (`crmAuth()`), the client origins (`CLEGRA_CLIENT_ORIGINS`) |
| `app/api/clegra/[...path]/route.ts`, `next.config.ts` | `toNextHandlers` and `withClegra`: MCP at `/mcp`, metadata under `/.well-known/` |
| `test/` | The lib on PGlite, the MCP surface (`mcp.snapshot.json`), real OAuth tokens (`oauth.test.ts`) |

## What it declares

| Key | In the CRM |
|---|---|
| `permissions` | `deals.view`, `deals.edit`, `contacts.edit` (members), `deals.values` (owners and admins only: money) — the same list the pages use (`lib/permissions.ts`) |
| `settings` | `follow_up_days` (number, default 7) |
| `entities` | `company` (kind `organization`: VAT number as `vatID`, a key filter compared upper-cased without spaces; website as `url`; `erpCustomer`, a `ref.kind("organization")` URI to the same company in another app), `contact` (kind `person`: email as `email`, a key filter compared lower-cased; `ref("company")` as `worksFor`; last call, last note — **untrusted**), `deal` (no kind: the CRM's own; stage as `status`, value as `amount` behind `deals.values`, owner as `person`) |
| `actions` | `mark_won` (confirm always, notifies), `set_stage` (`"optional"`), `log_call`, `link_erp_customer` (takes a record URI of kind `organization`, stores it, never calls the other app), `create_deal`. All `expose: { plain: true }` |
| `pages` | `deals`, `companies`, `contacts`, `deal` (record), `pipeline` (dashboard), `forecast` (custom MCP Apps view) |
| `site` | With `CLEGRA_CLIENT_ORIGINS` (a `serve` option): the CRM's own pages are its site in a Clegra client, framed by those origins only, the person signed in with the CRM's own sign-in |
| `artifacts` | `pipeline_total` (stat), `deals_by_stage` (chart), `closing_soon` (list) |
| `agents` | `sales_assistant` |

## Handlers are thin

```ts
// clegra/entities/deal.ts
export const deal = defineEntity({
  name: "deal",
  schema: z.object({ … }),
  permission: "deals.view",
  list: async (q, ctx) => listDeals(await tenant(ctx), q),
  …
})

// clegra/actions/mark-won.ts
export const markWon = defineAction({
  name: "mark_won",
  on: deal, confirm: true, permission: "deals.edit",
  run: async (input, ctx, record) => {
    await closeWon(await tenant(ctx), record.id, input).catch((e) => refused(e, ctx, { en: `${record.name} is already closed.`, it: `${record.name} è già chiusa.` }))
    …
  },
})
```

`record` is typed from the deal's schema, because the action names the entity by its handle.

`q` arrives already checked against the fields' meaning and the caller's field permissions; `listDeals`
turns it into one `WHERE org_id = $1 AND …` query (search only in `q.textFields`), sorted, with an
offset cursor and a total. Ben (a member: no `deals.values`) never receives `value`, in the pages or
over MCP.

## One kind of caller, one tenant column

Every caller is one of the CRM's own users (its `auth.resolve` for better-auth's tokens, see below): the installation
is the organization id, the person the user id, names come from the organization's members (`serve`'s `people`).
Clegra, ChatGPT and Claude act with a token the CRM issued. The tests serve the same definition with the SDK's
development sign-in (`devSignIn` of `@clegra/sdk/signin`): its tenants are `<installation>@clegra-dev`, each seeded
with its own copy of the demo data. `org_id` is the tenant; `tenants` records which kind each one is.

## Run it

```sh
cd examples/crm
npm run setup     # .env.local with generated secrets (if missing), migrations, demo data
npm run dev       # http://localhost:3920 — «Enter as Alice Morgan (sales manager)» on /sign-in
npm test          # lib + Clegra app tests on in-memory PGlite
```

Demo accounts: Alice Morgan (admin, every permission) and Ben Carter (member, no money) in *Orbit Sales*;
Emma Hayes in *Kestrel Design*, a second organization that sees none of Orbit's records. The password
is `DEMO_PASSWORD` in `.env.local`; with `DEMO_SIGNIN=1` the sign-in page has one-click buttons and the
password never leaves the server.

`npm run db:generate` writes a migration after a schema change; `npm run auth:schema` regenerates
better-auth's tables after a plugin change in `lib/auth-options.ts`. Migrations and seed never run at
start-up.

`test/mcp.snapshot.json` is what MCP clients see (tools, annotations, views, manifest): a change to it is
a change for every client, reviewed as a diff (`UPDATE_SNAPSHOTS=1 npm test` rewrites it).

## MCP for the app's own users: better-auth as the OAuth server

This is the example's own choice. The SDK only asks for `auth.resolve(token) → caller`, and any sign-in works.
better-auth runs with `organization`, `jwt`, `mcp` (scope `clegra`) and `cimd`
(`lib/auth-options.ts`):

- **Clients** are identified by a metadata document (an https `client_id`), as ChatGPT and Claude do. Dynamic
  client registration is off, so nobody can show an arbitrary name on the consent page.
- **The organization goes into the token.** `postLogin.consentReferenceId` reads the session's active
  organization, and `customAccessTokenClaims` writes it as `org`. A person here belongs to one organization, and a
  new session starts in it, so there is no organization step. Without an organization the authorization fails.
- **The pages are the app's own.** `/sign-in` continues the authorization when better-auth sends the person there
  with the signed request, and so do the demo buttons. `/oauth/consent` shows the client's name and id, the
  organization and what it may do, with Allow / Deny.

`clegra/auth.ts` has `resolveUser`, about 40 lines a developer can copy. It accepts a token only when all of
these hold:

- It is a JWT with `typ: at+jwt`, verified against better-auth's JWKS. The JWKS is read in-process and cached, and
  read again for an unknown `kid`.
- It comes from the issuer.
- `aud` is exactly this server.
- `exp` holds, with 30 s of skew.
- It has no `cnf`.
- It carries the `clegra` scope.
- It names an organization.

Then the membership and role are read live, so a role change or a removed member takes effect on the next call. It
returns `{ installation: orgId, person, permissions: permissionsForRole(role) }`. `crmAuth()` puts it next to
`serve` (better-auth's RFC 8414 / OIDC metadata at the root), `authorizationServers` and `resource`.

```sh
T=$(CLEGRA_OAUTH_EMAIL=alice@orbit.example CLEGRA_OAUTH_PASSWORD=… npm run --silent token -- http://localhost:3920)
npm run clegra:check -- http://localhost:3920 --token "$T"     # from the repository root → Conformant.
```

`npm run token` runs the real flow over HTTP: sign in → authorize (PKCE, `resource`) → consent → token. MCP
Inspector connects to `http://localhost:3920/mcp`. Claude and ChatGPT need a public https origin, set as
`CLEGRA_PUBLIC_URL` (a deployment or a tunnel), and then `<origin>/mcp` as a custom connector.
