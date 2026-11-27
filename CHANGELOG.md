# Changelog

Clegra apps and the `@clegra/sdk` package. Newest first. Versions before 1.0 are prereleases on the
npm dist-tag `next`. Entries below «Two scoped packages» keep the names of their time (the unscoped `clegra` package
and its `clegra/ui`, the `modelapp` package, docs/map): they are history.

## 0.4.0-next.6 (2026-11-28)

- Local stacks work like production. Outside production, a loopback host (`localhost`, `*.localhost`, `127.0.0.1`,
  `[::1]`, which browsers treat as secure contexts) gets the secure cookies: the transferred session, the password
  and the development sign-in are `__Host-` prefixed and `Secure`, and a session redeemed in a client's cross-site
  frame on http loopback is `SameSite=None; Partitioned` and survives the frame's next load (tested in Chromium:
  a client on `http://localhost` framing an app on `http://app.localhost`). In production nothing changes: https only.
  New export: `secureContext(origin)` from `@clegra/sdk/signin`.
- Development tokens are accepted on `*.localhost` too (they stay refused anywhere but a loopback address).
- `POST /session-transfer/<code>` with no form body answered `500`; it is refused like a redeem without its
  verifier (`400`, the code burnt), an unknown code `410`. The confirmation page's `POST` likewise never fails on a
  missing form.
- The conformance check on a local stack: when the checked URL is http on a loopback name (`localhost`, one label
  under `.localhost`, `127.0.0.1`, `[::1]`), same-origin http URLs count where ORG-2 wants https, and the report says
  «local http» (`Report.localHttp`). Any other http address, and every https one, stays strict.

## 0.4.0-next.5 (2026-11-28)

- **Fix.** The consent's «Allow» and «Deny» could not reach a client on another origin in a real browser: the page's
  CSP said `form-action 'self'`, and browsers check `form-action` on the 303 that sends the person back to the
  redirect_uri, so the navigation was blocked and no link could complete. The consent page now allows `'self'` plus
  the checked redirect_uri's origin (its scheme for a custom one, `com.example.app:`); every other page keeps
  `'self'`. A browser test (`npm run test:browser`, Playwright's Chromium) drives the sign-in, the consent (both
  answers, to a callback on another origin) and the confirmation page.
- **Discovery by the standards.** `/.well-known/ai-catalog.json` is an AI Catalog v0.9 (the release candidate of
  v1.0), served as `application/ai-catalog+json`: `{ specVersion: "0.9", host: { displayName }, entries: [{
  identifier: "urn:air:<host>:<app>:mcp", type: "application/mcp-server-card+json", url: "<origin>/mcp/server-card"
  }] }`, replacing the old `{ version, mcpServers }` shape that hosts reading the catalog could not use (adding an app
  by its site address failed). The Server Card carries the `$schema` SEP-2127 requires
  (`https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json`). Both answer with the discovery CORS
  (also to a preflight), an hour's cache and an `ETag` (`304` on `If-None-Match`). New exports: `SERVER_CARD_SCHEMA`,
  `AI_CATALOG_TYPE`, `AI_CATALOG_SPEC_VERSION`.
- `defineApp` refuses an app `title` or `description` longer than 100 characters in any language: the Server Card's
  limits.
- The conformance check: `A.server-card` requires the card's `$schema`, `name`, `version` and `description`;
  `A.ai-catalog` requires the catalog's media type, `specVersion` and an entry of the Server Card's type whose `url`
  is the card (or whose inline `data` has the MCP endpoint as a remote). `A.badges-widgets` requires a tile's `url`
  and its rows' `url` on the app's origin.
- web-map ORG-2 says which URLs it covers: the navigable ones (pages, record URLs, a tool's page, a tile's links); a
  counter's or tile's own URI is an MCP resource URI, read on the same server and never navigated, of any scheme.

## 0.4.0-next.4 (2026-11-27)

- **Security.** Session transfer, strong mode: a copied redeem URL could sign its holder in as the person, without the
  verifier. 0.4.0-next.0 to next.3 showed the interstitial (with its nonce) on a `GET` of any code, the strong mode's
  included, and the redeem `POST` checked the verifier only when one was sent: a `GET`, then a `POST` of «Continue»
  with that nonce, created the session (against SES-2 and SES-3). Now a strong-mode code redeems only by a `POST` with
  its verifier: a `GET` answers `400` with no form and no nonce (the code stays valid for the client), and a `POST`
  without the right verifier is refused and consumes the code, so there is no second guess. Only the link mode keeps
  the interstitial, and a `verifier` field there is refused. Upgrade every app that serves session transfer; a
  strong-mode code lives 60 seconds, so no code issued before the upgrade outlives it.
- The conformance check (`npx @clegra/sdk check`) tests it: `C.bound-get` (a `GET` on a strong-mode code offers no
  form and sets no cookie) replaces `C.interstitial`, and `C.verifier` also posts the interstitial's «Continue»
  without a verifier.

## 0.4.0-next.3 (2026-11-27)

