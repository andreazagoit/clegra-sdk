# `@clegra/sdk` 0.4 — reference

A Clegra app is a **web app with a plain MCP server** (revision `2026-07-28`, served by the official
`@modelcontextprotocol/server` package) plus the small extensions and profiles in [extensions](extensions/README.md).
This page says what the SDK's definitions become on the wire and what `serve` answers. The rules themselves are in the
extension documents; this page links to them instead of repeating them.

Principle: **agents use MCP tools, interactive and in the background; pages are for people.** A record has one
address, its web URL, which is also its MCP resource URI. The person signs in once, on the app's own page: that one
OAuth login gives the client its MCP token and, by session transfer, a session of the app's pages in the client's own
browser context.

```ts
import { defineApp, serve } from "@clegra/sdk"
import { devSignIn } from "@clegra/sdk/signin"

export const app = defineApp({ name: "jobs", title: "Jobs", description: "Job requests", version: "1.0.0", entities: [job], tools: [getJob, completeJob], pages: [jobsPage, jobPage] })
export const served = serve(app, { origin: "http://localhost:3000", auth: { signIn: devSignIn(app) } })
```

## 1. Definitions

Each thing is defined once, usually one per file, and returns a frozen handle. Things refer to each other by handle.
Labels (`Label`) are a string or a map per language (`{ en: "Job", it: "Lavoro" }`); they are chosen per request by
`io.modelcontextprotocol/acceptLanguage`, else the app's `locale` (default `en`).

### 1.1 `defineEntity`: a record type at its web URL

```ts
const job = defineEntity({
  name: "job",
  title: { en: "Job", it: "Lavoro" },
  plural: "Jobs",                                  // optional
  path: "/jobs/{id}",                              // URI Template on the app's origin: the record's web URL
  schema: z.object({ id: z.string(), title: z.string(), status: z.enum(["open", "done"]), customer: z.string() }),
  card: { title: "title", subtitle: "customer", status: "status" },    // REC-4 roles: title, subtitle, status, amount, date
  get: ({ id }, ctx) => jobs.find(ctx.person, id),                     // the record as this person may see it, or null
  list: (query, ctx) => jobs.list(ctx.person, query),                  // optional: { text?, cursor?, limit } → { rows, next? }
  shareAs: [{ type: "contact", fields: { name: "/customer" } }],       // optional, app-share
  ttlMs: 30_000,                                                       // optional, REC-3
})
```

- `path` names one or more path variables (`/orgs/{org}/jobs/{id}`), each a field of `schema`; no query expression.
  The record's URL is the app's origin + the expanded path ([web-map](extensions/web-map.md) REC-1, REC-2).
- `get` receives the path variables. It is what `resources/read`, the bearer `GET` and every `on: "record"` tool use.
  Return `null` when the record does not exist or this person may not see it (ORG-4).

### 1.2 `defineTool`: what agents and clients call

```ts
const completeJob = defineTool({
  name: "job.complete",
  title: { en: "Complete job", it: "Completa lavoro" },
  description: "Closes a job as done",
  input: z.object({ id: z.string() }),
  annotations: { readOnly: false, destructive: false, idempotent: true },
  entity: job,
  on: "record",                                     // or "collection" (the default)
  recordArg: "id",                                  // the input holding the record's URL (default "id")
  page: jobPage,                                    // where a person does the same
  allow: (ctx) => ctx.person.tenant !== undefined,  // optional: refused when false
  run: async (input, ctx, record) => {
    await jobs.complete(record)
    ctx.changed(openJobs)                           // a badge, a widget, or any record URL
    return { records: [{ entity: job, record }], text: "Done" }
  },
})
```

