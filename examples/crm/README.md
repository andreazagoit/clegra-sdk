# CRM: a Next.js app that is also a Clegra app

This is a small sales team's CRM (companies, contacts, deals, calls). It has its own sign-in (better-auth with
organizations) and its own database (Drizzle on Postgres, or an embedded PGlite locally). The file
`clegra/app.ts` turns it into a Clegra app: an MCP server that ChatGPT, Claude, MCP Inspector or Clegra can connect
to. It uses the same functions the pages use (`lib/crm.ts`). better-auth is also the OAuth server those clients sign
in through. All data is invented. Walkthrough: [docs/examples/crm.md](../../docs/examples/crm.md).

In a workspace host it shows navigation sections («Sales», «Customers»), «New deal» and «New contact» as the deals'
and contacts' page actions (prefilled from the page's filter), and a badge with the open deals (`open_deals`, an
app-only stat). A workspace host that uninstalls it can export a workspace installation's data (`clegra_export`, one
JSON file) and delete them (`clegra_delete`); an organization of the CRM's own users is never touched that way.

Its artifacts reach hosts as A2UI 1.0 surfaces (spec §5.4); `funnel` is drawn by the CRM's own component,
`StageFunnel` (`clegra/funnel-view.ts`), a page the host frames inside the surface and feeds the props, theme and
language.

In a Clegra client the CRM is shown as its own site (spec §5.1): the client frames the CRM's real pages (pipeline,
board, deals, companies, contacts) at the CRM's origin, the person signed in with a one-minute site ticket. Only with
Clegra's core configured (`CLEGRA_ISSUER`). `proxy.ts` (`siteProxy`) says who may frame each page, the root layout
loads the bridge (`<ClegraSite />`) and starts in the client's theme and language, and `lib/session.ts` takes the
Clegra caller as a member of its company's installation with the permissions the CRM's roles give them there.

```sh
npm run setup      # .env.local (generated BETTER_AUTH_SECRET, DEMO_PASSWORD) if missing, then migrate + seed
npm run dev        # http://localhost:3920
npm test           # tests on in-memory PGlite (the OAuth flow included)
npm run typecheck
```

On `/sign-in`, with `DEMO_SIGNIN=1`, there are three one-click buttons: «Enter as Alice Morgan (sales manager)», «Ben
Carter (sales rep)» and «Emma Hayes (Kestrel Design)». The password stays on the server. You can also sign in with
`alice@orbit.example` and the `DEMO_PASSWORD` from `.env.local`.

## Connect an MCP client

The MCP server is at `<origin>/mcp`, for example `http://localhost:3920/mcp`. A client finds better-auth from the
server's metadata, sends the person to `/sign-in` and then to `/oauth/consent`, and gets a token for the person's
organization.

- **MCP Inspector** (locally): `npx @modelcontextprotocol/inspector`. Use the transport "Streamable HTTP" and the
  URL `http://localhost:3920/mcp`, then "Connect". You'll sign in with a demo button and allow the connection.
  This needs an Inspector that sends a client metadata document. One that only registers dynamically can't connect,
  because registration is off.
- **Claude / ChatGPT**: they need a public https address.
  1. Deploy the CRM, or put a tunnel in front of it (e.g. `cloudflared tunnel --url http://localhost:3920`).
  2. Set `CLEGRA_PUBLIC_URL` to that origin and restart.
  3. Add `https://<that origin>/mcp` as a custom connector.

  These clients identify themselves with a client metadata document (CIMD). Dynamic client registration is off.
- **A token for `clegra check`**, through the real flow (credentials only from the environment):

  ```sh
  T=$(CLEGRA_OAUTH_EMAIL=alice@orbit.example CLEGRA_OAUTH_PASSWORD=… npm run --silent token -- http://localhost:3920)
  (cd ../.. && npm run clegra:check -- http://localhost:3920 --token "$T")   # → Conformant.
  ```

| Command | What it does |
|---|---|
| `npm run db:migrate` | Applies the `drizzle/` migrations (to `DATABASE_URL` when set, from any machine) |
| `npm run db:seed` | Creates the demo accounts and data. Safe to repeat |
| `npm run db:generate` | Writes a new migration after a change to `db/schema.ts` |
| `npm run auth:schema` | Regenerates `db/auth-schema.ts` after a better-auth plugin change in `lib/auth-options.ts` (then `db:generate`) |
| `npm run token -- <site>` | Prints an access token for a demo account (see above) |

## Environment (`.env.example`)

| Variable | |
|---|---|
| `CLEGRA_PUBLIC_URL` | The public origin. better-auth (`<origin>/api/auth`, the issuer) and MCP (`<origin>/mcp`) both derive from it. Required in production, https |
| `BETTER_AUTH_SECRET` | Required. Long and random (32 characters at least). The keys of the site tickets and sessions (Clegra) are derived from it too |
| `DATABASE_URL` | Postgres. Required in production (a Neon pooled URL with `sslmode=require` works) |
| `DEMO_PASSWORD`, `DEMO_SIGNIN=1` | The demo accounts' password (used by the seed) and the one-click sign-in |
| `CLEGRA_ISSUER` | Clegra's core, whose tokens are accepted (spec §7, «Clegra tokens»); with it `CLEGRA_REGISTRATION_ID`, `CLEGRA_REGISTRATION_CHALLENGE`, `CLEGRA_ALLOWED_COMPANIES` (`any` or ids) and `CLEGRA_CLIENT_ORIGINS` (the clients that may frame the site). Each company gets its own copy of the demo data |

A missing variable is an error, never a silent fallback.
