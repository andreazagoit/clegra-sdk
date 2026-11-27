# Profile: session transfer, one sign-in for the grant and the pages

| | |
|---|---|
| **Kind** | Profile on MCP authorization and tools. No capability: two modes, each with a fixed tool name, a fixed scope and one `_meta` marker |
| **Status** | Draft 0.3 |
| **Builds on** | MCP authorization (OAuth 2.1), an ordinary MCP tool; any MCP revision. Usable from level A ([the index](README.md)) |
| **Aligned with** | Clerk's `create_browser_session` MCP tool (read 2026-11-27; Beta); Auth0 session transfer tokens; OpenID Connect Native SSO; RFC 8693 |
| **Offered to** | Authorization interest group |

MUST, SHOULD and MAY (RFC 2119) say what an app or client that follows this profile does. Terms and the rest of the
family: [the index](README.md).

## 1. What it is

The person signs in once, in the system browser, when they connect the app to a client. Afterwards a client that
opens a page of the app in a browser context of its own (a desktop web view, a web frame, a phone) first obtains
a session of the app there, from the grant, with a one-time code. The person does not sign in twice.

A token is a grant, not a session: it is never copied into a browser. What the browser gets is a **transferred
session**: this person, with the OAuth permissions granted to the client (normally all the person's) and without
the account's keys.

Two modes. An app offers the strong mode, and MAY also offer the Clerk-compatible mode:

- **Strong mode** (§2, §3): the client calls a tool hidden from models, with a required `challenge`, and redeems
  the code by a `POST` carrying the verifier. A link copied anywhere is useless. It needs a client that follows this
  profile.
- **Clerk-compatible mode** (§4): for clients that know nothing of this profile (general assistants such as Claude
  or ChatGPT). A tool the model can call returns a one-time link, which the person opens. Same tool and scope names
  as Clerk's. Weaker, and said so (§7).

## 2. Strong mode: the fixed parts

| Part | Strong mode | Clerk-compatible mode (§4) |
|---|---|---|
| Tool name | `create_bound_browser_session` | `create_browser_session` |
| Scope | `bound_browser_session`, needed by this tool only | `browser_session`, needed by this tool only |
| Marker | `_meta["com.clegra/session-transfer"]: { "revision": "0.3", "mode": "bound" }` and `_meta.ui.visibility: ["app"]` | `_meta["com.clegra/session-transfer"]: { "revision": "0.3", "mode": "link" }`; visible to models |
| Input | `{ "target", "challenge" }`, both required; `challenge` is the base64url SHA-256 of a verifier | `{ "target" }` |
| Output (`structuredContent`) | `{ "url": <redeem URL with a one-time code>, "expiresAt" }` | the same |
| Redeem | `POST` with the verifier; a bare `GET` shows the interstitial | `GET` with the interstitial, always |

Scopes are described in [access](access.md). A client knows the app follows the profile by the marker on the tool.
Nothing is negotiated.

```json
{ "name": "create_bound_browser_session", "title": "Open the app signed in",
  "inputSchema": { "type": "object", "required": ["target", "challenge"], "additionalProperties": false, "properties": {
    "target": { "type": "string", "format": "uri", "pattern": "^https://" },
    "challenge": { "type": "string", "minLength": 43, "maxLength": 43 } } },
  "outputSchema": { "type": "object", "required": ["url", "expiresAt"], "properties": {
    "url": { "type": "string", "format": "uri" }, "expiresAt": { "type": "string", "format": "date-time" } } },
  "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false },
  "_meta": { "com.clegra/session-transfer": { "revision": "0.3", "mode": "bound" }, "ui": { "visibility": ["app"] } } }
```

**Redeeming.** The client loads `url` in the browser context that will hold the session by a form `POST` with the
body `verifier=…`. The app checks code and verifier, sets the session cookie and answers `303` to `target`. Where
a context can only navigate (`GET`), no verifier is sent and the app shows an interstitial first (SES-4).

## 3. Rules

SES-1 to SES-11 are the strong mode. SES-4 to SES-6 and SES-10 apply to both modes; §4 adds the rest of the
Clerk-compatible mode.

- **SES-1 Its own scope.** `bound_browser_session` is a separate line on the consent page («open this app's pages
  signed in as you»), implied by no other scope, never a default scope. Without it the tool answers
  `insufficient_scope`, and pages show their own sign-in.
- **SES-2 `challenge` is required.** The app MUST refuse a call without it. The code has at least 128 random bits,
  is single use, expires within 60 seconds, and is bound to the grant, the `client_id` (and its DPoP key), `target`
  and `challenge`. `target` MUST be a URL of the app's origin (a page or record of `com.clegra/web-map`, when
  declared); the app never redirects anywhere else. No access or refresh token ever appears in a URL, a cookie or
  a page.