- **Annotations** are the core's, kept truthful ([confirmation](extensions/confirmation.md) ACT-1): `{ readOnly: true,
  openWorld? }` or `{ readOnly: false, destructive, idempotent?, openWorld? }`. They become `readOnlyHint`,
  `destructiveHint`, `idempotentHint` and `openWorldHint` (`openWorld` defaults to false: the app's own data). A
  read-only tool is listed with `destructiveHint: false, idempotentHint: true`.
- **`output`** (optional) is the tool's `outputSchema`.
- **`on: "record"`**: the input `recordArg` carries the record's URL, or a bare id when the path has one variable
  (MAP-3). The SDK matches it against the entity's path, calls `get`, and passes the record as the third argument;
  a URL of another origin or entity is `invalid_input`, a missing record `not_found`.
- **`confirm`** (ACT-2: tools that send, pay, share, delete for good or change recipients): `{ message(input, ctx,
  record), values?(input, ctx, record) }`. `message` is the summary the person approves, from the app's own data;
  `values` are the resolved values the approval is bound to (CNF-4). A read-only tool cannot have it. See §4.
- **`accepts`** and **`plugins`** ([app-share](extensions/app-share.md)): `accepts: [{ type, title, icon?, mimeTypes?,
  map: { input: "standardField" } }]`, `plugins: [{ target: { url } | { builtin }, recordType, title, icon?, map: {
  input: "/json/pointer" }, urlArg? }]`. A tool with either must have a closed input (`z.strictObject`, SHR-3).
- **`visibility: "app"`** hides the tool from models (`_meta.ui.visibility: ["app"]`).
- **`allow(ctx)`**: whether this person may use the tool now; when false the call is `permission_denied`.
- **`run`** returns `{ data?, text?, records?, links? }` or nothing: `data` is `structuredContent`, `text` the text
  content (default the JSON of `data`), `records` become `resource_link`s at their web URLs, `links` (`{ url, name }`)
  `resource_link`s to pages (PAGE-3). Records a write returns are reported as changed. Throw `AppError(code, message,
  details?)` for an error the caller should see.

**The context** (`ctx`, also given to `get`, `list`, `allow`, badges, widgets):

| Member | What |
|---|---|
| `person` | `{ id, name, email?, tenant? }`, from the grant |
| `grant` | `{ id, clientId, clientName?, person, scopes }` |
| `locale`, `t(label)` | The caller's language and a label in it |
| `has(scope)` | Whether the grant holds a scope (a grant with no `web.*` scope reads only) |
| `origin`, `url(entity, record)` | The app's origin; a record's web URL |
| `changed(...what)` | Record URLs, badge or widget handles this call changed: `_meta["com.clegra/web-map"].changed` and `notifications/resources/updated` |
| `notify(n)` | A notification (§7) to `n.to` (person ids, default the caller) |
| `activity(a)` | A running activity (§7) |
| `source` | For a share: `{ origin }` or `{ builtin }` as the host passed it in `_meta["com.clegra/app-share"].source` (SHR-5); else null |

### 1.3 Pages, badges, widgets

```ts
const openJobs = defineBadge({ name: "open", value: (ctx) => jobs.countOpen(ctx.person) })
const jobsPage = definePage({ name: "jobs", title: "Jobs", path: "/jobs{?status}", role: "list", entity: job, nav: { section: "Work", order: 10 }, badge: openJobs, frame: true })
const jobPage = definePage({ name: "job", title: "Job", path: "/jobs/{id}", role: "record", entity: job, frame: true })
const tile = defineWidget({ name: "open-jobs", title: "Open jobs", sizes: ["small", "medium"], data: (ctx) => ({ title: "Open jobs", value: 12, url: `${ctx.origin}/jobs?status=open` }) })
```

- A page: `path` (URI Template, query expressions allowed at the end), `role` (`list`, `record`, `create`,
  `dashboard`, `settings`, `other`), `entity?`, `nav?: { section?, order }`, `tools?` (tool names: ordering only,
  MAP-1), `badge?`, `frame?` (default false: whether a client may frame it), `allow?(ctx)`.
- A badge: `value(ctx)` → number. A widget: `sizes`, `data(ctx)` → the tile payload of PAGE-6 (`title`, `value?`,
  `unit?`, `trend?`, `rows?`, `url?`). Both may have `allow`.

Pages are the app's own (any framework). For an app without a site, `serve(app, { pages: "generated" })` draws
read-only pages for its records and lists (§5).

### 1.4 `defineAgent`: an agent as a skill

```ts
const triage = defineAgent({ name: "triage", description: "Sorts new jobs", instructions: "…Markdown…", tools: [listJobs, getJob, completeJob], tier: "fast", maxSteps: 30, approval: { change: "ask" }, starters: ["What is open?"], schedules: [{ name: "morning", cron: "0 8 * * 1-5", starter: 0 }] })
```

Served by the official Skills extension as `skill://triage/SKILL.md` (frontmatter `name`, `description`,
`allowed-tools` from the tool handles, `metadata: { com.clegra/agent: agent.json }`, the instructions as body) and
`skill://triage/agent.json` (tier, maxSteps, approval, starters, schedules), each with its SHA-256 digest
([app agents](extensions/app-agents.md)). `agentDigest(files, tools)` computes the AGT-4 approval digest as a client
does; `agentFiles(app)` gives the folder's files.

