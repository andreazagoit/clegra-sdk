# Web Map: pages, tools and records of a web app

| | |
|---|---|
| **Kind** | Extension. Identifier `com.clegra/web-map` (reverse-DNS prefix of `@clegra/sdk`; a neutral one if adopted) |
| **Status** | Draft 0.2, Experimental. `revision: "0.2"` |
| **Requires** | MCP `2026-07-28` (where `capabilities.extensions` exists). On earlier revisions the same settings MAY be carried in `capabilities.experimental`; nothing else changes |
| **Reuses, not redefines** | AI Catalog and Server Cards (discovery), resources and `subscriptions/listen` (live data), W3C Web Application Manifest (install), WebMCP (tools of an open page), MCP Apps and A2UI (drawing) |
| **Offered to** | No group exists for page ↔ tool linking: Server Cards and MCP Apps maintainers first (see [the index](README.md), «Process») |

MUST, SHOULD and MAY as in RFC 2119. «App» is the web app and its MCP server, «client» the MCP client, «person» the
signed-in human. The other documents of the family and the adoption levels are in [the index](README.md).

## 1. Abstract

A web app has pages for people and an MCP server for agents, and the two do not know each other: a tool result
cannot say «this is the job at that address», a page cannot say which tools act on it, and a client cannot open
the right page after an agent worked. This extension joins them with one **web map**: every **record** is a
resource whose URI is its own web address, every **tool** names its record type and its page, and one resource
inside the MCP server lists the app's **pages** the signed-in person may open, with their counters and tiles. It also says how a client proves that a site and an MCP
server belong together. It is a small profile: two `_meta` blocks, one JSON resource and one proof.

Principle: **agents use tools; pages are for people.** The examples use a job-requests app at
`jobs.example.com`.

## 2. Negotiation and origin binding

Server, in `server/discover`:

```json
{ "capabilities": { "extensions": { "com.clegra/web-map": {
  "revision": "0.2", "origin": "https://jobs.example.com" } } } }
```

Client, in `_meta` of each request:

```json
{ "_meta": { "io.modelcontextprotocol/clientCapabilities": { "extensions": { "com.clegra/web-map": { "revision": "0.2" } } } } }
```

Server members: `origin` (required), `origins` (further origins, optional). A peer that receives a `revision` it does not know does not enable the extension.

- **ORG-1 Proof.** A client MUST enable the extension for an origin only if that origin is the origin of the MCP
  endpoint, or if `https://<origin>/.well-known/ai-catalog.json` lists a Server Card whose remote is this exact MCP
  URL. Each entry of `origins` is proven the same way. Without proof the client MUST ignore the extension.
- **ORG-2 Nothing points elsewhere.** Every navigable URL of the map (page paths, record URLs, a tool's `page`, a
  tile's `url` and its rows' `url`) MUST be `https` and same-origin with a proven origin. A client MUST reject any
  other, and shows the origin wherever the person decides something. A counter's or a tile's own URI is not one: it
  is an MCP resource URI that the client only reads with `resources/read` (and subscribes to) on the same MCP server
  and never navigates, so any scheme is allowed there (`@clegra/sdk` serves `webmap://badges/<name>` and
  `webmap://widgets/<name>`).
- **ORG-3 Tenants and hosts.** A multi-tenant app returns the caller's own origin
  (`https://acme.jobs.example.com`), proven by that origin's catalog; a `server/discover` result that depends on
  the caller MUST carry `cacheScope: "private"`. The MCP endpoint MAY be on another host (`api.example.com`); the
  catalog is what binds them.
- **ORG-4 Live, per person.** The map is read as the signed-in person. A person who may not use something does not
  see it.
- **ORG-5 Inside the MCP server only.** The map (tools' `_meta`, record templates, the pages resource) is served
  only by the MCP server, to an authorized caller. Nothing of it is published at a well-known path or in the
  Server Card: the card carries only what is public about the app, its name, icon and description (and the
  endpoint the card exists to give).
- **ORG-6 Discovery, as `@clegra/sdk` serves it.** The Server Card (MCP Server Cards, SEP-2127) is served at
  `<mcp-url>/server-card` with the media type `application/mcp-server-card+json`, and carries only `$schema`
  (`https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json`), `name` (`<reversed host>/<app>`),
  `title`, `description` (each 1 to 100 characters), `version`, `icons` and the remote (the MCP endpoint, type
  `streamable-http`). `https://<origin>/.well-known/ai-catalog.json` on the site's origin is an AI Catalog (v0.9, the
  release candidate of v1.0), media type `application/ai-catalog+json`, that lists that card by URL:

  ```json
  {
    "specVersion": "0.9",
    "host": { "displayName": "Jobs" },
    "entries": [
      {
        "identifier": "urn:air:jobs.example.com:jobs:mcp",
        "type": "application/mcp-server-card+json",
        "url": "https://jobs.example.com/mcp/server-card"
      }
    ]
  }
  ```

  It is the proof of ORG-1 when the endpoint is on another origin, harmless when it is not. Both documents answer
  with the discovery CORS (`Access-Control-Allow-Origin: *`, methods `GET`, headers `Content-Type, If-None-Match`,
  exposed `ETag`), `Cache-Control: public, max-age=3600` and an `ETag` (`304` on `If-None-Match`).

