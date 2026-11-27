# Guide: confirmation the app itself verifies

| | |
|---|---|
| **Kind** | Guide (best practice). No identifier, no capability, nothing new on the wire |
| **Status** | Draft 0.2 |
| **Builds on** | URL-mode elicitation (SEP-1036, Final) inside multi round-trip requests (SEP-2322, Final), MCP `2026-07-28`; core tool annotations; Tasks when present |
| **Vocabulary** | Error codes and scopes it uses are in [access](access.md) |
| **Offered to** | The Authorization interest group, as a contribution to «Asynchronous Approval for Tool Calls» (SEP-2848: an open draft pull request without a sponsor, not on the SEP index) |

Rules for the **app** use MUST: its security rests on them alone. Rules for the **client** use SHOULD: they make
the experience good, and nothing breaks if a client ignores them, because the app never trusts the client (CNF-1,
CNF-5). Terms and the rest of the family: [the index](README.md).

## 1. What it is

For a tool that sends, pays, shares or deletes, the **app** should hold proof that the person approved **that exact
call**, and not take the client's word, a model's, or an automation's. MCP already has the mechanism: the tool
answers with a URL-mode elicitation to a page of the app. This guide says how to use it so the proof is real.

**Open point for the Authorization interest group, stated first.** Core says URL mode is for sensitive information
and third-party authorization, and that servers «MUST NOT rely on URL mode elicitation to authorize users for
themselves». This guide reads that as «not for granting the client access», and uses URL mode for something else:
the person's approval of one call the token already allows, in the manner of the payment flow core itself gives as
an example. That reading is defensible but it is not the text, and it needs the group's answer before anything
here is proposed as more than practice.

## 2. Which tools

- **ACT-1 Annotations stay the core's.** `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`
  are set truthfully, as core defines them, whether or not the tool is confirmed. Sending a message or sharing a
  file is additive and reaches outside: `destructiveHint: false`, `openWorldHint: true`. Deleting for good is
  `destructiveHint: true`. «Needs the person» is not an annotation today.
- **ACT-2 What the app confirms.** A tool whose result the app cannot put back: one that makes data visible to
  someone who could not see it (send, share, invite, publish, export, change permissions, set a forward or a
  webhook), moves money, deletes for good, or changes recipients or payment details. An app MAY confirm more.
- **ACT-3 How a client learns it.** From the `input_required` answer, when it calls. If «Tool Risk Metadata»
  (SEP-2793, an open draft pull request) is accepted, `reversibility: "none"` will say it in advance.
- **ACT-4** A tool callable without authorization is never one of these: it is read-only, or a rate-limited change
  that touches no person's data.

## 3. The flow

1. The client calls the tool (here an accounting app, asked to send an invoice). The app answers:

```json
{
  "resultType": "input_required",
  "inputRequests": { "confirm": { "method": "elicitation/create", "params": {
    "mode": "url", "url": "https://accounting.example.com/confirm/9fQ2mX7cJt0aVb3LwK8eRg",
    "message": "Send invoice 2026/0142 to Harbor Supplies Ltd (€ 1,240.00)? The customer will receive it by e-invoice." } } },
  "requestState": "<opaque, authenticated>"
}
```

2. The person opens the URL in their own browser, sees the app's own summary and presses the app's button.
3. The client retries the same call with `inputResponses: { "confirm": { "action": "accept" } }` and the same
   `requestState`; the tool runs and returns its result.

## 4. The app

- **CNF-1** The tool MUST NOT run without a confirmation the app recorded on its own page. `action: "accept"`
  proves nothing: it only says the person agreed to open the page.
- **CNF-2 Exact call.** The binding follows the core `requestState` rules (opaque to the client,
  integrity-protected, bound to principal and expiry, digest of method and arguments). The app adds `client_id` to
  the SHA-256 digest (canonical JSON, RFC 8785) and enforces single use itself. The identifier in the URL has at
  least 128 random bits and grants nothing without the subject's session.
- **CNF-3 What the person approves.** The app writes `message` and the page's summary from its own data. The page
  MUST show every argument that changes what happens and make all arguments viewable.
- **CNF-4 Not stale.** The confirmation is bound to the resolved values shown (recipient, amount) or the record's
  version. If they differ when the tool runs, the app refuses with `confirmation_stale`.
- **CNF-5 The page.** It MUST check that the signed-in person is the token's subject, in a session born from the
  person's credentials (never a transferred one, [session transfer](session-transfer.md)); send
  `Content-Security-Policy: frame-ancestors 'none'`; resist request forgery; show the client (host of `client_id`,
  redirect target, a warning for loopback or custom-scheme redirects), the start time, and «Not you? Decline and
  revoke», which revokes the grant. The app SHOULD ask for fresh authentication above a threshold of its own.
- **CNF-6 Single use, short, once.** One confirmation runs one call once and expires at most 5 minutes after it was
  issued. A repeat of the confirmed request (same `requestState`) returns the first result, so a lost response
  never sends twice. Declining or expiry ends the call with `confirmation_declined` or `confirmation_expired`.