### 1.5 `defineApp`

```ts
defineApp({ name, title, description, version, locale?, icons?, instructions?, entities, tools, pages, badges, widgets, agents,
  notifications: { "job.assigned": { title: "A job was assigned to you" } },
  sessionTransfer: { link: true } })                                  // optional: also the Clerk-compatible mode
```

It is pure: nothing is served. It checks everything at once and names the place of each problem: names unique and
well formed (app `[a-z][a-z0-9-]{1,39}`, skills `a-b-c`); an entity's path variables and card fields are schema
fields; the app's `title` and `description` 1 to 100 characters in every language (the Server Card's limits); a page's entity and badge, a tool's entity and page, an agent's tools are the app's own; `recordArg` is an
input; every path variable of a tool's page is an input or a variable of its record's path (MAP-2); `accepts` and
`plugins` only on a closed input, with maps naming real inputs and standard fields (SHR-3); a read-only tool is never
confirmed; an agent has 1 to 200 `maxSteps`, at most 6 starters, and schedules with five cron fields and a fixed
minute (no more often than hourly, AGT-8) that name an existing starter; `create_bound_browser_session` and
`create_browser_session` are reserved.

## 2. On the wire

| Definition | Becomes |
|---|---|
| The app | `server/discover`: `serverInfo` (name, version, title, description, icons), `instructions`, `capabilities.extensions`: `com.clegra/web-map` `{ revision: "0.2", origin }`; `com.clegra/app-share` `{ revision: "0.1" }` when a tool or an entity declares sharing; `io.modelcontextprotocol/events` `{ delivery: ["webhook"] }` with notification types; `io.modelcontextprotocol/skills` with agents |
| A tool | A tool with its annotations, `_meta["com.clegra/web-map"]: { entity, on, recordArg?, page? }` (`page` an absolute URI Template), `_meta["com.clegra/app-share"]: { accepts?, plugins? }` (titles translated), `_meta.ui.visibility` when app-only |
| An entity | A resource template `uriTemplate: <origin><path>`, `mimeType: application/json`, `_meta["com.clegra/web-map"].record: { entity, get?, list?, card }` (`get`/`list`: its first read-only record and collection tools), `_meta["com.clegra/app-share"].shareAs`; reads are `cacheScope: private` with `ttlMs` |
| Pages | One resource, `webmap://pages`: `{ pages: [{ url, name, title, role, entity?, nav?, tools?, badge?, frame? }] }`, only those the person may open |
| A badge | The resource `webmap://badges/<name>`: `{ "value": n }` |
| A widget | The resource `webmap://widgets/<name>` with `_meta["com.clegra/web-map"].widget: { sizes }`: the tile payload |
| An agent | A skill (above) |
| Session transfer | The tools `create_bound_browser_session` (when the app has a login; hidden from models) and `create_browser_session` (with `sessionTransfer.link`), marker `_meta["com.clegra/session-transfer"]: { revision: "0.3", mode }` |
| Notification types | `events/list`, `events/subscribe`, `events/unsubscribe` (§7) |

Tool results carry `resource_link`s to records and pages, and `_meta["com.clegra/web-map"].changed` for what changed.

## 3. `serve(app, options)`

```ts
const served = serve(app, {
  origin: "https://jobs.example.com",   // default CLEGRA_PUBLIC_URL; required in production, never taken from a request there
  mcpPath: "/mcp",                      // default
  auth: { signIn },                     // the sign-in module, or { verify, authorizationServers, sessions?, revoke? }
  store,                                // MemoryStore by default; SqlStore for several instances
  audit: (entry) => {},                 // optional hook of the access log
  auditReads: true,                     // log reads too (default true)
  auditDays: 90,                        // how long the log is kept
  clientOrigins: ["https://app.example.com"],  // web origins that may frame `frame: true` pages and post a session redeem
  confirmWaitMs: 25_000,                // CNF-7: how long a retried confirmed call waits for the person
  pages: "generated",                   // the generated pages (default false)
  events: { fetch },                    // the fetch used for webhook delivery (tests)
  bus,                                  // the subscriptions/listen event bus (shared across instances)
  mcp: (server, ctx) => {},             // anything more on each request's McpServer (prompts, resources)
})
```