- Outside production (`NODE_ENV` is not `production`, read from the app's own environment, never from the request),
  the sign-in accepts a Client ID Metadata Document and its `jwks_uri` at http on a loopback name (`localhost`,
  `*.localhost`, `127.0.0.1`, `[::1]`, the issuer's own rule), fetched without the public-address check: a client on a
  local stack (`http://core.localhost:3000/oauth/client.json`) can sign in and get per-person links. Any other http
  host and private non-loopback addresses stay refused. In production nothing changes: https on a public host, with
  no option to relax it.
- The authorize error page says why a `client_id` was refused.

## 0.4.0-next.2 (2026-11-27)

- `SqlSignInStore` writes its values as a `text` parameter cast in SQL (`$n::text::jsonb`). Over postgres.js, which
  encodes a parameter by the type the server infers for it, a value sent to `$n::jsonb` was JSON-encoded a second time:
  an account was stored as a jsonb string and the password login refused it («wrong email or password»). Over
  postgres.js every value 0.4.0-next.1 or earlier wrote with `set` is such a string; repair a table once, before the
  new version writes to it: `UPDATE clegra_signin SET value = (value #>> '{}')::jsonb WHERE jsonb_typeof(value) = 'string'`.
  PGlite and node-postgres were not affected.
- The SQL stores (`SqlStore`, `SqlSignInStore`) are tested on PGlite and on a real Postgres through postgres.js,
  prepared or not (`npm run test:postgres`, a scratch container).

## 0.4.0-next.1 (2026-11-27)

- `SqlSignInStore` reads its `jsonb` values as text, so a driver that parses `jsonb` itself (postgres.js, PGlite) no
  longer breaks a stored string.
- A repeat of a confirmed call (the same `requestState`) returns its first result before the record is read again:
  a confirmed delete repeated after it ran no longer answers `not_found` (CNF-6).
- The password login counts only wrong attempts against its limit (five per address in 15 minutes).

## 0.4.0-next.0 (2026-11-27)

A Clegra app is now a **web app with a plain MCP server plus small MCP extensions** (docs/extensions): web-map,
app-share, and the session-transfer, access, app-agents, confirmation and event-types documents. Breaking, with no
compatibility path: the package's own protocol is gone.

- **MCP `2026-07-28` only**, on the official `@modelcontextprotocol/server` (`server/discover`, multi round-trip
  requests, `subscriptions/listen`, the Skills extension). Earlier revisions are refused.
- **New definitions**: `defineEntity({ path, card, get, list?, shareAs? })` (a record type at its web URL),
  `defineTool({ annotations, entity, on, recordArg, page, confirm, accepts, plugins, visibility, allow, run })`,
  `definePage({ path, role, entity, nav, tools, badge, frame, allow })`, `defineBadge`, `defineWidget`, `defineAgent`
  (a skill), `defineApp({ …, notifications, sessionTransfer })`. `run` returns `{ data, text, records, links }`; the
  context has `person`, `grant`, `has`, `url`, `changed`, `notify`, `activity`, `source`.
- **What replaced what**:
  - the JSON manifest (`/.well-known/clegra.json`) and its JSON Schema → `server/discover`, tool and template `_meta`,
    the per-person `webmap://pages` resource; discovery by the Server Card (`/mcp/server-card`) and the AI Catalog
    (`/.well-known/ai-catalog.json`);
  - `clegra://` record URIs, the resolver and cross-app references → records at their own `https` URLs (MCP resource
    templates, and a bearer `GET` on the URL itself);
  - the OpenAPI index and `POST /operations/<tool>` → MCP tools only;
  - view tickets, the site's bridge, `siteProxy`, `<ClegraSite />`, `site`, MCP Apps views generated by the SDK, A2UI
    artifacts and components → the app's own pages (or `pages: "generated"`), session transfer for opening them
    signed in, widgets and badges as resources;
  - effects, `confirm: "always" | "optional"`, host-signed confirmation proofs and later runs → truthful core
    annotations and `confirm: { message, values }`, verified by the app on its own page (URL-mode elicitation, or the
    `confirmation_required` fallback);
  - kinds, `as` fields, third-party kinds and targets → app-share (`accepts`, `plugins`, `shareAs`);
  - schedules, later runs, lifecycle tools (`clegra_export`, `clegra_delete`, `clegra_installation`), settings,
    installations, tenants `<installation>@<issuer>` and permissions → the app's own cron jobs and data; `ctx.person`
    (with an optional `tenant`), the grant's scopes and `allow`;
  - notifications through a host → the event types `com.clegra.app.notification` and `com.clegra.app.activity`
    delivered by webhook (`events/list`, `events/subscribe`, `events/unsubscribe`);
  - agents in the manifest → skills with `agent.json`, approved by digest (`agentDigest`).
- **`serve(app, { origin, mcpPath, auth, store, audit, clientOrigins, confirmWaitMs, pages, events, bus, mcp })`**:
  scopes per kind (`web.read`, `web.write`, `web.irreversible`) with the standard step-up, the confirmation page
  (`/confirm/<id>`), session transfer in both modes (`create_bound_browser_session`, and `create_browser_session`
  when the app offers it; `/session-transfer/<code>` with the interstitial; the SDK's own transferred-session
  cookie), the access log (`served.log`, `/access/log`), revocation (`served.revoke`), `served.session` and
  `served.banner` for the app's pages, generated read-only pages. `auth` is the sign-in module or `{ verify,
  authorizationServers, sessions, revoke }` (replacing `auth.resolve`, `auth.public`, `auth.anonymous`).
- **The sign-in module** takes the app, grants the access profile's scopes (each on its own consent line), returns
  a `Grant` from `verify`, serves the grants page (`/oauth/grants`), refreshes for 12 hours without `offline_access`,
  and tells `serve` of every revocation (`onRevoke`). Removed: personal keys, `response_mode=web_message`, framed
  sign-in and consent, `permissionsOf` (now `active`), development confirmation proofs.
- **Stores**: one `Store` (`get`, `set`, `add`, `take`, `delete`, `list`), `MemoryStore` and `SqlStore` (one table).
- **Adapters**: `@clegra/sdk/next` gains `recordProxy` (bearer reads of record URLs) and loses `siteProxy` and
  `ClegraSite`; `listen` and `toNodeHandler` use `served.handle`.
- **Testing**: `testClient(served, { token })` speaks `2026-07-28`; `confirmOnPage`. Removed: `installationClient`,
  `deviceKey`.
- **The CLI**: `npx @clegra/sdk check <url> --token …` computes the adoption level (A, B1, B2, C) against a running
  app; `npx @clegra/sdk init` writes a Next.js app on the new API. `@clegra/sdk/spec`, `/spec/protocol`,
  `/spec/kinds`, `clegra.schema.json` and `kinds.json` are gone.
- The examples (crm, shipments, warehouse) and their docs are removed; the package has no workspaces (`typecheck:all`
  and `test:examples` gone, `test:all` = unit + Next). The docs name Clegra's own apps as the examples: a job-requests
  app and an accounting-software connector on @clegra/sdk, an ERP connector that is a plain MCP server with its own
  OAuth 2.1. The tests link @clegra/sdk to the package itself (`test/self-link.ts`).


## 0.3.0-next.0 (2026-11-27)

The redesign's second part: the definition apart from its runtime, one file per thing, a core on Web APIs. Breaking,
with no compatibility path.

- **The definition apart from the runtime** (spec §1): `defineApp(def)` is pure: it checks everything at once and
  returns the app (`kind: "app"`, `manifest()` as defined, with MCP at `/mcp`, no authorization server and no site;
  `uri`, `artifactUri`, `parseUri`); nothing is served. `serve(app, { auth, store, people, site, clientOrigins, path,
  mcp })` is the runtime: those options moved out of `defineApp`. It returns the served app (`fetch`, `manifest()`
  as hosts read it, `openapi()`, `start()`, `dev`, `runLater`, `site`, `app`).
- **One file per thing**: `defineEntity`, `defineAction`, `defineArtifact`, `defineComponent`, `definePage` and
  `defineAgent` take one thing with its `name` and return a handle; things name each other by handle, never by a
  string. `defineApp` takes lists (`entities: [deal]`, `actions: [...]`, `components`, `artifacts`, `pages`,
  `agents`, `schedules: [{ name, action, every, maxSeconds? }]`) and refuses a handle that is not one of its own.
  An action's `on` is an entity handle (its `record` typed from the schema); a record action shown on the record
  template is `featured: true` (the entity's `record` keeps only `fields`); «+ Nuovo» is the action's `creates:
  thing | { of, title }` (the entity's and the artifact's `create` are gone); a Home widget is the artifact's
  `widget: true | { sizes, size }` (`defineApp`'s `widgets` is gone); an artifact's `component` and `actions`, a
  page's `list`/`record`, `actions` and `badge`, a dashboard item's `{ artifact, params?, size? }` (an entity handle
  for its record card), `nav` pages and an agent's `uses` are handles. Permissions, settings, kinds and notification
  types stay maps by id. `ctx.uri` and `ctx.changed` take an entity handle or its name.
- **The development sign-in is the sign-in module's** (`devSignIn(app, { issuer?, resource?, people?, installation?,
  code?, clientOrigins? })` of `@clegra/sdk/signin`), replacing `auth.dev` and the SDK's own development
  authorization server: a dev login of test people with a console code, then the module's consent and tokens (no
  dynamic registration, no key file: keys in memory); `served.dev.token(…)` signs development tokens (a development
  workspace host with `host: "workspace"`, the installation-level caller with no person) and
  `served.dev.confirmation(…)` its confirmation proofs. Their tenants stay `<installation>@clegra-dev`; their
  audience is the sign-in's `resource` (default `http://localhost:3000/mcp`), never the address a request reached.
  Refused in production; development tokens count from loopback callers only. Removed: `app.devToken`,
  `app.devConfirmation`, `AuthOptions.dev`, `DevOptions`, `CLEGRA_DEV_KEY`.
- **A core on Web APIs**: no module of Node's own in the core (`server`, `auth`, `views`, the store, the sign-in
  module); `argsHash` is async; `useHostLookup` gives the core the runtime's DNS resolver (the adapters set it;
  without one a client's host name is refused, never fetched unchecked). `@clegra/sdk/node`: `listen(served)` and
  `toNodeHandler(served)`; new `@clegra/sdk/express`: `clegraMiddleware(served)` (the app's routes, everything else
  to the next middleware). `toNextHandlers(served)` no longer refuses the development sign-in (its login works,
  its development tokens never count there). `testClient(served)`, `installationClient(served)`;
  `ExportedFile.body` is a `Uint8Array`.