- **CNF-7 Waiting.** On the retry the app SHOULD hold the request open until the person confirms, declines or the
  confirmation expires, so that no client needs to poll.
- **CNF-8 Clients without URL elicitation** (or on older revisions). The app MUST NOT send an input request the
  client did not declare. It answers with a tool error (`isError: true`,
  `structuredContent.error: { "code": "confirmation_required", "url", "expiresAt" }`) and a `resource_link` to the
  confirmation page. The person opens the link and confirms; the **same call** repeated by the same subject and
  client with the same arguments then runs, once. An app that will not offer this answers the core error `-32021`
  with `data.requiredCapabilities: { "elicitation": { "url": {} } }`.
- **CNF-9 Nobody present.** When both peers declare Tasks, the app MAY return `resultType: "task"`; the task waits
  for input until the person confirms. The pending request expires when the app decides (at most 7 days) and is
  listed on the app's «Pending requests» page, which the person reaches by themselves, never by a link in a
  message. The confirmation starts when they open it there, under CNF-2 to CNF-6. Revoking the grant cancels all
  pending requests. This is the case SEP-2848 addresses; what this guide would add to it is who approves: the
  person, on the app's page.
- **CNF-10 No surface goes around it.** A call that starts from an MCP Apps view, an A2UI surface, a tile, a
  share or plugin entry ([app-share](app-share.md)), an agent or a schedule is the same `tools/call` and is confirmed the same way. On a page opened in a
  browser, ACT-2 tools are not offered through WebMCP at all: a click there does not prove a person, since an
  agent that drives the page produces the same click. An app that wants them there confirms with a check of
  presence (WebAuthn with user verification, or fresh authentication).

## In `@clegra/sdk`

From 0.4.0, a tool with `confirm` (required for the ACT-2 kinds) is never run by the SDK before the person confirmed on
the app's own page: `serve` answers with the URL-mode elicitation where the client declared it, else with the
`confirmation_required` fallback (CNF-8); it binds the confirmation to the subject, the `client_id`, the tool and the
digest of its arguments (CNF-2), keeps it single use with the first result for a repeat (CNF-6), refuses a stale one
(CNF-4) and serves the confirmation page (`frame-ancestors 'none'`, the client and start time shown, «Not you?
Decline and revoke»), which accepts only a session born from the person's credentials (CNF-5). The summary is the
tool's own `confirm` text, from the app's data (CNF-3).

## 5. The client

Good behaviour, not a condition of safety:

- It SHOULD follow the core URL-mode rules (full URL shown, explicit consent, no pre-fetch), highlight the host,
  and open the URL in the system browser as a top-level navigation, not in a web view it controls.
- It SHOULD refuse a URL whose origin is neither the MCP endpoint's nor one proven under `com.clegra/web-map`.
- It SHOULD show `message` as the app wrote it, not a model's paraphrase.
- If the app answers `input_required` again with the same `url`, it SHOULD NOT reopen it or retry on a timer: it
  shows «waiting for confirmation» with retry and cancel, and retries when the person comes back.
- Its own approval rules (automatic, ask, never) are in addition to the app's confirmation, never in place of it.

## 6. Security

Prompt injection that asks a model to send, share, pay or delete stops here: the person sees the exact call on the
app's page. A stolen token cannot confirm (CNF-5 needs the person's own session); a link sent to a victim shows
the client and the start time and offers to revoke; a client that opens the page in its own web view still cannot
confirm, because the session there is not one born from credentials; a changed record voids the approval (CNF-4).
Limits, said openly: a change within the grant that needs no confirmation can still be triggered by injected
text; and a person can be talked into pressing the button, which is why the summary is the app's own.

## 7. Checks

1. No run on `accept` alone; no run with changed arguments, another client or another subject.
2. One run per confirmation; a repeat returns the first result; decline, expiry and a changed record give their
   errors.
3. The page refuses framing, a session of another person and a transferred session.
4. **Fallback**: a client without URL elicitation gets `confirmation_required` and a link, and the repeated call
   runs once after confirming. To be run against the assistants in the official extensions client matrix.
5. Tools of the ACT-2 kinds ask for confirmation; their annotations are truthful; an unauthenticated `tools/list`
   shows none of them; none is registered through WebMCP.

## 8. Open points

1. The reading of URL mode in §1.
2. Which assistants implement URL-mode elicitation today (check 4; see the table in [the index](README.md)).
3. The Tasks state used in CNF-9 is not verified on the normative text.
4. MCP has no idempotency key: CNF-6 covers confirmed calls through `requestState`; ordinary changes have only
   `idempotentHint`. Worth raising on its own.
5. Left out: deferred confirmation (approve now, run at a set time) and a device-signed one-tap confirmation.

References: MCP 2026-07-28 (tools and annotations, elicitation, multi round-trip requests); SEP-1036, SEP-2322
(Final); open draft pull requests SEP-2848 and SEP-2793
(https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2848, …/pull/2793); Tasks (SEP-2663); RFC 8785;
WebAuthn.