- **SES-3 The verifier never travels in a URL.** It goes only in the body of the `POST` the client makes in the
  context it opens, and the client keeps it out of any model's reach. A `url` copied from a log, a transcript or
  a message is useless without it. The redeem response has `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer`; the app rejects a redeem `POST` that another website initiated (`Origin`,
  `Sec-Fetch-Site`), except a web origin the client registered in its Client ID Metadata Document.
- **SES-4 Navigation only: an interstitial, always.** A `GET` on `url` never creates a session by itself. The app
  shows «You are entering as X through the client Y, started at hh:mm. Continue / This is not me», and creates the
  session only after the person presses «Continue» on that page. «This is not me» consumes the code and offers to
  revoke the grant. This is what stops a link, sent by someone else, from signing a person into the sender's
  account.
- **SES-5 Never over someone else.** If the context already holds this person's session, it is kept. If it holds
  another person's, the app MUST NOT replace it: it refuses, says who is signed in and offers to sign out; the
  code stays valid until it expires. Every transferred session shows who is signed in and through which client,
  with sign-out one touch away.
- **SES-6 Reduced privileges, enforced by the app.** A transferred session:
  1. has the OAuth permissions granted to the client, normally all the person's, and no more (read-only without
     `web.write`);
  2. cannot reach sign-in, consent, the confirmation page and «Pending requests» ([confirmation](confirmation.md)),
     or the grants page: these need a session born from the person's credentials, in the system browser;
  3. cannot perform account-security actions (password, multi-factor settings, API keys, a full export of the
     account, invitations, and any other account-security setting the app has) nor any action the app confirms
     (ACT-2) without a fresh login with the person's credentials;
  4. has a short life of its own (for example 1 hour idle, 8 hours at most), in a cookie of its own, distinct from
     the normal session's: `__Host-` prefixed, `Secure; HttpOnly; Path=/`, `SameSite=Lax`, or
     `SameSite=None; Partitioned` when redeemed in a frame; never an unpartitioned `SameSite=None` cookie;
  5. ends when the grant or the mode's scope is revoked.
- **SES-7 On the person's device only.** The browser context MUST be a user agent on the person's own device. A
  client MUST NOT redeem in a hosted or remote browser: that would put a reusable session of the person on a
  server.
- **SES-8 Frames.** In a frame the app serves only pages it declared framable (`frame` in the web map), with
  `frame-ancestors` limited to the web origins the client registered in its Client ID Metadata Document.
- **SES-9 The client** calls the tool itself, only at the moment it opens a page for the person. The tool is not
  offered to a model and its result never enters a model's context, a transcript or a log. The client MUST NOT
  read, export or reuse the context's cookies and MUST NOT automate the page it opened.
- **SES-10 Visible.** The app MUST list grants holding either scope on its grants page and log each transfer (time,
  client, target), as [access](access.md) ACC-7.
- **SES-11 Token exchange.** An app MAY also offer the issuing step as OAuth token exchange (RFC 8693) at its
  token endpoint; the rules above apply unchanged.

## 4. Clerk-compatible mode, for clients without this profile

Today's general assistants do not know this profile. In the strong mode they get nothing: the tool is hidden from
models, and a host that ignores the mark still cannot get a link, because a call without `challenge` is refused
(SES-2); the person sees the app's own sign-in. An app MAY additionally offer this mode, where the model calls the
tool and hands the link to the person in the conversation, as Clerk's MCP browser sessions do.

```json
{ "name": "create_browser_session", "title": "Open the app signed in",
  "description": "Returns a one-time link that opens this app in the browser, signed in as the current user. Give the link only to the user.",
  "inputSchema": { "type": "object", "required": ["target"], "additionalProperties": false, "properties": {
    "target": { "type": "string", "format": "uri", "pattern": "^https://" } } },
  "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false },
  "_meta": { "com.clegra/session-transfer": { "revision": "0.3", "mode": "link" } } }
```

- **SES-12 The app's choice.** Each app decides whether to offer this mode. It is never required, and an app that
  holds high-value data SHOULD NOT offer it.