## 3. Tools

```json
{
  "name": "job.assign", "title": "Assign job",
  "inputSchema": { "type": "object", "required": ["job", "department"], "properties": { "job": { "type": "string" }, "department": { "type": "string" } } },
  "_meta": { "com.clegra/web-map": {
    "entity": "job", "on": "record", "recordArg": "job",
    "page": "https://jobs.example.com/orgs/{org}/jobs/{id}" } }
}
```

| Member | Meaning |
|---|---|
| `entity`, `on` | The record type the tool works on: one `record`, or the `collection` (list, create, search). |
| `recordArg` | With `on: "record"`: the input property holding the record. Default `id`. |
| `page` | URI Template (RFC 6570) of the page where a person does or sees the same thing. |

- **MAP-1 One authoritative side: the tool.** A page's tools are the tools whose `page` is that page's template; a
  record's tools are those whose `entity` is its entity. A page's `tools` (§5) and a record's `get`/`list` (§4) are
  optional and only order or pick among them: a client MUST ignore a name there that is not in `tools/list`, or
  whose tool names another entity. Where the two sides differ, the tool wins.
- **MAP-2 Template variables.** Each variable of `page` MUST be a property of the tool's `inputSchema` or, with
  `on: "record"`, a variable of the record's `uriTemplate`. A client that cannot fill every variable does not offer
  the page.
- **MAP-3 `recordArg`.** Its value is the record's URL (§4), which the tool MUST accept; a bare id is allowed when
  the template has one variable. Given a URL, the client fills `page` by matching it against the record's template
  (above: `org` and `id` come from `https://jobs.example.com/orgs/7/jobs/318`).

## 4. Records

```json
{
  "uriTemplate": "https://jobs.example.com/orgs/{org}/jobs/{id}",
  "name": "job", "title": "Job", "mimeType": "application/json",
  "_meta": { "com.clegra/web-map": { "record": {
    "entity": "job", "get": "job.get", "list": "job.list",
    "card": { "title": "title", "subtitle": "customer_name", "status": "status", "amount": "estimate", "date": "due" } } } }
}
```

- **REC-1 One address (decided).** The record's URL is its MCP resource URI, and `resources/read` returns the
  record as JSON. The same URL is also the record's page in a browser. So that the `https` URI is fetchable from
  the web, as core asks of `https` resource URIs, the app does **one** of these:
  1. *Bearer on the same URL.* A `GET` that carries `Authorization: Bearer` gets the same JSON as
     `resources/read` when the token is valid, and `401` with `WWW-Authenticate` (RFC 9728) when it is not, with
     `Vary: Authorization` and `Cache-Control: private`. Requests **without** a bearer token are untouched: the
     page, the app's sign-in, or whatever JSON the app already serves to its own front end with its cookie.
  2. *Alternate.* The page answers with `Link: <…>; rel="alternate"; type="application/json"` pointing to a JSON
     endpoint that follows rule 1.

  *Audience.* A client sends its MCP access token to a record URL only when that URL's origin is the origin of the
  `resource` in the MCP endpoint's Protected Resource Metadata, the audience the token was issued for (RFC 8707).
  For any other proven origin it uses `resources/read` only, and the app refuses an MCP token there with `401`.

  *Why this and not a custom scheme with the web URL in `_meta`:* one identifier serves the model, the client and
  the person's browser; a client without the extension still gets a link a person can open; and the URI means what
  core says an `https` URI means. The cost is honest: one route and one rule per record type (§8).
- **REC-2** The URL is stable for the record's life (a changed one redirects) and carries no personal data. A tool
  that returns or changes a record includes it as a `resource_link`. A result MAY list
  `_meta["com.clegra/web-map"].changed: [<record or resource URI>, …]` so the client redraws at once.
- **REC-3 Live, never a shared copy.** Records are returned with `cacheScope: "private"` and a short `ttlMs`. A
  client reads a record for the viewer with the viewer's own token, re-reads when the TTL lapses or on
  `notifications/resources/updated`, MUST NOT show one person data read with another's token, and MUST NOT show an
  older value in place of a failed read.