- **The index as OpenAPI 3.1** (spec §7, «The index as OpenAPI»): `GET <path>/openapi.json`, every operation a plain
  client may call as `POST <path>/operations/<tool>` (the same caller, checks and results as its MCP tool;
  `Idempotency-Key`; errors with the status of their code), with `x-clegra-effect`, `x-clegra-confirm`,
  `x-clegra-entity`, `x-clegra-read`, the pages as `x-clegra-pages`, and the sign-in as its security scheme.
  `withClegra` and `toNextHandlers` route `/openapi.json` and `/operations/…`.
- `clegra init` writes a `clegra/` folder (an entity, an action, a page, `app.ts`, `index.ts` with `serve`) and a
  route over `toNextHandlers(served)`.
- The examples (CRM, warehouse, shipments) are one file per thing.

## 0.2.0-next.0 (2026-11-27)

The redesign's first part (apps never use Clegra accounts). Breaking, with no compatibility path.

- **The sign-in module, `@clegra/sdk/signin`** (spec §7 «Your sign-in»): `createSignIn(definition, { issuer, resource,
  login, permissionsOf, store, keys, clientOrigins })` is the app's own OAuth 2.1 authorization server on top of its
  login, and `auth: { signIn }` serves it. Authorization code with PKCE S256; clients by Client ID Metadata Document
  (public or `private_key_jwt`), no dynamic registration; RFC 8414 metadata, RFC 8707 `resource`, RFC 9207 `iss`; the
  consent page in the person's language; `at+jwt` access tokens (EdDSA, `jwks_uri`, ten minutes, `aud` the MCP
  address), DPoP-bound when the token request carries a proof; refresh tokens rotated, reuse ends the delegation;
  RFC 7009; `response_mode=web_message` to the configured client origins (linking inside a workspace client's frame);
  personal keys (`signIn.keys`) for background work; `signIn.links` and `signIn.forget` for the app's own screens. What
  a token allows is read live (`permissionsOf`, narrowed to the consented scopes). `passwordLogin` is a ready-made
  login (email and password, PBKDF2, a session cookie that works in a cross-site frame) for an app that has none;
  `frameCookie` writes such a cookie for any login; `MemorySignInStore` and `SqlSignInStore` (one table,
  `SqlSignInStore.schema()`) keep what it issued, as hashes. Web APIs only.
- **No Clegra identity in an app**: removed `auth.clegra`, `clegraFromEnv`, `clegraTenant`, the core's app,
  delegated, automation and confirmation tokens and their DPoP checks, `ctx.actor`, events (`/clegra/events`,
  `manifest.events`), the registration document (`/.well-known/clegra-app.json`), the app's roles of Clegra companies
  (`app.roles`, `clegra_roles`, `manifest.rolesTool`, `RoleStore`, `MemoryRoles`, `SqlStore`'s roles table), and from
  `@clegra/sdk/testing` `testCore` and `deviceKey().confirm`. Conformance takes a token the app's own sign-in issued
  (`checkApp({ token })`); its `clegra` caller, `mcp.confirm` and `site.ticket` are gone.
- **The site in a workspace client's frame, signed in by the app** (spec §5.1): `site: { start }` and the app's
  `clientOrigins`; every page framable by those origins only (`siteProxy`, `siteFraming`); the person signs in with
  the app's own sign-in inside the frame. Removed: site tickets (`clegra_site`, `/clegra/site` exchange, session,
  context, renewal), `site.secret`, `site.sessionSeconds`, `getClegraCaller`, `siteGuard`, `SiteError`. The bridge
  (`/clegra/site/bridge.js`) reports the location and applies the client's theme and language.
- View tickets (spec §5.3) are for any signed-in person and one of the app's `clientOrigins`.
- **Writes reach every client** the app signed in (`expose.plain` defaults to true for writes too).
- **The index profile**: every action of the manifest carries `effect` (`read`, `write`, `irreversible`).
- `withClegra` and `toNextHandlers` route the sign-in module (`/oauth/*`) and, with `signInPath`, the password login.
- **Two getting-started guides**, `docs/start-javascript.md` and `docs/start-next.md`, replace `docs/quickstart.md`
  (both in the package).

## 0.1.0-next.12 (2026-11-25)

- Public operations (spec §7): signing in is not mandatory for an app. `auth.public: { installation }` serves a call
  without a token, in production too, and it reaches only the actions declared `public: true` (global, no permission,
  for every client; no record, page or artifact). A public write is always confirmed (`confirm: "always"`, else refused
  at definition); the manifest says `public: true`. `auth.anonymous` stays a local demo's, refused in production.

## 0.1.0-next.11 (2026-11-24)

- The generated view writes dates and date-times in the reader's locale (`ctx.locale`, the host context's): a field
  declared `z.iso.date()` or `z.iso.datetime()` reaches the view's list and record with its `format`, and shows as
  «14 mar 2026» or «14 mar 2026, 10:30», never as the raw ISO text (before, only a field with role `date` was).