`auth` with an authorization server of the app's own ([auth.md](auth.md)):

| Member | What |
|---|---|
| `verify(token, request, { resource, scheme })` | Checks signature, expiry and `aud === resource` (the MCP URL); returns the `Grant` (`id` stable per grant: revocation keys on it) or null |
| `authorizationServers` | Named in the protected-resource metadata |
| `sessions?` | `{ read(request) → Person \| null, signInUrl?(returnTo, request) }`: the app's own browser session, born from the person's credentials. Needed for the confirmation page, session transfer, the access log and generated pages |
| `revoke?(grantId)` | Told when the SDK revokes a grant (the person chose «Decline and revoke») |

### Routes

| Route | What |
|---|---|
| `POST <mcpPath>` | MCP, revision `2026-07-28` (earlier revisions refused). Every request needs a token: none → `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="web.read"`; an invalid or revoked one → `401 error="invalid_token"` |
| `GET <mcpPath>/server-card` | The Server Card (SEP-2127), `application/mcp-server-card+json`: `{ $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json", name: "<reversed host>/<app>", title, description, version, icons?, remotes: [{ type: "streamable-http", url }] }`. Nothing of the map (ORG-5) |
| `GET /.well-known/ai-catalog.json` | The AI Catalog v0.9, `application/ai-catalog+json`, the origin proof of ORG-1: `{ specVersion: "0.9", host: { displayName: <title> }, entries: [{ identifier: "urn:air:<host>:<app>:mcp", type: "application/mcp-server-card+json", url: "<origin><mcpPath>/server-card" }] }`. Both: CORS `*`, an hour's cache, an `ETag` (web-map ORG-6) |
| `GET /.well-known/oauth-protected-resource` and `…/oauth-protected-resource<mcpPath>` | RFC 9728: `resource`, `authorization_servers`, `scopes_supported` (`browser_session` only with the link mode), `bearer_methods_supported`, `resource_name` |
| `/oauth/*`, `/.well-known/oauth-authorization-server`, `/oauth/grants` | The sign-in module, with `auth.signIn` ([auth.md](auth.md)) |
| `GET`/`POST /session-transfer/<code>`, `POST /session-transfer/sign-out` | Session transfer (§6) |
| `GET`/`POST /confirm/<id>` | The confirmation page (§4) |
| `GET /access/log` | The signed-in person's access log as a JSON download (`{ keptDays, entries }`), from a session of their own credentials |
| `GET <record URL>` with `Authorization: Bearer` (or `DPoP`) | The record's JSON, the same as `resources/read`, with `Vary: Authorization` and `Cache-Control: private, no-store`; `401` with `WWW-Authenticate` for a bad token; `404` for none (REC-1) |
| `GET <record URL>`, `GET <list page>` without a token | With `pages: "generated"`: the generated page (§5). Otherwise not the SDK's: `served.handle` returns null and the app's own page answers |

### Scopes and step-up