- **SES-13 Its own scope.** `browser_session` (Clerk's name) is a separate line on the consent page, worded as
  what it is («give the assistant links that open this app signed in as you»), implied by no other scope and
  never a default scope. Without it the tool answers `insufficient_scope`. It never implies `bound_browser_session`
  nor the reverse.
- **SES-14 A short, single-use link.** The code has at least 128 random bits, is single use, is bound to the grant,
  the `client_id` and `target`, and expires within 5 minutes (a person has to read and press it). `target` follows
  SES-2.
- **SES-15 Interstitial and no switching.** The link is a `GET`, so SES-4 always applies: in an Italian interface
  the page reads «Stai entrando come X tramite Y, alle hh:mm. Continua / Non sono io», in English «You are
  entering as X through Y, started at hh:mm. Continue / This is not me». SES-5 applies unchanged: if the browser
  holds another person's session, the app refuses, says who is signed in and offers to sign out.
- **SES-16 The same reduced session.** SES-6 applies unchanged: the OAuth permissions granted to the client, and a
  fresh login for account-security actions (password, multi-factor settings, API keys, a full export, invitations)
  and for actions the app confirms.
- **SES-17 Logged and visible.** Each issued link and each redeem (time, client, target, the browser's coarse
  description) is in the log ([access](access.md) ACC-7); the app SHOULD show the person a notice when a link is
  redeemed.

**Residual risk, said openly.** In this mode the link is a credential for whoever opens it first, within its
lifetime, and it passes through a model. Text injected into what the model reads (a mail, a web page, a record)
can lead the model to place the link where an attacker sees it: in an argument of another tool, in a URL it
fetches, in an image it renders, in a message. The interstitial does not stop that attacker: it protects a person
from being signed into someone else's account, not a stolen link from being used. What bounds it: the separate
scope the person granted by name (SES-13), a single use and a few minutes (SES-14), no account-security actions
and no confirmed actions (SES-16), the log and notice (SES-17), and revocation. The device rule (SES-7) cannot be
enforced in this mode. An app for which this is too much offers only the strong mode.

## 5. In `@clegra/sdk`

From 0.4.0, `serve` implements both modes on top of the app's own login: the sign-in module's `login.session`, or
`auth.sessions.read(request)` with an authorization server of the app's own. The SDK registers
`create_bound_browser_session` whenever the app has such a login (and `create_browser_session` only when the app sets
`sessionTransfer: { link: true }`), keeps the codes (hashed, single use, bound as SES-2 and SES-14 say), serves
`/session-transfer/<code>` with its interstitial in the person's language, refuses over another person's session
(SES-5), checks who initiated a redeem `POST` (SES-3), and logs every issue and redeem in the access log (SES-10,
SES-17). The transferred session is the SDK's own cookie (`__Host-clegra-transferred`, 1 hour idle, 8 hours at most,
ended by revoking the grant); the app's pages read either session with `served.session(request)` and enforce SES-6 on
their own actions from its `transferred.scopes`. The grant behind it is the sign-in module's, so on a local stack a
client whose Client ID Metadata Document is http on a loopback host gets its per-person links too, outside production
only ([auth](../auth.md); [access](access.md), ACC-4). Reference: [the SDK's spec](../spec.md).

A sketch of the redeem in Rails, for an app without the SDK:

```ruby
# routes: post "/session/:code", to: "transferred_sessions#create"; get → :confirm
class TransferredSessionsController < ApplicationController
  skip_before_action :require_login
  before_action -> { head :forbidden unless allowed_initiator? }, only: :create       # SES-3

  def create
    row = TransferCode.consume!(Digest::SHA256.hexdigest(params[:code]))              # single use, not expired
    return head(:bad_request) unless row && ActiveSupport::SecurityUtils.secure_compare(
      Base64.urlsafe_encode64(Digest::SHA256.digest(params[:verifier].to_s), padding: false), row.challenge)
    if current_user && current_user.id != row.user_id                                 # SES-5
      row.restore!; return render(:other_account, status: :conflict)
    end
    s = Session.create!(user_id: row.user_id, transferred_from: row.grant_id, scopes: row.scopes,
                        idle_ttl: 1.hour, max_ttl: 8.hours)                           # SES-6
    cookies["__Host-transferred"] = { value: s.token, secure: true, httponly: true, path: "/", same_site: :lax }
    response.headers["Cache-Control"] = "no-store"; response.headers["Referrer-Policy"] = "no-referrer"
    redirect_to row.target, status: :see_other, allow_other_host: false
  end

  def confirm = render(:entering_as)   # SES-4: the interstitial; «Continue» posts to its own action, with the page's own forgery token
end
```

## 6. Prior art, and what is aligned

| Source | What it does | Here |
|---|---|---|
| Clerk, MCP browser sessions (read 2026-11-27) | A tool `create_browser_session` returns a one-time link opening the app as the token's subject; custom scope `browser_session`, not a default scope; the link is refused, and stays valid, over another person's session; the session is **restricted** by default (reads only, no profile, organization or consent changes) and short (30 minutes by default); the docs say the link is a credential and results must not be logged | The Clerk-compatible mode keeps the same tool name, scope name and refusal; **different**: links live at most 5 minutes, an interstitial always, and the session has the grant's permissions with a fresh login for account security (Clerk's default is reads only). The strong mode differs more: the client calls a hidden tool, with a required `challenge`, 60 seconds |
| Auth0 session transfer tokens | A native app exchanges its refresh token for a single-use, short-lived token that a web view presents to get a web session | SES-2 |
| OpenID Connect Native SSO | A device secret plus token exchange gives a second app a session without a second sign-in | SES-11 |
| Ping Identity, «Hardening the handoff» (as reported; not re-read) | Names the pattern «session transfer» and warns against ad-hoc designs | SES-2 to SES-4 |
| WorkOS, «Logging AI agents into web apps» (as reported; not re-read) | Tokens are grants, not cloned sessions | §1, SES-6 |