## 0.1.0-next.10 (2026-11-24)

- `defineApp({ widgets })` no longer takes part in inferring the artifacts' types: with `widgets` an artifact's `data`
  lost its params' types (`unknown`).

## 0.1.0-next.9 (2026-11-24)

- Spec, «Clegra tokens»: every Clegra token carries `locale`, the person's language, which is the caller's `ctx.locale`
  (the agent's delegated and automation tokens too); a token without it gets the app's own `locale`.
- `init --ui` names `@clegra/ui` `^0.1.0-next.13`.
- **The record template (spec §5.4 rule 4 `record`)**: every record an app resolves carries its A2UI surface, written
  from the entity's `record: { fields, actions? }`, declared once (1–6 key fields, 0–3 record actions; default the
  first four fields a list would show): the title opening the record, the status as a chip (with its tone), the key
  fields as texts in the reader's language (referenced records by title, money, dates, enum labels), the record
  actions the caller may use, each event carrying the record's `id`. The manifest's entity carries `record`.
- **What a write changed (spec §5.4 rule 8)**: a write's result carries `_meta.clegra.changed`, the URIs of the record
  it acted on and of the record it answered with, plus what the handler names with `ctx.changed(uri | type, …)`; a
  host reads those surfaces again wherever they are open, over its live channel.
- **Creatable types (spec §5 `create`)**: an entity's or an artifact's `create: { action, title? }` lists the type in
  a workspace host's «+ Nuovo» and in a document's «/» menu; the action is a global write with no required input and
  no confirmation first that answers the new instance's URI as `record`. The manifest's artifact carries `create`.
- **Widgets (spec §5.5)**: `defineApp({ widgets: { <artifact type>: { sizes?, size? } } })` and the manifest's
  `widgets` say which template or component artifacts (without required params) the app offers on Home; no other
  artifact is offered as a widget.
- `Spreadsheet`, `TodoList` and `AppBlock` are Clegra catalog names: an app's own component can't take them.

## 0.1.0-next.8 (2026-11-23)

- **`init --ui` installs `@clegra/ui` `^0.1.0-next.10`** (was `^0.1.0-next.5`).
- **Artifacts as A2UI 1.0 surfaces (spec §5.4)**: every template artifact (`card`, `stat`, `list`, `chart`) and every
  artifact drawn by one of the app's own components carries `a2ui`, one A2UI 1.0 `createSurface` (Basic Catalog
  components bound to the data model, Clegra's `Chart`, `formatPercent` and `openRecord`, style hints as the
  `com_clegra_style` extension), in `show_<type>` (also as an `application/a2ui+json` embedded resource) and in
  `clegra_resolve`. Hosts render it natively; the data stay in the data model.
- **An app's own components**: `defineApp({ components: { Name: { title, description?, props, view, actions? } } })`
  and an artifact's `component: "Name"` (its data are the props, checked against `props`). The manifest's
  `components`, each view at `ui://<app>/components/<Name>` (served with view tickets, §5.3), and the app's A2UI
  catalog as the MCP resource `a2ui://<app>/catalog.json`. A host frames the page and speaks MCP Apps with it: data
  as tool-input/tool-result, theme, language and accent as host context, its `tools/call` only for its `actions`.
- **Spec only, not built yet**: editable surfaces (every edit an app action, live updates over the host's SSE) and
  Clegra's native `Spreadsheet` for a `sheet` template, with its edit contract (editable cells, per-cell errors,
  optimistic commits, row versions and conflicts) (spec §5.4 rules 8–9).

## 0.1.0-next.7 (2026-11-23)

- **Labels in the reader's language when the call showed that language**: `_meta.clegra.l10n` noted only a label's
  other locales, so an Italian reader of a call shown in Italian found no `it` entry and the view fell back to
  English. The shown locale is now noted too, as itself.

