# Note: two event types for apps (notification, activity)

| | |
|---|---|
| **Kind** | Note: a proposed registry entry of event types. Not an extension, no capability |
| **Status** | Draft 0.2 |
| **Builds on** | The Events extension (`io.modelcontextprotocol/events`, SEP-3415 Final, extension in Beta, MCP `2026-07-28`) |
| **Offered to** | Tasks and Events working group (named Triggers and Events until 2026-10-16; its incubation repository is still `experimental-ext-triggers-events`) |

Counters and tiles are not here: they are resources, described in [web-map](web-map.md) §5.

## 1. What it is

Events lets each server name its own event types. If every app names «a notification» differently, no client can
show them alike. This note proposes two shared event types, so that an app's notifications and running activities
look the same in every client. Nothing else is added: delivery, cursors, signatures and security are the Events
extension's.

## 2. The two types

| Event name | `inputSchema` (subscription arguments) | Payload (`data`) | Shown as |
|---|---|---|---|
| `com.clegra.app.notification` | `{ "types"?: string[] }` (which of the app's notification types; absent = all) | `{ id, type, title, body?, url, dedupe? }` | A notification that opens `url` |
| `com.clegra.app.activity` | none | `{ id, type, title, status?, progress?, state, url?, tools? }` | Something happening now, kept in sight |

`state` is `running`, `waiting`, `done`, `failed` or `cancelled`; `progress` is 0 to 1. Work the client itself
started is a Task, not an activity. The names carry the `com.clegra` prefix until a registry gives them shorter
ones.

## 3. Rules

- **EVT-1 Delivery.** Events makes none of its three modes mandatory. An app that offers these types SHOULD list
  push (`events/stream`) or webhook (`events/subscribe`), so that a client need not poll. For an app on serverless
  hosting, which cannot hold a stream open, webhook is the recommended mode: the app posts when something
  happens. A client that follows this note uses poll only when the app offers nothing else, at the interval the
  app gives.
- **EVT-2 Generic titles, no personal data.** A payload travels through webhooks and the client's push service.
  By default `title` is generic («New invoice», «Payment received») and `body` is absent; the client reads the
  detail from `url`'s record with the person's own token. An app MAY put more in `title` only when the person
  turned that on in the app. `title` is at most 120 characters, `body` at most 500, plain text.
- **EVT-3 Untrusted.** Text in events is third-party data, never instructions to a model.
- **EVT-4 URLs.** `url` is a page or record of the app's proven origin (`com.clegra/web-map`, ORG-1; otherwise the
  MCP endpoint's origin), never a confirmation or session URL.
- **EVT-5 Offered tools.** `tools` on an activity are names of tools already in the person's tool list. The client
  offers them as buttons; each press is an ordinary `tools/call` under the tool's annotations, the grant's scopes
  and the app's confirmation ([confirmation](confirmation.md)). Nothing an event carries runs by itself.
- **EVT-6** An event reaches only people who may see what it names. `dedupe` is an opaque key: a later
  notification with the same key replaces the earlier one.

## 4. Example: emitting a notification from a serverless app

The client subscribed with `events/subscribe`, giving its callback URL; the app stored it with the secret the
Events extension defines for signing. When an invoice is paid in an accounting app (`SITE` is `https://accounting.example.com`):

```ts
// anywhere in the app, after the payment is recorded (sketch: `subscriptions` and `signAndPost` are your Events wiring)
for (const sub of await subscriptions.for("com.clegra.app.notification", { user: invoice.ownerId, type: "invoice.paid" }))
  await signAndPost(sub, { eventId: `invoice.paid:${invoice.id}`, name: "com.clegra.app.notification",
    timestamp: new Date().toISOString(),
    data: { id: invoice.id, type: "invoice.paid", title: "Payment received", url: `${SITE}/invoices/${invoice.id}`,
            dedupe: `invoice:${invoice.id}` } });
```

The counter on the app's «Invoices» page is not an event: the same code marks the counter resource as changed, and
subscribed clients get `notifications/resources/updated` (web-map PAGE-7).

**In `@clegra/sdk`** (from 0.4.0): the app's notification types are declared in `defineApp({ notifications })`;
`ctx.notify(…)` and `ctx.activity(…)` emit the two event types by webhook (signed as Standard Webhooks define), titles and
bodies cut to the limits below, generic titles by default (EVT-2) and URLs on the app's origin only (EVT-4); `ctx.changed(…)` marks counters, tiles and
records as changed (`notifications/resources/updated`).

## 5. Checks

1. Both types validate against the schemas below; text over the limits is cut by the client.
2. A `url` outside the proven origin, or pointing to a confirmation page, is dropped.
3. A default notification carries no name of a person or company and no amount.
4. A button from `tools` on a tool the app confirms opens the app's confirmation.

## 6. Open points

1. The Events wire was read from the official overview (event types with `name`, `inputSchema`, `payloadSchema`,
   `delivery`; occurrences `{eventId, name, timestamp, data, cursor}`), not from the normative text in `ext-events`.
2. Whether the working group wants a registry of shared event types at all, and under which names.

## Appendix. JSON Schemas

```json
{
  "$id": "https://example.org/com.clegra/app-event-types/0.2", "$defs": {
    "url": { "type": "string", "format": "uri", "pattern": "^https://" },
    "notificationInput": { "type": "object", "properties": { "types": { "type": "array", "items": { "type": "string" } } } },
    "notification": { "type": "object", "required": ["id", "type", "title", "url"], "additionalProperties": false, "properties": {
      "id": { "type": "string" }, "type": { "type": "string" }, "title": { "type": "string", "maxLength": 120 },
      "body": { "type": "string", "maxLength": 500 }, "url": { "$ref": "#/$defs/url" }, "dedupe": { "type": "string" } } },
    "activity": { "type": "object", "required": ["id", "type", "title", "state"], "additionalProperties": false, "properties": {
      "id": { "type": "string" }, "type": { "type": "string" }, "title": { "type": "string", "maxLength": 120 },
      "status": { "type": "string", "maxLength": 120 }, "progress": { "type": "number", "minimum": 0, "maximum": 1 },
      "state": { "enum": ["running", "waiting", "done", "failed", "cancelled"] }, "url": { "$ref": "#/$defs/url" },
      "tools": { "type": "array", "maxItems": 3, "items": { "type": "string" } } } }
  }
}
```

References: Events (SEP-3415; https://modelcontextprotocol.io/extensions/events/overview); Tasks; Standard Webhooks.