## 7. Security

The profile puts a session of the person into a browser context the client holds. That is its purpose and its
risk. What bounds it in the strong mode: a scope granted by name (SES-1); a code that is useless without a verifier that never leaves
the client and its context (SES-2, SES-3); an interstitial wherever a bare link could work (SES-4); no switching
of accounts (SES-5); a session that can do no more than the grant and nothing to the account itself (SES-6); the
person's device only (SES-7); revocation.

Residual, said openly: the app cannot verify that a client does not read the cookie of its own web view or drive
the page it opened (SES-9). A hostile client can therefore do, through the pages, what its grant already allows
through tools, and no more: that is why SES-6 caps the session at the grant. A client that breaks SES-9 is ended
by revoking the grant. The Clerk-compatible mode adds the risk of a stolen link, stated in §4.

## 8. Checks

1. Strong mode: a call without `challenge` is refused; a `POST` to `url` without its verifier creates no session.
2. A code works once, within its lifetime, only with its verifier and its target.
3. A `GET` on the link shows the interstitial and creates no session before «Continue»; opened on another device
   it shows whose session it would be.
4. It never replaces another person's session; the same person's session is kept.
5. A redeem `POST` initiated by another website is refused.
6. A transferred session with only `web.read` cannot change data; with any scopes it cannot change credentials,
   keys, exports, webhooks, invitations or permissions, nor confirm a call.
7. Revoking the grant, or the mode's scope, ends the transferred sessions at once.
8. Strong mode: the tool is absent from what a model is given; no token appears in any URL, cookie or page.
9. Clerk-compatible mode: absent unless the app offers it; refused without `browser_session`; a link works once,
   for at most 5 minutes, only through the interstitial; the session cannot change the password, multi-factor
   settings or API keys, export the account or invite, and every issue and redeem is logged.

## 9. Open points

1. SES-3's check of who initiated the redeem relies on fetch metadata headers and needs an outside security
   review.
2. How a client publishes its web frame origins: this draft assumes the origins of its Client ID Metadata
   Document; a dedicated member may be needed.
3. `_meta.ui.visibility` comes from MCP Apps; hosts without MCP Apps have no standard way to hide a tool from the
   model. SES-2 makes that harmless, but a core marker would be better.
4. Phone system browser sheets cannot `POST` and may share cookies with the system browser: there the interstitial
   is the only defence, and the session lands in the person's main browser.

References: MCP authorization; RFC 6749, 7636, 8252, 8693, 9449; OpenID Connect Native SSO 1.0; Auth0 session
transfer tokens; Clerk (https://clerk.com/docs/nextjs/guides/ai/mcp/browser-sessions); Ping Identity
(https://prod-developer.pingidentity.com/blog/hardening-the-handoff-a-pattern-for-app-to-web-single-sign-on/);
WorkOS (https://workos.com/blog/logging-ai-agents-into-web-apps).