- **REC-4** `card` names which JSON fields play `title` (required), `subtitle`, `status`, `amount`, `date`, so a
  client can draw a card without knowing the app.
- **REC-5 References between apps.** An app that points to another app's record stores only its URL and MUST NOT
  fetch it. A client resolves a reference only if the URL matches a record template declared by an app the viewer
  connected, only through that app, and never passes what it read to the app that supplied the reference.

## 5. Pages, counters and tiles

Pages are not MCP resources: a page's content is HTML for a person, not something to read over MCP. The MCP
server offers **one** resource, at the fixed URI `webmap://pages`, whose JSON content is the list of pages the
caller may open. It is read with `resources/read` after sign-in, as the person: each person gets only the pages
they may open, and an unauthorized read is refused. Its URI is not `https` on purpose: it is not reachable on the
web, at a well-known path or anywhere else (ORG-5). It is returned with `cacheScope: "private"` and re-read on
`notifications/resources/updated`.

```json
{ "pages": [
  { "url": "https://jobs.example.com/orgs/{org}/jobs{?status}", "name": "jobs", "title": "Jobs",
    "role": "list", "entity": "job", "nav": { "section": "Work", "order": 10 },
    "tools": ["job.create", "job.list"], "badge": "webmap://badges/open-jobs" },
  { "url": "https://jobs.example.com/orgs/{org}/jobs/{id}", "name": "job", "title": "Job",
    "role": "record", "entity": "job", "frame": false }
] }
```

`url` is a URI Template. `role` is `list`, `record`, `create`, `dashboard`, `settings` or `other`. `nav` puts the
page in the app's navigation (`section` is display text, translated by the app; `order` ascending). `frame`
(default `false`) says the app allows this page inside a client's frame.

- **PAGE-1** A page works when opened directly in any browser with the app's own sign-in. Whether it may be framed
  is the app's `Content-Security-Policy: frame-ancestors`. A client never rewrites headers and passes no identity
  or token to a page; the only way to arrive signed in is [session transfer](session-transfer.md).
- **PAGE-2** A client opens pages and links with `noreferrer` and `noopener` and adds no parameters of its own, so
  the app learns nothing about the conversation they were opened from.
- **PAGE-3** An assistant **shows** a page by returning a `resource_link` to the expanded URL; the client opens it.
- **PAGE-4** A client that enabled this extension for an origin SHOULD NOT automate that origin's pages and MUST
  NOT reuse the person's page session to call the app.
- **PAGE-5 Counter (badge).** `badge` is the URI of a resource whose JSON content is `{ "value": <number> }`. The
  client shows it on the page's navigation entry. `@clegra/sdk` serves counters at `webmap://badges/<name>`: like
  `webmap://pages`, not reachable on the web, read only with `resources/read` as the person.
- **PAGE-6 Tile (widget).** A resource with `_meta["com.clegra/web-map"].widget: { "sizes": ["small", "medium"] }`
  is a tile the person may pin (`@clegra/sdk` serves tiles at `webmap://widgets/<name>`, like the counters). Its JSON content is this minimal payload, which any client can draw:

```json
{ "title": "Open jobs", "value": 12, "unit": "jobs", "trend": "up",
  "rows": [{ "title": "Replace boiler, building B", "subtitle": "Harbor Supplies Ltd", "status": "late",
             "url": "https://jobs.example.com/orgs/7/jobs/318" }],
  "url": "https://jobs.example.com/orgs/7/jobs?status=open" }
```

  Only `title` is required; `rows` use the roles of `card` (REC-4). A richer tile is an MCP Apps view or an A2UI
  surface the app also offers; where it is pinned is the client's business.
- **PAGE-7 Refresh by change.** Counters and tiles are resources: a client subscribes (`subscriptions/listen` with
  `resourceSubscriptions`) and re-reads on `notifications/resources/updated` or when the URI appears in a result's
  `changed`. It MUST NOT refresh on a timer.

## 6. Reused as they are: install, tools of an open page, UI

Nothing in this section is new wire; it says which existing standard does the job.

- **Install as an app: the Web Application Manifest.** A client fetches the start page of the proven `origin`,
  follows `<link rel="manifest">` and uses the manifest as it is; without one it falls back to the card's name and
  icon. A client ignores a manifest whose `scope` does not contain `origin`. A single page is
  installable or pinnable as its own app when its URL is one of the manifest's `shortcuts`.