Each tool needs one scope of the [access profile](extensions/access.md): read-only tools `web.read`, tools with
`confirm` `web.irreversible`, other changes `web.write`; the session tools their own (`bound_browser_session`,
`browser_session`). A call above the grant answers `403` with `WWW-Authenticate: Bearer error="insufficient_scope",
scope="…"` (the official package's `scopeChallenge`), so the client asks again (ACC-2). A revoked grant is refused at
once.

## 4. Confirmation

For a tool with `confirm` ([confirmation](extensions/confirmation.md)):

1. The call is digested: SHA-256 of the canonical JSON of tool, arguments, `client_id` and subject (CNF-2). A
   pending confirmation lives 5 minutes (CNF-6), with the app's `message` and `values`.
2. A client that declared URL-mode elicitation (`clientCapabilities.elicitation.url`) gets `resultType:
   "input_required"` with `inputRequests.confirm` (mode `url`, `url: <origin>/confirm/<id>`, the `message`) and
   `requestState: <id>`. `action: "accept"` alone runs nothing (CNF-1).
3. Any other client gets the tool error `confirmation_required` with `url`, `expiresAt` and a `resource_link` to the
   page (CNF-8); the same call repeated by the same subject and client, with the same arguments, runs once confirmed.
4. The page `/confirm/<id>` needs the app's own session of the token's subject (`auth.sessions`, or the sign-in's
   login), never a transferred one; it sends `frame-ancestors 'none'`, shows the message, every argument, the client
   and the start time, and offers «Confirm», «Decline» and «Not you? Decline and revoke» (which revokes the grant).
   Posts need the page's nonce and a same-origin request.
5. The retry runs the tool once; a repeat with the same `requestState` returns the first result (kept one hour). A
   retry while the person has not decided waits up to `confirmWaitMs` (CNF-7). Errors: `confirmation_declined`,
   `confirmation_expired`, `confirmation_stale` (the `values` changed, CNF-4).

The run and the decision are in the access log with the confirmation's id, digest and time.

## 5. Generated pages

With `pages: "generated"`, a `GET` without a bearer token on a record URL draws the record (title, subtitle, status,
every field), and a `list` page of an entity with `list` a table linking each record. The viewer is the app's own
session or a transferred one (with its banner); without either the page redirects to `sessions.signInUrl` (else
`401`). `frame-ancestors` is `clientOrigins` for `frame: true` pages, else `'none'`. They are read-only: changes are
tools.

## 6. Session transfer

The [profile](extensions/session-transfer.md), both modes. The tools return `{ url, expiresAt }`:

- **Strong** (`create_bound_browser_session { target, challenge }`, scope `bound_browser_session`, hidden from
  models): a 256-bit code for 60 seconds, bound to the grant, client, target and challenge. The client posts
  `verifier=…` to `url` in its browser context. There is no other way in: a `GET` shows no form (`400`, the code
  stays valid for the client), and a `POST` without the right verifier is refused and burns the code.
- **Clerk-compatible** (`create_browser_session { target }`, scope `browser_session`, only with
  `sessionTransfer.link`): a one-time link for 5 minutes, redeemed only through the interstitial («You are entering as
  X through Y, started at hh:mm. Continue / This is not me»).

`target` must be on the app's origin. A redeem is refused when another website initiated it (an `Origin` other than
the app's or a `clientOrigins` one), and never replaces another person's session (`409`, the code stays valid). The
result is the SDK's own **transferred session**: the cookie `__Host-clegra-transferred`, `Secure; HttpOnly; Path=/;
SameSite=Lax` (`SameSite=None; Partitioned` when redeemed in a frame), 1 hour idle, 8 hours at most, ended when the
grant is revoked. Then `303` to `target`. Secure means https, or outside production a loopback host (`localhost`,
`*.localhost`, `127.0.0.1`, `[::1]`: browsers' secure contexts), so a local stack frames it like production; over
other http the cookie is `clegra-transferred`, `SameSite=Lax`. A redeem `POST` with no form is refused like one without
its verifier (`400`; an unknown or used code `410`).

The app's pages read the viewer with `served.session(request)`: `{ person, transferred: null }` for the app's own
session, `{ person, transferred: { grant, clientId, clientName, scopes } }` for a transferred one. They show
`served.banner(session, request)` (who, through which client, «Sign out») and enforce SES-6 on their own actions:
writes only with `web.write` in `transferred.scopes`, account-security actions only with the app's own session.

## 7. Notifications and activities

`defineApp({ notifications: { type: { title } } })` declares the types; `ctx.notify({ type, title, body?, url, id?,
dedupe?, to? })` and `ctx.activity({ id, type, title, status?, progress?, state, url?, tools?, to? })` (or
`served.notify(to, n)` outside a call) emit `com.clegra.app.notification` and `com.clegra.app.activity`
([event types](extensions/event-types.md)). Delivery is by webhook: a client calls `events/subscribe { name,
arguments?: { types? }, delivery: { mode: "webhook", url, secret? } }` → `{ subscriptionId, secret }` (an https URL
that resolves to public addresses; loopback http only outside production) and `events/unsubscribe { subscriptionId
}`. Each occurrence `{ eventId, name, timestamp, data }` is posted with `webhook-id`, `webhook-timestamp` and
`webhook-signature: v1,<base64 HMAC-SHA256>` (Standard Webhooks), titles in the subscriber's language, cut to 120
characters (`body` to 500). `url` must be a page or record of the app (EVT-4). A `410` answer ends the subscription;
revoking the grant ends them all.

## 8. Access log and revocation

Every change, confirmation, session transfer and (unless `auditReads: false`) read is a line `{ time, person, grant,
client, kind, tool?, record?, outcome, confirmation?, target? }` kept `auditDays` in the store and passed to `audit`
(ACC-7). `served.log(person)` reads it; `/access/log` gives it to the person.

`served.revoke(grantId)` refuses the grant's tokens, ends its transferred sessions, cancels its pending
confirmations and its event subscriptions, and tells the authorization server (`signIn.revokeGrant`, or
`auth.revoke`). A revocation in the sign-in module (grants page, refresh reuse, RFC 7009) reaches `serve` the same way.

## 9. Errors

Tool errors are `isError: true` with `structuredContent.error: { code, message, … }`: `not_found`, `invalid_input`,
`permission_denied`, `conflict`, `rate_limited` (and your own `AppError` codes), `internal` (an unexpected exception:
logged, never shown), `insufficient_scope` (session tools), and the confirmation codes of §4. Protocol and HTTP errors
are MCP's and OAuth's.

## 10. Stores

`Store` is `get`, `set(key, value, ttl?)`, `add` (only if absent), `take` (read and delete), `delete`, `list(prefix)`,
each atomic. `MemoryStore` keeps one process; `SqlStore(query, { table? })` keeps one Postgres table:
`SqlStore.schema()` returns its idempotent `CREATE TABLE IF NOT EXISTS` (run it from your migrations) and `sweep()`
deletes expired rows (run it from a cron job). `query(text, params)` is one line over `pg`, `postgres` or PGlite.

## 11. The served app

| Member | What |
|---|---|
| `app` | The app |
| `fetch(request)` | Every route above; `404` for any other path |
| `handle(request)` | The same, `null` for a path that is not the SDK's |
| `origin(request?)`, `mcpUrl(request?)` | The public origin, the MCP URL |
| `session(request)`, `banner(session, request)` | §6 |
| `revoke(grant)`, `log(person)` | §8 |
| `changed(...what)` | `notifications/resources/updated` for record URLs, badges, widgets, from outside a call |
| `notify(to, n)` | §7 |
| `url(entity, record, request?)` | A record's web URL |

## 12. Adapters and testing

- `@clegra/sdk/node`: `listen(served, { port?, host?, log? })` on Node's HTTP server; `toNodeHandler(served)` for any
  Node server (given `next`, other paths go on).
- `@clegra/sdk/express`: `app.use(clegraMiddleware(served))` (no body parser before it on the SDK's routes).
- `@clegra/sdk/next`: `toNextHandlers(served, { mount?, publicUrl? })` for `app/api/clegra/[...path]/route.ts`;
  `withClegra(nextConfig, { mount?, signInPath? })` (or `clegraRewrites`) routes `/mcp`, the Server Card, the AI
  Catalog, the OAuth metadata, `/oauth/*`, `/session-transfer/*`, `/confirm/*` and `/access/log` to that route;
  `recordProxy({ mount? })` in `proxy.ts` rewrites bearer `GET`s of record paths to it (REC-1), leaving the pages
  alone.
- `@clegra/sdk/testing`: `testClient(served, { token, elicitation?, extensions?, language?, origin? })` speaks revision
  `2026-07-28` to `served.fetch` (`discover`, `listTools`, `call(name, args, { inputResponses?, requestState?, _meta?
  })`, `read`, `readJson`, `listResources`, `listTemplates`, `listSkills`, `rpc`); `confirmOnPage(served, url, cookie,
  decision?)` is the person's click on the confirmation page. Tokens come from `devSignIn(app).dev.token({ person,
  scopes })`.

## 13. Conformance: `npx @clegra/sdk check`

`npx @clegra/sdk check <url> --token <token> [--read-token <token>] [--confirm-call <JSON>]` runs the extensions'
conformance scenarios against a running app and prints the adoption level it finds ([levels](extensions/README.md)):
**A** (map: the settings object, tool `_meta`, record templates, the pages resource, the bearer `GET`, nothing public
but the card), **B1** (confirmed actions: the URL elicitation or the fallback for the call given), **B2** (hardened
access: step-up with a read-only token, the protected-resource metadata), **C** (one sign-in: the session-transfer
tool, the refusal without `challenge`, a strong-mode code useless without its verifier). A level is what the check finds, never a claim.
`npx @clegra/sdk init` sets up a Next.js app ([start-next.md](start-next.md)).