- **An app's own website is shown as it is in Clegra (spec §5.1)**, replacing `url` pages and embed pages (removed,
  with no compatibility path: `embed`, `clegra_embed`, the url-page view, `embedProxy`, `getEmbedCaller`,
  `EmbedError`, `CLEGRA_EMBED_SECRET`). `defineApp({ site: { start?, secret?, sessionSeconds? } })` (needs
  `auth.clegra`) puts `site { start, tool }` in the manifest. `clegra_site { path?, origin, theme?, locale?, renew? }`
  gives a person's own app token (never an agent's) a one-minute, single-use ticket for a path of the site and one
  exact client origin; `POST /clegra/site` exchanges it (a framed POST from that origin only) for a partitioned
  session cookie for the whole site and a marker cookie, and 303s to the path. `@clegra/sdk/next`:
  `siteProxy(app)` (a session's pages framable by its client only, `frame-ancestors 'none'` otherwise, the signed-out
  page in a Clegra frame whose session ended), `siteGuard`, `getClegraCaller(app)` (`{ installation, person, email,
  permissions, can, admin, locale, theme, origin, … }`) and `<ClegraSite />`, the bridge
  (`/clegra/site/bridge.js`: `clegra/location` to the client, `clegra/context` theme and language from it,
  `clegra/renew` before the session ends). Conformance: `site.frame-ancestors`, `site.ticket` (with
  `clegra.clientOrigin`). `react` is an optional peer (for `<ClegraSite />`).
  The desktop app's origin (`app://client`) gets a ticket like a web client's, when it is one of the client
  origins (it was refused as not an origin).
- **Views post no forms**: `form-action 'none'` (was `'self'` for the url-page hop). Views keep `Referrer-Policy:
  same-origin`.
- **Frame ancestors from the app's configuration**: the Clegra client origins come from `auth.clegra.clientOrigins`
  (`CLEGRA_CLIENT_ORIGINS`), never from an address an app writes.

## 0.1.0-next.6 (2026-11-21)

- **An app's own views frame its embed pages**: a url page's view, framed by Clegra from the app's own origin
  (spec §5.3), frames the page inside it, so the framing document's origin is the app's. An app whose
  `embed.frameAncestors` did not name `'self'` refused its own view («… may not frame this app's pages
  (embed.frameAncestors)») and its pages never opened in Clegra. `'self'` is now always one of `frameAncestors`,
  first, in the manifest and in every embed response's `frame-ancestors`; an app lists only the other hosts.
  `checkApp`'s `embed.frame-ancestors` fails a manifest without `'self'` (spec §5.1). The examples drop their own
  `'self'`.

## 0.1.0-next.5 (2026-11-21)

- **Registering before configuring**: in production an app with `auth.clegra` but no `registrationId` (or
  `allowedCompanies`, or with `auth.resolve` but no `auth.resource`) answered every request `500 misconfigured`,
  the manifest included, so the core could never read the manifest that registering starts from, and registering is
  what hands out the registration id. The two public documents a core reads to register an app are now served before
  the production configuration is checked: the manifest (`/.well-known/clegra.json`) and the registration document
  (`/.well-known/clegra-app.json`: `404 not_configured` until `registrationId` and `challenge` are set, `no-store`).
  Neither carries or accepts a token. Everything else (MCP, events, views, embed exchanges, `health`, the OAuth
  metadata) keeps answering `500 misconfigured` until the app is configured (spec §7, «Registration»).

## 0.1.0-next.4 (2026-11-21)

