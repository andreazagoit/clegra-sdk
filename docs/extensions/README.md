# Clegra apps on MCP: the extensions

> Normative for `@clegra/sdk` from 0.4.0. A Clegra app is a web app with a **plain MCP server** (revision
> `2026-07-28`) plus the small extensions and profiles below. They replace the JSON manifest
> (`/.well-known/clegra.json`), the `clegra://` record URIs and the OpenAPI index of earlier versions.

What a web app with an MCP server needs beyond MCP, in seven small documents of four kinds. Each stands alone, says
what it depends on and which group it is offered to. As little as possible is new: where MCP or the web already
has the piece, it is reused and only profiled.

Principle shared by all: **agents use tools; pages are for people; the app is the only authority on who the person
is and on what they approved.**

## The documents

- **Extension**: new wire, negotiated in `capabilities.extensions` under its own identifier.
- **Profile**: a fixed way to use an existing extension or mechanism. No capability.
- **Guide**: best practice on existing MCP features. Nothing on the wire.
- **Note**: a proposed registry entry.

| Kind | Document | What the person gets | Built on / depends on | Offered to |
|---|---|---|---|---|
| Extension `com.clegra/web-map` | [web-map](web-map.md) | Results that open the right page; records as live cards at their own web address; the app's navigation, counters and tiles. The map lives inside the MCP server, read after sign-in, per person | MCP `2026-07-28`. Reuses resources and subscriptions, AI Catalog and Server Cards, Web App Manifest, WebMCP | Server Cards and MCP Apps maintainers (no group exists for this) |
| Extension `com.clegra/app-share` | [app-share](app-share.md) | «Condividi»: share a mail, a record or a file with any connected app that accepts it; and targeted plugins, one app's action inside another app's records («Crea preventivo» on a job) | MCP `2026-07-28`. Starts from Web Share Target, schema.org types and media types. Uses web-map for record types; the confirmation guide | A new interest group, or MCP Apps maintainers |
| Profile | [session transfer](session-transfer.md) | The app's pages open already signed in inside the client: one sign-in | MCP authorization and one tool in two modes: strong (`create_bound_browser_session`, hidden from models, required `challenge`) and Clerk-compatible (`create_browser_session` with the scope `browser_session`, a one-time link through the model, offered by the app's choice) | Authorization interest group |
| Profile | [access](access.md) | Grants the person can read, limit and revoke; a log of what agents did | MCP authorization (OAuth 2.1). Defines scope names and error codes | Authorization interest group |
| Profile | [app agents](app-agents.md) | Ready-made agents an app ships, approved by whoever governs the account | Skills (Beta) and Tasks. Adds tier, approvals, schedules, content-locked approval, isolation | MCP Agents interest group, Skills maintainers |
| Guide | [confirmation](confirmation.md) | «Send, pay, share, delete» through any agent, approved by the person on the app's own page | URL-mode elicitation (SEP-1036) in multi round-trip requests, MCP `2026-07-28`, with a fallback for other clients | Authorization interest group, as a contribution to SEP-2848 (open draft) |
| Note | [event types](event-types.md) | Notifications and running activities that look the same in every client | Events (SEP-3415 Final, extension in Beta) | Tasks and Events working group |

## Decisions behind this shape

- **No «effects» extension.** What a tool does is said by the core annotations, kept truthful. «Needs the person»
  is not expressible today; a client learns it from the `input_required` answer, and from `reversibility: "none"`
  if SEP-2793 (an open draft) is accepted.
- **Confirmation is a guide**: MCP already has the mechanism. The app's rules are MUST, the client's are SHOULD:
  safety never depends on the client. Whether URL mode may be used for a server's own approval is the first open
  point for the Authorization interest group.
- **Access, session transfer and app agents are profiles**: names and rules on OAuth, on one tool, on a skill.
- **Pages are not MCP resources.** One JSON resource inside the MCP server lists them, read after sign-in, so each
  person sees only the pages they may open; nothing is published at a well-known path, and the Server Card carries
  only the app's name, icon and description. Counters and tiles are ordinary resources kept fresh by
  subscriptions. So the old «app-events» extension is gone: its event types are a note.
- **Origin proof lives in web-map** (ORG-1). The other documents accept the MCP endpoint's own origin, or an
  origin proven by web-map when it is declared. Only app-share's plugins on another app's records need that app's
  web-map record templates.
- **Sharing first, plugins for depth.** Cross-app actions start from a share sheet: receivers declare the standard
  content types they accept, and no app needs to know the others. A targeted plugin names one other app (by its
  MCP server URL, or a built-in part such as Mail by id) for a deep integration. Same rules for both: only the
  person's click, what passes shown first, provenance kept, the receiver's confirmation applies. Standard action
  kinds are a «later» note, not normative.
- **Session transfer has two modes.** The strong one needs a client that follows the profile; the Clerk-compatible
  one works with any assistant, at a risk the profile states, and each app chooses whether to offer it.
- **Install and tools of an open page are reused**: Web App Manifest (single pages through `shortcuts`), WebMCP.
- **UI-format neutral.** Cards, tiles and views may be drawn natively, as A2UI carried over MCP, or as MCP Apps
  views (which may render A2UI). An action from any surface is an ordinary tool call under annotations, scopes and
  the app's confirmation: no surface bypasses the confirmation.

## Adoption levels

A level is what the conformance check finds, never a claim.