- **Tools of an open page: WebMCP** (a W3C Community Group draft). Guidance only. Such calls run on the person's
  session, outside any grant, scope or log, and a browser agent that drives the page can press any button in it.
  So: WebMCP is off until the person turns it on in the app; a page registers only read-only tools and changes the
  app can put back, with the same `name` and checks as the MCP tool; tools that need the app's confirmation
  ([confirmation](confirmation.md), ACT-2) are not registered on the page at all: an agent reaches them through the
  MCP server, with a grant and the confirmation.
- **Drawing: UI-format neutral.** The map says nothing about how a client draws a card, a list, a tile or a tool
  result. A client MAY draw natively from `card`, the tile payload and `structuredContent`, from an A2UI surface
  carried over MCP, or show an MCP Apps view (which may itself render A2UI). Whatever the surface, an action
  started from it is an ordinary `tools/call`, subject to the tool's annotations, the grant's scopes and the app's
  confirmation: a UI surface is never a way around them.

## 7. Graceful degradation, security, privacy

A client without this extension sees a normal MCP server: tools, records as `https` resources it can read either
way (REC-1), one more resource it may ignore. A server MUST NOT require the extension.

- Everything this extension carries is third-party data: displayed, never executed, never placed above the
  client's own instructions to a model.
- A hostile server cannot claim someone else's site (ORG-1), a hostile map cannot point elsewhere (ORG-2), and a
  token never travels to an origin it was not issued for (REC-1).
- Beyond tool arguments, a client MUST NOT attach conversation transcripts or the person's profile data to
  requests, and SHOULD NOT put conversation text into arguments the tool's schema does not ask for.
- **Who holds what.** The app is the controller of its records; the client is the controller of its own history,
  where tool results stay and pass through its model. A client MUST state how long it keeps tool results and MUST
  delete them when the grant is revoked.

## 8. Adopting it

What an app that already has an MCP server adds: `_meta` on tools and record templates, the pages resource, the
settings object, and **one route and one rule per record type** for REC-1. A catalog entry (shape as the AI
Catalog specifies) only if the MCP endpoint is on another origin. Tool annotations stay the core's and MUST be
truthful.

