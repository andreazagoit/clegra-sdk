# Changelog

Clegra apps 1.0 and the `clegra` package (not published yet). Newest first. Entries older than the rename below keep
the names of their time (the `modelapp` package, docs/map): they are history.

## Unreleased (1.0 draft)

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
