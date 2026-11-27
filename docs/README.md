# Clegra apps

> A Clegra app is a **web app with a plain MCP server**, built with the package `@clegra/sdk`, plus a few small MCP
> extensions and profiles: [extensions/README.md](extensions/README.md), normative from `@clegra/sdk` 0.4.0.

Three ideas carry it:

- **The agent always uses MCP tools**, interactive and in the background: never the app's pages. Each tool says
  truthfully what it does (the core annotations), names its record type and its page ([web-map](extensions/web-map.md)).
- **Pages are for people.** Every record is an MCP resource whose URI is its own web address, so a result opens the
  right page; the app's pages, navigation, counters and tiles are one resource inside the MCP server, per person; a
  workspace opens the real pages inside itself.
- **One sign-in.** The person signs in once, on the app's own page, through OAuth: that grant gives the MCP token
  and, through [session transfer](extensions/session-transfer.md), the session of the app's site in a workspace's web
  view or frame. What cannot be undone is confirmed by the person on the app's own page
  ([confirmation](extensions/confirmation.md)).

| Extension or profile | For |
|---|---|
| [extensions/README.md](extensions/README.md) | The index: kinds of document, adoption levels A, B1, B2, C, what works today |
| [web-map](extensions/web-map.md) | `com.clegra/web-map`: tools, records and pages joined; badges, tiles, Server Card |
| [app-share](extensions/app-share.md) | `com.clegra/app-share`: «Condividi» (share) between apps, and targeted plugins |
| [session-transfer](extensions/session-transfer.md) | The app's pages opened already signed in: strong and Clerk-compatible modes |
| [access](extensions/access.md) | Scopes, grants, revocation, the log, error codes |
| [app-agents](extensions/app-agents.md) | Ready-made agents shipped as skills |
| [confirmation](extensions/confirmation.md) | Confirmation the app itself verifies, by URL-mode elicitation |
| [event-types](extensions/event-types.md) | Notifications and activities as Events |

## The SDK

| Read | For |
|---|---|
| [spec.md](spec.md) | The reference: definitions, what they become on the wire, `serve` and its routes, confirmation, session transfer, events, the access log, adapters, testing, the check CLI |
| [start-javascript.md](start-javascript.md) | Getting started in plain JavaScript (any runtime with Fetch; `listen` on Node) |
| [start-next.md](start-next.md) | Getting started with Next.js (`npx @clegra/sdk init`, the three files, `recordProxy`) |
| [auth.md](auth.md) | The sign-in module (`createSignIn`, `passwordLogin`, `devSignIn`), or your own authorization server (`auth.verify`) |
| [ai-guide.md](ai-guide.md) ([llms.txt](llms.txt)) | The single-file reference for coding agents |
| [CHANGELOG.md](../CHANGELOG.md) | What changed |
| [RELEASE.md](RELEASE.md) | What the tarball ships, the pack check, publishing |

`@clegra/ui`, Clegra's design system, is a separate package with its own guide; this one does not depend on it.

**Examples.** Clegra's own apps are this package's examples and live outside this repository: a job-requests app and
an accounting-software connector built on `@clegra/sdk`, and an ERP connector that is a plain MCP server with its own
OAuth, not built on this package, which follows the same extensions.