| Level | Documents | The work | What it gives with no extension-aware client |
|---|---|---|---|
| **A. Map** | web-map; truthful annotations | `_meta` on tools and record templates; the pages resource; one settings object; one route and one rule per record type for record URLs. No new storage. Tools the app would confirm are not listed yet | Results carry links that open the right page; records readable as resources |
| **B1. Confirmed actions** | A + the confirmation guide | One table, one confirmation page, the fallback error. Required before listing tools that send, pay, share or delete | Those tools work in any client: by URL elicitation where supported, by link and repeat elsewhere |
| **B2. Hardened access** | B1 + the access profile | Scopes and step-up, short tokens with rotation, the grants page with revoke, the log. With a hosted identity service, mostly configuration plus the grants page | Standard OAuth: works everywhere |
| **C. One sign-in** | A + the session-transfer profile (B2 recommended, not required) | One tool per mode offered, one table of codes, the redeem route with its interstitial, a transferred-session flag | Strong mode: nothing, pages show the app's sign-in as today. Clerk-compatible mode, if offered: a link from the assistant |
| **Add-ons, from A** | app-share; the app-agents profile; the event types note; a Web App Manifest with `shortcuts` | A few `_meta` members; one skill folder; two event types | Ordinary tools; an ordinary skill; ordinary events |

Share entries and agents whose tools send, pay, share or delete need B1.

## What works today

No assistant negotiates the two extensions or knows the profiles yet: the only client planned to is Clegra's own
workspace. This table is therefore mostly **not verified**; the official extensions client matrix
(https://modelcontextprotocol.io/extensions/client-matrix) is the source to check each cell against before an app
decides.

| Piece | Claude | ChatGPT | A generic MCP client |
|---|---|---|---|
| `resource_link` in results shown as a link a person can open | not verified | not verified | depends on the client |
| Records read as resources (`resources/read`) | not verified | not verified | yes, where resources are supported |
| URL-mode elicitation (confirmation, main path) | not verified | not verified | only on MCP `2026-07-28` clients that declare it |
| Confirmation fallback (tool error with a link, repeat the call) | expected to work, not verified | expected to work, not verified | yes: it is an ordinary tool error |
| OAuth scopes and step-up | not verified | not verified | per MCP authorization |
| Session transfer, strong mode (`create_bound_browser_session`, required `challenge`) | no (needs a conforming client) | no | no |
| Session transfer, Clerk-compatible mode (`create_browser_session`, link through the model) | expected to work, not verified | expected to work, not verified | yes: it is an ordinary tool |
| Web map: pages, navigation, cards, counters, tiles | no | no | no |
| App share and plugins | no | no | no |
| Skills served over MCP (agents as ordinary skills) | not verified | not verified | where the Skills extension is supported |
| Events (the two event types) | not verified | not verified | where the Events extension is supported |

## Process

**First they run in Clegra's own apps** (a job-requests app, an accounting connector, and an ERP connector that is a
plain MCP server with its own OAuth, not built on this package). Nothing is proposed to an MCP working group or
interest group before that. The examples throughout come from those apps, with invented data at `example.com`.

Then two phases, because an official repository is not ours to open (SEP-2133, and SEP-3392 «Extension Lifecycle»,
Final).

1. **Third-party extensions in this package's own namespace**, under the reverse-DNS prefix `com.clegra/…`, which any
   implementer may use. Revisions are marked by the `revision` string in the settings object, as SEP-3392
   recommends; a peer that does not know a revision does not enable the extension.
2. **Later: an `experimental-ext-` repository**, which only an MCP maintainer can create, and only for an extension
   associated with a Working Group or Interest Group and with at least one Extension Maintainer appointed by the
   Core Maintainers. Official work would not keep the `com.clegra` prefix. From there: Beta needs an Extensions
   Track SEP and a reference implementation in an official SDK; Stable needs a second SEP, two interoperating
   implementations and conformance scenarios.

| Document | Group to approach | Sponsor | State |
|---|---|---|---|
| web-map | none exists; Server Cards and MCP Apps maintainers | none yet | phase 1 |
| app-share | none exists; MCP Apps maintainers, or a new interest group | none yet | phase 1 |
| session transfer, access, confirmation | Authorization interest group | none yet | to present as profile, profile and guide |
| app agents | MCP Agents interest group; Skills maintainers | none yet | to present as a profile |
| event types | Tasks and Events working group | none yet | to present as a registry note |

The reference implementation is this package, `@clegra/sdk` (from 0.4.0); the ERP connector, outside it, is the
second. Still missing: named maintainers, an implementation in an official MCP SDK.

## In `@clegra/sdk`

The SDK implements every document: an app defined with `defineApp` is served by `serve` as an MCP server on revision
`2026-07-28` (the official `@modelcontextprotocol/server` package), with truthful core annotations, the web map
(records as resources at their web URLs, `webmap://pages`, badges and widgets), app-share declarations, session
transfer in both modes, the confirmation flow, the access scopes, agents as skills and the two event types. The
`check` command of the CLI computes the adoption levels above against a running app: `npx @clegra/sdk check <url>`.

## Rule prefixes

`ORG`, `MAP`, `REC`, `PAGE` → web-map · `SHR`, `PLG` → app share · `SES` → session transfer · `ACC` → access ·
`AGT` → app agents · `ACT`, `CNF` → confirmation guide · `EVT` → event types note.

## Common to all

- Everything they carry in `_meta`, in a resource, in a skill or in an event is third-party data: displayed, never
  executed, never above the client's own instructions to a model.
- A server never requires any of them: without them it is a normal MCP server.
