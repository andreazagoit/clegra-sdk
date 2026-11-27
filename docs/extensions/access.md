# Profile: access (scopes, grants, errors)

| | |
|---|---|
| **Kind** | Profile on MCP authorization (OAuth 2.1). No capability. On the wire only names: the scopes of §1 and four error codes |
| **Status** | Draft 0.1 |
| **Builds on** | MCP authorization: RFC 9728, 8414, 8707, 9207, Client ID Metadata Documents; RFC 7009; SEP-990 |
| **Used by** | [confirmation](confirmation.md) (errors, the `web.irreversible` scope), [session transfer](session-transfer.md) (the `bound_browser_session` and `browser_session` scopes, revocation), [app agents](app-agents.md) (`offline_access`) |
| **Offered to** | Authorization interest group |

MUST, SHOULD and MAY (RFC 2119) say what an app that follows this profile does. It is hardening: an app can offer
the confirmation of the guide without it (level B1), and adds it for level B2 ([the index](README.md)).

## 1. Scopes

| Scope | Allows | Asked for |
|---|---|---|
| `web.read` | Tools with `readOnlyHint: true`, reading resources | At first connection |
| `web.write` | Tools that change data | By step-up, when first needed |
| `web.irreversible` | Tools the app confirms (ACT-2 of the guide) | By step-up, when first needed |
| `bound_browser_session` | Only the tool `create_bound_browser_session`, the strong mode of [session transfer](session-transfer.md) | Only by a client that opens pages and follows that profile |
| `browser_session` | Only the tool `create_browser_session`, the Clerk-compatible mode (link through the model) | Only where the app offers that mode; its own consent line |
| `offline_access` | Work with nobody present (a refresh token) | Only when the person enables background work |

OAuth scopes are local to their authorization server, hence no reverse-DNS; `browser_session` is Clerk's name for
the same tool, kept so that the Clerk-compatible mode is that in name too. An app MAY refine these with scopes of its own.

- **ACC-1 Shown and minimal.** The consent page shows each scope in plain words, each on its own line; a grant
  holds only what the client asked for; a token without any of them can only read.
- **ACC-2 Step-up.** A call above the token's scope gets `403` with
  `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, the standard step-up. Scopes never widen
  rights: the app checks what the person may do now, on every call.

## 2. The grant

- **ACC-3 The app is the authority.** Sign-in and consent are the app's pages, and the app never accepts, as proof
  of who the person is, anything asserted by a client. The authorization server's issuer SHOULD be same-site with
  the app. With a hosted identity service this means its custom-domain option; where that is not available the
  app says so in its documentation, and the rest of the profile still applies.
- **ACC-4 Sign-in.** Authorization happens in the person's system browser (RFC 8252), never in a web view of the
  client. If that browser already holds another person's session the app asks which to use. Sign-in and consent
  send `frame-ancestors 'none'`, show the client (host of `client_id`, redirect target), and are never remembered
  for loopback or custom-scheme redirects, where they also warn that the application cannot be verified. The client
  is known by its Client ID Metadata Document: an https URL on a public host, fetched only when every address of the
  host is public. Outside production an app MAY also accept a document (and its `jwks_uri`) at http on a loopback
  name (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`), deciding from its own configuration and never from the
  request; in production it MUST NOT.
- **ACC-5 Tokens.** Access tokens are audience-bound (RFC 8707) and SHOULD live at most 10 minutes; refresh tokens
  rotate, and a reused one revokes the whole grant. Without `offline_access` no refresh token outlives the
  person's presence, and the client says background work is unavailable. Sender-constrained tokens (DPoP, RFC
  9449) are recommended when the client offers them, and required before a token is accepted at any origin other
  than the MCP endpoint's.
- **ACC-6 Visible and revocable.** The app MUST have a page listing each grant (client, scopes, background,
  browser sessions, enterprise-managed, last use) with a button to revoke. Revocation (also RFC 7009) MUST at once
  refuse the tokens, close the grant's open streams, cancel its tasks and pending confirmations and end its
  transferred sessions.
