# The reference app: a CRM

> Non-normative. Runnable code: [`examples/modelapp/crm`](../../../examples/modelapp/crm). Invented data.

A small sales team's CRM — **companies**, **contacts**, **deals**, **calls** — built the way a developer
already builds a web app: Next.js (App Router), its own sign-in (better-auth: email + password,
organizations as tenants), its own database (Drizzle on Postgres; an embedded PGlite locally). MAP is
added on top in one file, `modelapp/app.ts`, over the functions the pages already use.

**The pitch:** the page's «Mark as won» button and the MCP tool `deal_mark_won` call the same
`markWon(orgId, dealId)` in `lib/crm.ts`. Nothing is written twice; the SDK adds the tenant from the
verified caller, the permissions, the confirmations and the MCP surface.

## Files

| File | What it is |
|---|---|
| `db/schema.ts` | The CRM's tables (every row has `org_id`), `tenants`, `people`, the MAP store table. `db/auth-schema.ts` is better-auth's, generated |
| `lib/db.ts` | Postgres (postgres.js) with `DATABASE_URL`; PGlite in `.data/` without; production without it is an error |
| `lib/crm.ts` | The app's functions: `listDeals(orgId, query)` (filters, search, sort, paging in SQL), `markWon`, `setStage`, `logCall`, `createDeal`, pipeline totals, workspace provisioning |
| `lib/auth.ts`, `lib/session.ts`, `lib/permissions.ts` | better-auth; the signed-in member of the active organization; role → permissions |
| `app/(crm)/…`, `app/sign-in`, `app/embed/pipeline` | Pages and server actions; the board page made to be framed |
| `modelapp/app.ts` | The MAP definition: `createCrmApp({ auth, store })` |
| `modelapp/auth.ts` | Workspace hosts from the environment (`MODELAPP_ISSUERS`, `MODELAPP_RESOURCE`) |
| `test/` | The lib on PGlite (tenants, lists, provisioning) and the MCP surface (`mcp.snapshot.json`) |

## What it declares

| Key | In the CRM |
|---|---|
| `permissions` | `deals.view`, `deals.edit`, `contacts.edit` (members), `deals.values` (owners and admins only: money) — the same list the pages use (`lib/permissions.ts`) |
| `settings` | `follow_up_days` (number, default 7) |
| `entities` | `company`, `contact` (`ref("company")`, last call, last note — **untrusted**), `deal` (stage as `status`, value as `amount` behind `deals.values`, owner as `person`) |
| `actions` | `mark_won` (confirm always, notifies), `set_stage` (`"optional"`), `log_call`, `create_deal`. All `expose: { plain: true }` |
| `pages` | `deals`, `companies`, `contacts`, `deal` (record), `pipeline` (dashboard), `forecast` (custom MCP Apps view), `board` (`url: "/embed/pipeline"`: a real page of the app, framed by hosts) |
| `fragments` | `pipeline_total` (stat), `deals_by_stage` (chart), `closing_soon` (list) |
| `agents` | `sales_assistant` |

## Handlers are thin

```ts
deal: {
  schema: dealSchema,
  permission: "deals.view",
  list: async (q, ctx) => listDeals(await tenant(ctx), q),
  …
},
mark_won: {
  on: "deal", confirm: true, permission: "deals.edit", expose: { plain: true },
  run: async (input, ctx, deal) => {
    await markWon(await tenant(ctx), deal.id, input).catch((e) => refused(e, ctx, { en: `${deal.name} is already closed.`, it: `${deal.name} è già chiusa.` }))
    …
  },
},
```

`q` arrives already checked against the fields' meaning and the caller's field permissions; `listDeals`
turns it into one `WHERE org_id = $1 AND …` query (search only in `q.textFields`), sorted, with an
offset cursor and a total. Bruno (a member: no `deals.values`) never receives `value`, in the pages or
over MCP.

## Two kinds of caller, one tenant column

- **The app's own users** (the app's own `auth.resolve` for better-auth's tokens, see below): the installation is the
  organization id, the person the user id. Names come from the organization's members.
- **A workspace host** (e.g. a Clegra node, `MODELAPP_ISSUERS`): the installation is
  `<installation>@<issuer>`, never an organization. On its first call it gets its own copy of the demo
  data (`provisionWorkspace`: one transaction, idempotent). Its people are named from their tokens and
  remembered in `people` once they own a deal.

Both are just values of `org_id`; `tenants` records which kind each one is.

## Run it

```sh
cd examples/modelapp/crm
npm run setup     # .env.local with generated secrets (if missing), migrations, demo data
npm run dev       # http://localhost:3920 — «Enter as Ada Rossi (sales manager)» on /sign-in
npm test          # lib + MAP tests on in-memory PGlite
```

Demo accounts: Ada Rossi (admin, every permission) and Bruno Neri (member, no money) in *Orbita Sales*;
Elena Conti in *Kestrel Design*, a second organization that sees none of Orbita's records. The password
is `DEMO_PASSWORD` in `.env.local`; with `DEMO_SIGNIN=1` the sign-in page has one-click buttons and the
password never leaves the server.

`npm run db:generate` writes a migration after a schema change; `npm run auth:schema` regenerates
better-auth's tables after a plugin change in `lib/auth-options.ts`. Migrations and seed never run at
start-up.

`test/mcp.snapshot.json` is what MCP clients see (tools, annotations, views, manifest): a change to it is
a change for every client, reviewed as a diff (`UPDATE_SNAPSHOTS=1 npm test` rewrites it).

## Next: MCP for the app's own users

The MCP route (`app/api/modelapp/[...path]`, `modelapp/next`) and the better-auth OAuth server
(`@better-auth/mcp`, `jwt`, `@better-auth/cimd`) come next, so ChatGPT, Claude and any MCP client sign
in with a CRM account.