**In `@clegra/sdk`** (from 0.4.0): `defineEntity({ name, path, card, get, list })` declares the record type: its
`path` is the record template on the app's origin (`/jobs/{id}`), `card` the roles of REC-4. A tool's `entity` and `on`
(`record` or `collection`) and its `page` give the tool's `_meta`; `definePage({ path, role, entity, nav, tools, badge,
frame, allow })` adds a page to `webmap://pages`, filtered per person; counters and tiles are `defineBadge` and
`defineWidget`, at `webmap://badges/<name>` and `webmap://widgets/<name>`. `serve(app, …)` puts the settings object in
`server/discover`, lists records as `resource_link`s in results, answers `resources/read` on record URLs, serves the
Server Card and the AI Catalog, and answers the bearer `GET` of REC-1 on the record URL itself: `served.fetch` takes a
`GET` with `Authorization: Bearer` at a record path; every other request goes to the app's own pages (with Next.js,
`recordProxy()` rewrites only bearer requests). Reference: [the SDK's spec](../spec.md).

A sketch of REC-1 in Rails, where the page controller answers bearer requests itself and cookie requests are
unchanged:

```ruby
class JobsController < ApplicationController
  skip_before_action :require_login, only: :show, if: :bearer?
  before_action :mcp_record, only: :show, if: :bearer?

  def show = respond_to { |f| f.html; f.json { render json: @job } }   # as before, for people and your front end

  private

  def bearer? = request.authorization.to_s.start_with?("Bearer ")
  def mcp_record
    user = McpToken.verify(request)                  # signature, expiry and audience = the MCP resource
    unless user
      response.headers["WWW-Authenticate"] = %(Bearer resource_metadata="#{SITE}/.well-known/oauth-protected-resource/mcp")
      return head(:unauthorized)
    end
    response.headers["Vary"] = "Authorization"; response.headers["Cache-Control"] = "private, no-store"
    render json: Job.visible_to(user).find(params[:id]).as_json(only: %i[id title status customer_name due])
  end
end
```

## 9. Conformance scenarios

1. **Origin proof**: the extension is ignored when `origin` is neither the endpoint's nor proven by the catalog; a
   map URL on another origin is rejected (ORG-1, ORG-2).
2. **Map integrity**: every `page` variable can be filled; non-reciprocal `tools`, `get`, `list` entries are
   ignored (MAP-1 to MAP-3).
3. **Record address**: `resources/read` and `GET` with a valid bearer token return the same JSON; an invalid token
   gets `401`; a request without a bearer token gets what it got before. A second person's token never returns the
   first's data.
4. **Audience**: an MCP token presented at an origin other than its audience's gets `401`, and a client never
   sends it there.
5. **Pages**: the pages resource lists only what the caller may open, refuses an unauthorized read, and nothing
   of the map is reachable at a well-known path or in the Server Card (ORG-5); no page appears in `resources/list`.
6. **Counters and tiles** change after `notifications/resources/updated`, with no timed read in between.
7. **Degradation**: a client that declares nothing sees a normal MCP server.

## 10. Process and open issues

Maintainers, reference implementation and the path to an official repository: [the index](README.md), «Process». The reference implementation is `@clegra/sdk`, whose
`check` command runs the scenarios above against a running app.

Open: (1) the AI Catalog, on which ORG-1 rests, is a release candidate (v0.9) and may change before v1.0; (2) not
verified on the normative text: the cache members of `resources/read` and `server/discover`; (3) no
standard hand-off of theme and language to an embedded page; (4) the fixed URI `webmap://pages` uses an
unregistered scheme.

## Appendix. JSON Schemas (draft 2020-12; the `$id` is a placeholder)

```json
{
  "$id": "https://example.org/com.clegra/web-map/0.2", "$defs": {
    "url": { "type": "string", "format": "uri", "pattern": "^https://" },
    "serverSettings": { "type": "object", "required": ["revision", "origin"], "properties": {
      "revision": { "const": "0.2" }, "origin": { "$ref": "#/$defs/url" },
      "origins": { "type": "array", "items": { "$ref": "#/$defs/url" } } } },
    "tool": { "type": "object", "properties": {
      "entity": { "type": "string" }, "on": { "enum": ["record", "collection"] },
      "recordArg": { "type": "string", "default": "id" }, "page": { "type": "string" } } },
    "record": { "type": "object", "required": ["entity"], "properties": {
      "entity": { "type": "string" }, "get": { "type": "string" }, "list": { "type": "string" },
      "card": { "type": "object", "required": ["title"], "additionalProperties": false, "properties": {
        "title": { "type": "string" }, "subtitle": { "type": "string" }, "status": { "type": "string" },
        "amount": { "type": "string" }, "date": { "type": "string" } } } } },
    "resource": { "type": "object", "properties": { "record": { "$ref": "#/$defs/record" },
      "widget": { "type": "object", "properties": { "sizes": { "type": "array", "items": { "enum": ["small", "medium", "large"] } } } } } },
    "pages": { "type": "object", "required": ["pages"], "properties": { "pages": { "type": "array", "items": {
      "type": "object", "required": ["url", "name", "title", "role"], "properties": {
        "url": { "type": "string" }, "name": { "type": "string" }, "title": { "type": "string" },
        "role": { "enum": ["list", "record", "create", "dashboard", "settings", "other"] }, "entity": { "type": "string" },
        "nav": { "type": "object", "properties": { "section": { "type": "string" }, "order": { "type": "number" } } },
        "tools": { "type": "array", "items": { "type": "string" } }, "badge": { "type": "string", "format": "uri" },
        "frame": { "type": "boolean", "default": false } } } } } },
    "badge": { "type": "object", "required": ["value"], "properties": { "value": { "type": "number" } } },
    "tile": { "type": "object", "required": ["title"], "properties": {
      "title": { "type": "string", "maxLength": 80 }, "value": { "type": ["number", "string"] }, "unit": { "type": "string" },
      "trend": { "enum": ["up", "down", "flat"] }, "url": { "$ref": "#/$defs/url" },
      "rows": { "type": "array", "maxItems": 10, "items": { "type": "object", "required": ["title"], "properties": {
        "title": { "type": "string" }, "subtitle": { "type": "string" }, "status": { "type": "string" },
        "amount": { "type": "string" }, "date": { "type": "string" }, "url": { "$ref": "#/$defs/url" } } } } } },
    "result": { "type": "object", "properties": { "changed": { "type": "array", "items": { "type": "string", "format": "uri" } } } }
  }
}
```

## References

MCP 2026-07-28 (tools, resources, subscriptions, extensions, authorization); SEP-2127 Server Cards
(https://modelcontextprotocol.io/seps/2127-mcp-server-cards, the extension's schema and discovery in
https://github.com/modelcontextprotocol/ext-server-card); AI Catalog v0.9 (https://github.com/Agent-Card/ai-catalog,
specification/ai-catalog.md);
MCP Apps; A2UI and its MCP guides (https://a2ui.org/guides/a2ui-in-mcp-apps/); WebMCP (W3C Community Group draft);
W3C Web Application Manifest; RFC 6570, 8288, 8707, 9728.