- **ACC-7 Log.** The app MUST keep, and let the person read and obtain, a log of every call that changed data,
  every confirmation and every session transfer: time, client, tool, record URL, outcome, and for confirmed calls
  the confirmation's id, digest and time. It declares how long it keeps the log and stores no arguments beyond what
  that needs. Read-only calls SHOULD be logged too. Calls made through WebMCP in an open page are logged as
  «browser agent».
- **ACC-8 Enterprise-managed authorization** (SEP-990) MAY be accepted from an identity provider the customer
  configured in the app. Such a grant is capped at `web.read` and `web.write` within limits the administrator
  set; `web.irreversible` and the two browser-session scopes need the person's own consent on the app's page. The app tells the
  person at first use, and the grant appears in ACC-6.

## 3. With a hosted identity service

Not verified per vendor: check each point in your provider's settings before relying on it.

| Point | What to look for | If it is missing |
|---|---|---|
| Custom scopes, per client | The scopes above, not in the default set, so each client is approved for them | Enforce the scope inside the tool handler from the token's claims |
| Token lifetime | Access token lifetime setting; refresh rotation with reuse detection | Keep the provider's default and say so; revocation (ACC-6) matters more |
| Audience | The token's audience is checked on the `/mcp` route | Do not ship: any client of the same tenant could call the server |
| Custom domain | Sign-in and consent under the app's own domain | ACC-3 is a SHOULD: document the provider's domain |
| Grants page and revoke | A per-user list of authorized clients with revoke, or an API to build one | Build the page on the provider's API; it is the one part that cannot be skipped |
| Step-up | `insufficient_scope` leads the client to ask again | Ask for all scopes at first connection and show them clearly |

## 4. Error codes

Tool errors are results with `isError: true` and `structuredContent.error: { "code", "message", … }`.

| Code | When | Extra members |
|---|---|---|
| `confirmation_required` | The person must confirm on the app's page, then the client repeats the call (guide, CNF-8) | `url`, `expiresAt` |
| `confirmation_declined` | The person declined on the page | |
| `confirmation_expired` | Nobody confirmed in time | |
| `confirmation_stale` | The record changed between confirmation and run (guide, CNF-4) | |

Protocol and HTTP errors are the core's and OAuth's: `-32021` (a required client capability was not declared),
`401` + `WWW-Authenticate`, `403` + `insufficient_scope`, `invalid_grant`.

## In `@clegra/sdk`

From 0.4.0 every tool's scope follows from its annotations and its confirmation (`web.read`, `web.write`,
`web.irreversible`), checked on every call with the standard step-up answer (ACC-2); `serve` takes an `audit` hook
that receives each change, confirmation and session transfer (ACC-7), and a revocation from the app's grants page
ends the grant's transferred sessions and pending confirmations (ACC-6). The sign-in module (`@clegra/sdk/signin`)
is an OAuth 2.1 server with these scopes on its consent page, ten-minute audience-bound tokens and rotating
refresh tokens with reuse detection (ACC-5).

## 5. Checks

1. A `web.read` token calling a tool that changes data, and a `web.write` token calling an ACT-2 tool, get
   `insufficient_scope`; a token without scopes can only read.
2. A token issued for another audience is refused.
3. A reused refresh token revokes the grant.
4. After revoking: the next call fails, open streams close, pending requests are cancelled, transferred sessions
   end.
5. The log shows the changes, confirmations and session transfers of a test run, and can be exported.

## 6. Open points

1. Whether the scope names should be proposed as shared names or stay a recommendation.
2. DPoP as a requirement waits for an MCP profile of it (a proposal exists; not verified here).
3. Table §3 needs one verified column per widely used provider.

References: MCP authorization; SEP-990, SEP-991 (Final); RFC 6750, 7009, 8252, 8414, 8707, 9207, 9449, 9728.