- **Views at the app's own origin** (spec §5.3): a Clegra client frames an app's MCP Apps views from the app itself,
  never from a sandbox page of its own. New app-only tool `clegra_view { view, origin }` (only for a person's own
  Clegra app token, never an agent's): a 60-second, single-use, opaque ticket in the app's store for one view and one
  client origin (`clientOrigins` exactly). `POST <path>/clegra/views/<view path>` with the ticket posted by a form
  into the frame (`Sec-Fetch-Dest: iframe`, `Origin` the ticket's) answers the view with its declared policy as the
  header, `frame-ancestors` exactly that origin, `no-store`, `no-referrer`, and `<meta name="clegra-host">`; the SDK's
  views then post to and hear only that origin. `clientOrigins` takes the desktop app's `app://client`. The examples'
  embed hosts add `'self'` (a page inside a view now framed at the app's origin).
- **App events by their time**: `member.removed`, `app.unassigned`, `app.uninstalled` and `company.suspended` refuse
  what was issued before the event happened (its `at`), no longer before it arrived, and an older event never moves
  the line back: an event the core's outbox delivered late refused the tokens the core had issued after it (an app
  removed and added again right after). `testCore().event` takes `at`. A person seen before their tenant's roles
  were cleared (the app removed and added again) or before being removed is seen again at the next call, so the
  permissions page lists them (it waited up to an hour).
- **A DPoP challenge** (RFC 9449 §7.1): an app that takes only Clegra's core's DPoP-bound tokens (no `auth.resolve`,
  no development sign-in at that address) answers a 401 with `WWW-Authenticate: DPoP algs="EdDSA ES256",
  resource_metadata="…"` (no error code when no credentials were sent), no longer `Bearer`; an app with its own
  resolver keeps `Bearer`.
- `init --ui` adds `@clegra/ui` at `^0.1.0-next.5` (the lockup's larger Faccina in next.4, the apps' accents in next.5;
  its web libraries unchanged).
- **The app's accent** (spec §2): `accent` in `defineApp` and the manifest, one name of a closed palette like Apple's
  apps' tints (`APP_ACCENTS`: `blue`, `indigo`, `purple`, `pink`, `red`, `orange`, `yellow`, `green`, `teal`, `gray`;
  `DEFAULT_APP_ACCENT` `blue` when absent), in the JSON Schema (an enum: anything else fails `manifest.schema`) and
  the rules (a wrong name fails at definition time). The SDK knows only the names; the colours are the host's
  (`@clegra/ui/accents`). Quickstart «Your app's colour», with the palette's swatches (`docs/accents.svg`, shipped).

### Clegra's core as the one trusted issuer (spec §7, «Clegra tokens»)

- **`auth.clegra` replaces `auth.issuers`** (no alias): an app trusts exactly one issuer, Clegra's core, its keys of
  `use: "app"` at `<issuer>/.well-known/clegra-keys.json` (kept, refreshed every 10 minutes, fetched again on an
  unknown `kid` at most once a minute). Its app tokens (`typ: clegra-app+jwt`, ≤ 10 minutes) are for `aud` exactly
  `auth.resource` (a string; an array is refused), the tenant `<company>@<issuer>` from the token, `ctx.person.id`
  the person's pairwise `sub`. `Issuer`, `HostClaim`, `signAccessToken`, `signConfirmation` and `generateSigningKey`
  leave the public API; the development authority keeps its own tokens (and the development workspace host, the only
  installation-level caller now).
- Config: `issuer`, `jwksUri?`/`jwks?`, `registrationId`, `challenge`, `allowedCompanies` (ids or `"any"`),
  `clientOrigins`, `companyAdmin` (`"admin"` default, or `"member"`), `events` handlers. `clegraFromEnv()` reads
  `CLEGRA_ISSUER`, `CLEGRA_REGISTRATION_ID`, `CLEGRA_REGISTRATION_CHALLENGE`, `CLEGRA_ALLOWED_COMPANIES`,
  `CLEGRA_CLIENT_ORIGINS`. **In production the SDK fails closed** (every request `500 misconfigured`) without
  `registrationId` and `allowedCompanies`; `auth.resource` is required with `clegra`.
- **DPoP** (RFC 9449) for every core token: `Authorization: DPoP`, the proof's key the token's `cnf.jkt`, `htm`, `htu`
  the configured resource (never the request's URL or `Host`), `ath`, `iat` ±60 s, `jti` once in the store;
  `401` `WWW-Authenticate: DPoP error="use_dpop_nonce"` with a `DPoP-Nonce` on a clock miss, a nonce good 5 minutes.
- **CORS** with `auth.clegra`: the configured client origins only, `Authorization`, `DPoP`, `Content-Type` allowed,
  `DPoP-Nonce`, `WWW-Authenticate` exposed, no credentials, preflights answered.
- **Agents**: delegated and automation run tokens (`act: { sub: "server:<id>" }`, ≤ 60 s, one call; `person_jkt`, or
  `grant` with the consented `tools`, enforced) and device-agent tokens (`act: { sub: "device-agent:<jkt>" }`);
  `ctx.actor` names the actor.
- **Confirmations** of a `confirm: "always"` write called by an agent: `_meta.clegra.confirmation` `{ token, proof }`,
  the core's `clegra-confirmation+jwt` (`aud`, pairwise `sub`, `company`, `tool`, `args_sha256`, `cnf.jkt` the
  person's device, `jti` once, ≤ 10 minutes) and the device's `clegra-confirmation-proof+jwt` (`jwk` header, `cth`,
  `iat`, `jti`). From a Clegra client without an actor the UI asks and sends `_meta.clegra.confirmed: true`.
- **Roles**: the app's own permissions per pairwise person per tenant (`IdempotencyStore.roles`: `MemoryRoles`,
  `SqlStore`'s third table `<table>_roles`: re-run `SqlStore.schema()` in a new migration); a company administrator is
  an app administrator unless `companyAdmin: "member"`; `app.roles` (`list`, `get`, `assign`, `remove`), `ctx.admin`;
  the read-only tool `clegra_roles` («who has what», manifest `rolesTool`).
- **Events**: `POST <path>/clegra/events` takes the core's `clegra-event+jwt` (once per `jti`); `member.removed`
  drops the person's roles and refuses their older tokens and embed sessions, `app.unassigned` and `app.uninstalled`
  drop the tenant's roles and refuse its older tokens, `company.suspended` refuses them; the lifecycle hook hears
  `app.installed` / `app.unassigned` / `app.uninstalled` as `enabled` / `disabled` / `uninstalled`. Manifest
  `events: { url }`.
- **Registration**: `GET /.well-known/clegra-app.json` = `{ registration_id, challenge, resource, issuer }`.
  `withClegra` rewrites it and `/clegra/events` too.
- `ctx.rateLimit(name, { max, seconds, per? })` (error `rate_limited` with `retryAfterSeconds`); the store gains
  `put`, `get` and `hit`.
- Settings from `_meta.clegra.settings` count only from the development workspace host: an app's settings live in
  the app. The protected-resource metadata names only the app's own authorization servers (default none).
- `@clegra/sdk/testing`: `testCore({ resource })` (keys, app, delegated, automation and device-agent tokens,
  confirmations, events, `client()`), `deviceKey()`, and `testClient`'s `dpop` and `origin` options.
- The examples trust Clegra's core (`CLEGRA_*`) instead of `CLEGRA_ISSUERS`, with the roles table in a new migration
  (CRM `0006_clegra_store_roles.sql`, warehouse `007_clegra_roles.sql`).
- **Conformance for an app in the trusted-issuer mode** (spec §8): `checkApp({ url, clegra: { token, proof,
  confirmation? } })` checks as a Clegra caller (`Authorization: DPoP`, a proof per request for the app's resource,
  once more with its `DPoP-Nonce`); what is hidden from plain clients is a person's to see, so `mcp.tools` no longer
  counts it. `auth.mcp` takes protected-resource metadata without an authorization server for an app that trusts
  only Clegra's core (it declares `events` and no `auth.authorizationServers`). New check `mcp.confirm`: a sensitive
  write called by a Clegra caller without a confirmation answers `confirmation_required` and runs nothing; with an
  agent's `confirmation` (the core's token and the device's proof), one of other arguments is refused and one of its
  own arguments runs once.
- **Notification recipients** are person ids or `"admins"` (the company's administrators): `to: { permission }` is
  gone (Clegra keeps no app's permissions: an app names the holders it wants from `app.roles.list`).

## 0.1.0-next.3 (unreleased)

- **Fragments are artifacts.** Every name of the concept changes, with no alias (each `Fragment…`/`fragment…` name becomes `Artifact…`/`artifact…`): `defineApp({ artifacts })`,
  `ArtifactDef`, `ArtifactInstance`, `ManifestArtifact`, `artifactSchema`, `app.artifactUri`, the manifest's
  `artifacts` (JSON Schema and conformance), a dashboard page's `artifacts`, the resolve tool's `want: "artifact"`,
  the resolved result's `artifact` and its view kind `"artifact"`, a dashboard's `structuredContent.artifacts`, and
  the docs (spec, quickstart, AI guide, kinds). A record or template shown outside its app is an artifact
  («artefatto» in Italian), like Claude's Artifacts.
- `init --ui` adds `@clegra/ui` at `^0.1.0-next.3` with its web libraries as that version declares them (the
  `@dnd-kit/*` three of the shell's reorderable lists added).
- The examples' public demos are gone: the CRM and warehouse READMEs drop their «Public demo» sections, the warehouse
  its Vercel deploy steps, and `examples/deploy.sh` is deleted. The examples run locally.

## 0.1.0-next.2 (2026-11-19)

- package.json names the public repository (`repository`, `homepage`, `bugs`: github.com/andreazagoit/clegra-sdk), so
  npm links to it and the README's relative links resolve there.

## 0.1.0-next.1 (2026-11-17)

- `@clegra/sdk/spec` works inside a bundled Next.js server (Turbopack): the manifest's JSON Schema is a JSON import,
  no longer a file read by a path relative to `import.meta.url` (which the bundler turned into an asset URL that
  `readFileSync` refused, failing `next build` of any app importing the conformance checks).

## 0.1.0-next.0 (2026-11-17)

The first version published to npm (`npm i @clegra/sdk@next zod`).

### Two scoped packages: `@clegra/sdk` and `@clegra/ui`

- npm refused the unscoped name, so the package is `@clegra/sdk` in the npm organisation `clegra`. Imports:
  `@clegra/sdk`, `@clegra/sdk/next`, `@clegra/sdk/node`, `@clegra/sdk/testing`, `@clegra/sdk/spec`,
  `@clegra/sdk/clegra.schema.json`, `@clegra/sdk/kinds.json`. The CLI is `npx @clegra/sdk init|check`; its bin is
  still `clegra`. Wire names do not change (`clegra://`, `/.well-known/clegra.json`, `_meta.clegra`, `clegra_*`
  tools, `CLEGRA_*` variables, `clegra.schema.json`, the cookies).
- The design library left this package: it is `@clegra/ui`, its own package and repository (history kept there),
  with every component public. `@clegra/sdk` has no UI entry and no UI peer dependency (peers: `zod`, optional
  `next`); the generated MCP Apps view is plain HTML. `init --ui` adds `@clegra/ui` (`^0.1.0-next.0`) and its web
  libraries to the app and `@import "@clegra/ui/styles.css"` after Tailwind.
- `@clegra/sdk/spec/protocol` and `@clegra/sdk/spec/kinds`: the protocol's names and the kinds vocabulary (with
  the key normalisation) for workspace hosts, which until now reached them only by a path into the source. Neither
  imports a Node built-in.
- `publishConfig.access: public`. The pack check also installs both tarballs in one fresh Next.js app
  (`init --ui`, build, `clegra check`).

### The package in its own repository

- The package is its repository's root (published from there with `npm publish --tag next`); the examples
  (`examples/crm`, `examples/warehouse`, `examples/shipments`) are npm workspaces beside it, the docs in `docs/`.
  The tarball ships `docs/spec.md` and `docs/quickstart.md` too. History kept.
- `clegra/ui`'s palette lives in `ui/brand` (the same values as before).
- No `"private"` and no approved-tarball step: a prerelease is refused without a dist-tag (npm and `prepack`).
- `clegra/ui/native/expo-ui-controls` is an entry: `ExpoHost` (Expo UI's `Host` in the app's colour scheme) and the
  layout helpers the native controls share.

### The publisher (spec §2)

- Manifest `publisher?: { name, url }` (`defineApp({ publisher })`): who publishes the app, a name and an https
  address. A claim that grants nothing; a store or host may verify it by the address's domain. Well-formedness is a
  manifest rule (`manifest.references`); the JSON Schema has it.

### Pages people use every day, work on a clock, and the app lifecycle (spec §4.1, §4.2, §5.2, §10–§13)

- Navigation and page actions: a top-level `nav` (sections of pages), a page's `actions` (global actions drawn as
  forms, prefilled from the page's parameters; the first is the page's primary) and `badge` (a `stat` fragment whose
  value is the count). The generated view draws them too. A host derives filters (enum and date fields) and the
  list-beside-record layout itself.
- `visibility: "app"` on entities, actions and fragments: their tools are callable by views and the host's own UI,
  never given to a model.
- Targets: an action offered on an email (`mail.message`) or on a record of a kind in any app (`record:<kind>`), with
  the fields it needs and a template that fills its form.
- Approve now, act later: `later: { at, window }` on a confirmed write. The confirmation's proof also binds the
  deadline (`until`); the run is stored through the store (`SqlStore` gains a `_later` table: re-run
  `SqlStore.schema()` in a migration), runs once from the reserved `clegra_later` schedule, the person who approved
  as its author, and is refused after its deadline or if its stored arguments no longer match the proof.
- The installation-level caller (a workspace host's token with no person and exactly the called action's permission),
  `schedules` (a global action every 5–1440 minutes; never an `always` write), declared notification types and
  `to: { permission }`.
- The app lifecycle: reserved app-only tools `clegra_installation`, `clegra_export` and `clegra_delete`, called by
  a workspace host as the installation when it is enabled, disabled or uninstalled («export, then delete in 30 days»
  or «delete now»).
- `clegra/testing`: `installationClient`, `.schedule()`, `.runLater()`, `.exportData()`; conformance checks
  `mcp.visibility` and `lifecycle.hidden`; `manifest.references` covers the new rules.
### `clegra/ui`: the design library in the package

- Clegra's design library is part of `clegra` (it was the separate, unpublished `@clegra/ui`): `clegra/ui/components/*`
  (web and React Native, with the `react-native` and `ios` conditions), `clegra/ui/react/*`, `clegra/ui/react-native/*`,
  `clegra/ui/frame`, `clegra/ui/tokens`, `clegra/ui/hooks/*`, `clegra/ui/primitives`, `clegra/ui/base-ui/*`,
  `clegra/ui/native/{theme,overlay,icons,icon-context}`, `clegra/ui/metro`, and the stylesheets
  `clegra/ui/styles.css` (Tailwind 4 entry; it sources its own components), `theme.css`, `shadcn.css`, `prebuilt.css`.
- Its UI libraries (React, Base UI, lucide, recharts, … and React Native's) are optional peer dependencies, never
  bundled: an app that only serves MCP installs none of them. `npx clegra init --ui` adds the web ones to a Next.js
  app and imports the stylesheet after Tailwind. Docs: [ui.md](ui.md). The package now ships `NOTICE.md`.

### Renamed to Clegra apps and the `clegra` package

- Clegra apps are Clegra's own developer platform, not an open standard: the spec is «Clegra apps — specification»
  (1.0 draft), and nothing in it asks other hosts to implement it. Every app is still a plain, conformant MCP server
  (tools, MCP Apps views, OAuth) that ChatGPT, Claude and any MCP client use, plus a manifest Clegra draws natively.
- One npm package, `clegra` (was `modelapp`): `clegra`, `clegra/next`, `clegra/node`, `clegra/testing`,
  `clegra/spec`; the CLI is `npx clegra init` and `npx clegra check <url>`.
- Wire names: manifest `/.well-known/clegra.json`; URIs `clegra://<app>/<entity>/<id>`; `_meta.clegra`, the
  `clegra` token claim and OAuth scope; JWT `typ` `clegra-confirm+jwt`, `clegra-embed+jwt`,
  `clegra-embed-session+jwt`; tools `clegra_resolve`, `clegra_embed`; cookie `__Secure-clegra-embed-<page>`; JSON
  Schema `clegra.schema.json` (`urn:clegra:manifest:1.0`).
- Next.js: the mount is `app/api/clegra/[...path]` (`/api/clegra`); `withClegra`, `clegraRewrites`,
  `WithClegraOptions`. The SDK's store table is `clegra_store`; environment variables are `CLEGRA_*`
  (`CLEGRA_PUBLIC_URL`, `CLEGRA_ISSUERS`, `CLEGRA_EMBED_SECRET`, `CLEGRA_LOCAL_TOKEN`, `CLEGRA_DEV`,
  `CLEGRA_OAUTH_*`; the pack guard reads `CLEGRA_PUBLISH=approved`).
- The documentation moved from docs/map to docs/developers; the earlier, larger drafts (docs/map/future) are gone.
  The two reference apps (the CRM and the warehouse) and the repository's scripts follow the new names.

### Kinds in a workspace host: the rules made precise (spec §9; docs/map/kinds.md)

- §9.1 names: a host gives a clashing app another name at install time and keeps it (other apps store URIs that carry
  it); it translates URIs both ways on every call and refuses, rather than sends, a URI an app could misread as its own.
- §9.4 sources: `not-linked` is a source state for an app that signs people in itself when the viewer has not linked
  their account; a reference the viewer can't resolve for that reason reads `no-access`.
- docs/map/kinds.md: when kinds pay off, third parties' dotted kinds, and the promotion rule (two independent apps, a
  host behaviour that uses it, precise keys, schema.org names; additive only).

### Embedded pages: the sign-in ticket (spec §5.1)

- A same-site `url` page is signed in with a ticket, not the app's session cookie (a third-party cookie in a host's
  frame). The host (or the SDK's url-page view, over the MCP Apps bridge) calls `modelapp_embed { page, origin }`
  with the viewer's token: a one-minute HS256 JWT for that page and framing origin, carrying the caller as
  `resolve` named it. The frame POSTs it to `/embed/_ticket` (never in a URL); the app checks `Origin`,
  `Sec-Fetch-Dest: iframe`, signature, page, expiry (5 s skew) and single use (`store.once`), then answers 303 to
  the page with a `Secure; HttpOnly; SameSite=None; Partitioned` cookie for the page's path.
- `defineApp({ embed: { frameAncestors, secret?, path?, sessionSeconds? } })`, required with a same-site page;
  manifest `embed: { tool, path, frameAncestors }`. Every embed response carries `frame-ancestors` = the declared
  hosts, never `X-Frame-Options`.
- `modelapp/next`: `embedProxy(app)` (proxy.ts) and `getEmbedCaller(app, page)`; core `app.embed`.
- Conformance: `embed.frame-ancestors` (public) and `embed.ticket`.
- Examples: `EMBED_FRAME_ANCESTORS` is gone; the hosts are declared in code; the boards read `getEmbedCaller`.

### The `modelapp` package is built for npm

- The tarball ships ESM JavaScript with `.d.ts` files and source maps (`dist/`), not TypeScript source: a
  `next.config` importing `modelapp/next` from `node_modules` now loads (Node refuses `.ts` there). Every entry has
  `types` and `default` conditions; `moduleResolution` `bundler` and `node16` both resolve it. The CLI is
  `dist/spec/src/cli.js` with a `node` shebang; the JSON Schema and `kinds.json` ship next to the code
  (`modelapp/modelapp.schema.json`, `modelapp/kinds.json`).
- `withModelApp` no longer adds `modelapp` to `transpilePackages`: the package is JavaScript.
- Not published yet: see [RELEASE.md](RELEASE.md).

### The generated view in hosts (spec §5)

- **Clicking a row in ChatGPT looked dead.** The view now finishes `ui/initialize` before any `tools/call`
  and calls over the MCP Apps bridge whenever the host answered it; `window.openai.callTool` is used only by a host
  that refused `ui/initialize`, and an answer without `structuredContent` is an error.
- The opening result is drawn once. Later `ui/notifications/tool-result` messages (sent for the view's own calls)
  and `openai:set_globals` events (sent for every layout, theme or state change) no longer replace the record the
  person opened or remove the way back. `toolResponseMetadata` is read as ChatGPT gives it (the MCP result
  envelope: `_meta` under `mcp_tool_result`).
- Every call from the view shows progress at once and its outcome where the person looks: a status line kept at
  the top of the view, with the host's own words when it refuses and a clear message after 30 seconds without an
  answer. Before, a refusal was written below the list, outside an inline frame.
- Rows are focusable and open with Enter or Space.
- A change made in the view is told to the model (`ui/update-model-context`, the result's text).

### Records named by their title (spec §6 rule 10, §7)

- The text a model reads of a list and of a get carries each record's `title` beside its `uri` (`search` and
  `fetch` already did).
- Every action tool on a record takes an optional `record_title` beside `id`, and both descriptions tell the model
  to name the record by its title. It is a display hint for a client's own approval prompt: never passed to the
  handler, never shown as the app's; a hint that names another record fails the call with `invalid_input`.
  `record_title` is reserved in an action's `input`.
- Conformance: new checks `mcp.titles` and `mcp.app-callable`.
