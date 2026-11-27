# App share: sharing between apps, and targeted plugins

| | |
|---|---|
| **Kind** | Extension. Identifier `com.clegra/app-share` (reverse-DNS prefix of `@clegra/sdk`) |
| **Status** | Draft 0.1, Experimental. `revision: "0.1"` |
| **Requires** | MCP `2026-07-28` (where `capabilities.extensions` exists) |
| **Uses, when present** | `com.clegra/web-map` (record types, record URLs, record pages, origin proof ORG-1); the confirmation guide |
| **Starts from** | W3C Web Share Target and the share sheets of operating systems (a receiver declares what it accepts); schema.org types and property names; IANA media types |
| **Offered to** | No group exists. Only after it runs in Clegra's own apps ([the index](README.md), «Process») |

MUST, SHOULD and MAY as in RFC 2119. «Host» is the client that holds the person's apps side by side (a workspace),
«receiver» the app whose tool is called, «source» the app or built-in part whose record is shared. Terms and the
family: [the index](README.md).

## 1. What it is

Two ways for one app to act on what another app holds, with the same rules:

- **A. Share (the base).** Like a share sheet: a receiver declares what it **accepts**, from a small set of standard
  content types (text, link, file, message, contact, event, document, record reference), and what it does with it:
  its own tool, a title, an icon, and which standard fields go to which tool inputs. Any record or page in the host,
  the host's own Mail included, can be shared as one of those types; the host offers every connected app that
  accepts that type. No app needs to know the others.
- **B. Targeted plugins (deep integrations).** A receiver names one other app, by its MCP server URL, or one built-in
  part of the host (Mail, Calendar) by a well-known id, and adds its action to that app's records with exact fields
  of that app's records.

Example: an ERP (with its own MCP server and its own OAuth) **accepts** a message, text, a file or a
contact and offers «Crea preventivo» («Create quote») for each: from a mail, a note or a business card the person
starts a quote. It also declares a **plugin** for a job-requests app: on a job record, «Crea preventivo» passes the
job's customer and its materials with their quantities, so the quote starts with its lines filled.

Apps never call each other: the host reads the shared content as the person, shows what passes, and on the
person's click calls the receiver's tool with the receiver's own token. Outside a host that supports this
extension the declarations are ignored and the tools stay ordinary tools.

## 2. Negotiation and wire

Server in `server/discover`, client in `_meta["io.modelcontextprotocol/clientCapabilities"]` of each request:
`"extensions": { "com.clegra/app-share": { "revision": "0.1" } }`. Declarations sit in `_meta` of tools and record
templates, so they are read with `tools/list` and `resources/templates/list` as the signed-in person.

**A receiver accepts a type** (part A), on the tool it calls:

```json
{ "name": "quote.create", "title": "Create quote",
  "inputSchema": { "type": "object", "additionalProperties": false, "properties": {
    "subject": { "type": "string" }, "notes": { "type": "string" },
    "customer_email": { "type": "string", "format": "email" }, "customer_vat": { "type": "string" },
    "customer_name": { "type": "string" }, "attachment": { "type": "object" }, "source_url": { "type": "string" },
    "lines": { "type": "array", "items": { "type": "object", "required": ["code", "quantity"], "additionalProperties": false,
      "properties": { "code": { "type": "string" }, "quantity": { "type": "number" }, "description": { "type": "string" } } } } } },
  "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false },
  "_meta": { "com.clegra/app-share": { "accepts": [
    { "type": "message", "title": "Create quote", "map": { "subject": "headline", "notes": "text",
      "customer_email": "sender.email", "customer_name": "sender.name", "source_url": "url" } },
    { "type": "text", "title": "Create quote", "map": { "notes": "text" } },
    { "type": "file", "mimeTypes": ["application/pdf", "image/*"], "title": "Create quote from file",
      "map": { "attachment": "file" } },
    { "type": "contact", "title": "Create quote for this customer",
      "map": { "customer_name": "name", "customer_email": "email", "customer_vat": "vatID" } } ] } } }
```

**A source says what its records can be shared as** (part A), on the record template. Every record is also
shareable as `record` and `link` without saying so; a page as `link`.

```json
{ "uriTemplate": "https://jobs.example.com/jobs/{id}", "name": "job", "title": "Job",
  "_meta": { "com.clegra/app-share": { "shareAs": [
    { "type": "contact", "fields": { "name": "/customer/name", "vatID": "/customer/vat_id", "email": "/customer/email" } },
    { "type": "text", "fields": { "text": "/description" } } ] } } }
```

**A receiver declares a targeted plugin** (part B), on the tool it calls:

```json
{ "_meta": { "com.clegra/app-share": { "plugins": [
  { "target": { "url": "https://jobs.example.com/mcp" }, "recordType": "job", "title": "Create quote",
    "icon": "https://erp.example.com/icons/quote.svg",
    "map": { "customer_vat": "/customer/vat_id", "customer_name": "/customer/name", "subject": "/title",
             "notes": "/description", "lines": "/materials" }, "urlArg": "source_url" },
  { "target": { "builtin": "mail" }, "recordType": "message", "title": "Create quote",
    "map": { "subject": "/headline", "notes": "/text", "customer_email": "/sender/email" }, "urlArg": "source_url" } ] } } }
```

| Member | Meaning |
|---|---|
| `accepts[].type` | A standard content type (§4). `mimeTypes` narrows `file` (and `document`) by media type; wildcards as `image/*`. |
| `accepts[].map` | Tool input (key) ← standard field of the type (value, a dotted path into §4's fields). |
| `shareAs[].fields` | Standard field (key) ← JSON Pointer (RFC 6901) into the source record (value). |
| `plugins[].target` | `{ "url": <the target's MCP endpoint URL> }` or `{ "builtin": <id from §5> }`. |
| `plugins[].recordType` | The target's record type: an `entity` of the target's web-map record templates, or a built-in record type (§5). |
| `plugins[].map` | Tool input (key) ← JSON Pointer into the target's record (value). |
| `urlArg` | Optional: the tool input that receives the shared record's URL. Without it the URL does not pass. |
| `title`, `icon` | The entry's label and icon. `title` is translated by the app (`acceptLanguage`): an Italian person sees «Crea preventivo». |

The tool called is always the tool that carries the declaration.

## 3. Rules, common to share and plugins

- **SHR-1 Only the person's click.** Nothing passes and nothing runs before the person chooses the entry. A host
  MUST NOT run an entry because of an agent, a schedule, an organization's rule or a model's request. A
  declaration is never given to a model as an instruction; an agent that calls the same tool makes an ordinary
  tool call, with arguments it wrote, not a share.
- **SHR-2 Show what passes.** After the click the host reads the source as the person (another app's record with
  that app's own token; a built-in part from the host's own data), applies the mapping and shows: the source (app
  name and origin, or the built-in part), the receiver (app name, icon and origin), the receiver tool's own title,
  and every value that will pass, as the tool's input form, prefilled. The person may change the values, then
  sends or cancels. Only mapped values pass: nothing else of the record, and its URL only through `urlArg`.
- **SHR-3 Closed and validated.** The receiver's tool has a closed `inputSchema` (`additionalProperties: false`),
  else the host ignores its declarations. A map that names an input the schema lacks makes that entry ignored.
  Values are validated against the schema before the call; a mismatch is shown, never coerced. A path that
  resolves to nothing leaves that input empty.
- **SHR-4 The receiver's own rules.** The call is an ordinary `tools/call` with the receiver's token, under its
  annotations, its scopes and its own confirmation ([confirmation](confirmation.md)): a share is never a lower bar.
- **SHR-5 Provenance of text.** Values that come from a source are a third party's. The host passes
  `_meta["com.clegra/app-share"].source: { "origin": "<source origin>" }` (or `{ "builtin": "<id>" }`) on the
  call; the receiver stores the text with that origin and treats it as untrusted wherever an agent later reads it.
- **SHR-6 The person can hide entries.** Each entry, or all of one app's entries, can be hidden by the person, and
  the host remembers it. An organization's administrator may hide entries for everyone, never force one.
- **SHR-7 Identity by proof, never by name.** An app is the MCP endpoint the person connected; its origin is that
  endpoint's, or one proven under web-map ORG-1. A built-in id names only the host's own parts: no connected app
  can claim one.
- **SHR-8 Only between the person's apps.** Sources and receivers are apps the person connected, or the host's
  built-in parts; a receiver appears only when its tool is in the person's `tools/list`. An app is never offered
  its own records.

## 4. Part A: share

- **SHR-10 The host offers every receiver.** When the person shares a record, a page or a selection, the host
  offers each type the content can be shared as and, for each, every connected app that accepts it, with the app's
  name, icon and the entry's title. Which app the person picks is theirs; the host MAY remember it as a default
  per type, shown, and never applied without the click.
- **SHR-11 Shared as.** A record can be shared as the types its template lists in `shareAs`, plus `record` and
  `link`. The host's built-in parts share as in §5. A page shares as `link`. Selected text shares as `text`.
- **SHR-12 Files.** A `file` passes as `{ name, encodingFormat, contentSize, content }` with `content` in base64,
  at most 10 MB, until a files extension of MCP is final (open point). The receiver's `mimeTypes` must match.

Standard content types, with schema.org names for types and fields:

| Type | schema.org | Standard fields |
|---|---|---|
| `text` | Text | `text` |
| `link` | URL | `url`, `name` |
| `file` | MediaObject | `file` (`name`, `encodingFormat`, `contentSize`, `content`) |
| `message` | EmailMessage / Message | `headline`, `text`, `sender` (`name`, `email`), `recipient[]` (`name`, `email`), `dateSent`, `url` |
| `contact` | Person / Organization | `name`, `email`, `telephone`, `vatID`, `address`, `url` |
| `event` | Event | `name`, `startDate`, `endDate`, `location`, `description`, `attendee[]` (`name`, `email`), `url` |
| `document` | DigitalDocument | `name`, `text`, `file`, `url` |
| `record` | Thing (a reference) | `url`, `name`, `recordType`, `origin` |

Values: dates and times ISO 8601; text plain; `email` addresses only; lists JSON arrays. A receiver of `record`
gets a reference and MUST NOT fetch its URL (web-map REC-5): it stores it as a link or asks the person.

## 5. Part B: targeted plugins

- **PLG-1 Both apps.** The host shows a plugin only when the person has both the receiver and the target: the
  target's MCP endpoint URL equals `target.url` (scheme, host, port and path, after normalization), or the target is
  the host's built-in part with that id.
- **PLG-2 In the target's record.** The entry appears in the target's record page or card, labelled with the
  receiver's name and icon besides its `title` (which is untrusted text, never the only label).
- **PLG-3 Known record types.** For a `url` target, `recordType` must be an `entity` of a record template the
  target declares under web-map; the host reads the record with `resources/read` as the person. Otherwise the
  plugin is ignored.
- **PLG-4 Deep, still shown.** A plugin may read any field of the target's record, which is why SHR-2 shows every
  value at each click: a changed map is visible the next time it is used.

Built-in parts, v0 (a host lists those it has):

| Id | Record type | Fields (JSON Pointer) |
|---|---|---|
| `mail` | `message` | `/headline`, `/text`, `/sender/name`, `/sender/email`, `/recipient` (array of `{name, email}`), `/dateSent`, `/attachments` (array of files, §4) |
| `calendar` | `event` | `/name`, `/startDate`, `/endDate`, `/location`, `/description`, `/attendee` (array of `{name, email}`) |

The same built-in records share under part A: a mail as `message` (its attachments as `file`, its sender as
`contact`), a calendar event as `event`.

## 6. A complete example

1. *Share.* The person reads a mail in the host's Mail and presses «Condividi» («Share»). The host lists, for
   `message`, the ERP's «Crea preventivo» and the jobs app's «New job» (it accepts `message` too). The person picks
   the ERP.
2. The host shows: from **Mail**, to **the ERP** (`erp.example.com`), tool «Create quote», with Subject, Notes
   (the mail's text, marked as coming from outside), Customer e-mail and Customer name prefilled. The person
   removes a line from the notes and sends.
3. The host calls `quote.create` on the ERP with the ERP's token and `source: { "builtin": "mail" }`. The ERP
   finds the customer by e-mail (or answers that it has none and offers to create it), drafts the quote and
   returns a `resource_link` to `https://erp.example.com/quotes/1207`.
4. *Plugin.* Later the person opens job 318 of the jobs app (`https://jobs.example.com/jobs/318`) inside the host. Its
   page shows «Crea preventivo» with the ERP's icon. On the click the host reads the job from the jobs app as the
   person and shows: customer VAT and name, subject, notes and three lines (code, quantity, description) from the
   job's materials, and the job's URL as the source. The person sends; the ERP drafts the quote with its lines.
   Nothing was sent to anyone: sending a quote is another tool, which the ERP confirms on its own page.

## 7. Security

The risk is a confused deputy between apps: text written by someone else into a mail or a record ends up in
another app, or a hostile app pulls data out of others. SHR-1 and SHR-2 put the person, shown everything, between
the two, every time; SHR-4 keeps the receiver's confirmation; SHR-5 keeps a source's text from becoming the
receiver's instructions later; SHR-7 stops an app from posing as another app or as Mail; SHR-6 lets the person
remove an entry they do not want; SHR-3 leaves nothing to fetch and nothing coerced.

## 8. Conformance scenarios

1. No entry runs without the person's click, also when an agent or an organization's rule asks (SHR-1).
2. The values shown are exactly the values sent; unmapped fields and the URL without `urlArg` do not pass (SHR-2).
3. An open `inputSchema`, or a map naming a missing input, makes the entry ignored (SHR-3).
4. A receiver tool the app confirms still asks for its confirmation (SHR-4).
5. The receiver gets `source`; a hidden entry stays hidden (SHR-5, SHR-6).
6. A plugin whose `target.url` differs from every connected endpoint, or an app claiming `mail`, shows nothing
   (PLG-1, SHR-7).
7. Sharing a record lists every connected receiver of each of its types and no app for its own records (SHR-8,
   SHR-10).

**In `@clegra/sdk`** (from 0.4.0): a tool's `accepts` and `plugins` and an entity's `shareAs` are written next to the
tool and the entity; `defineApp` checks them (a closed input schema, maps that name existing inputs, known types) and
`serve` puts them in `_meta["com.clegra/app-share"]` and the settings object in `server/discover`. The handler sees
the call's `source` (SHR-5) in its context.

## 9. Later

Not normative. Standard **actions**, beyond content types: a receiver could say «I create quotes» by a
schema.org action type identified by URL (`https://schema.org/CreateAction` on an Offer), so that a host offers
«create a quote in whichever app I use» from a result. Left for after the share and the plugins run.

## 10. Process and open issues

Maintainers, reference implementation and the path to an official repository: [the index](README.md), «Process».

Open: (1) files beyond 10 MB, waiting for MCP's files work; (2) more built-in ids (contacts, files) and who
assigns them; (3) whether `accepts` should allow a small value transform (a list of objects renamed field by
field); (4) how a host remembers a default receiver per type across devices.

## Appendix. JSON Schemas (draft 2020-12; the `$id` is a placeholder)

```json
{
  "$id": "https://example.org/com.clegra/app-share/0.1", "$defs": {
    "type": { "enum": ["text", "link", "file", "message", "contact", "event", "document", "record"] },
    "accept": { "type": "object", "required": ["type", "title", "map"], "properties": {
      "type": { "$ref": "#/$defs/type" }, "mimeTypes": { "type": "array", "items": { "type": "string" } },
      "title": { "type": "string", "maxLength": 80 }, "icon": { "type": "string", "format": "uri" },
      "map": { "type": "object", "additionalProperties": { "type": "string" } } } },
    "shareAs": { "type": "object", "required": ["type", "fields"], "properties": {
      "type": { "$ref": "#/$defs/type" }, "fields": { "type": "object", "additionalProperties": { "type": "string" } } } },
    "plugin": { "type": "object", "required": ["target", "recordType", "title", "map"], "properties": {
      "target": { "oneOf": [
        { "type": "object", "required": ["url"], "additionalProperties": false, "properties": { "url": { "type": "string", "format": "uri", "pattern": "^https://" } } },
        { "type": "object", "required": ["builtin"], "additionalProperties": false, "properties": { "builtin": { "type": "string" } } } ] },
      "recordType": { "type": "string" }, "title": { "type": "string", "maxLength": 80 },
      "icon": { "type": "string", "format": "uri" }, "urlArg": { "type": "string" },
      "map": { "type": "object", "additionalProperties": { "type": "string" } } } },
    "tool": { "type": "object", "properties": {
      "accepts": { "type": "array", "items": { "$ref": "#/$defs/accept" } },
      "plugins": { "type": "array", "items": { "$ref": "#/$defs/plugin" } } } },
    "record": { "type": "object", "properties": { "shareAs": { "type": "array", "items": { "$ref": "#/$defs/shareAs" } } } },
    "request": { "type": "object", "properties": { "source": { "type": "object", "properties": {
      "origin": { "type": "string", "format": "uri" }, "builtin": { "type": "string" } } } } }
  }
}
```

References: W3C Web Share Target; schema.org (types and properties); IANA media types; RFC 6901; MCP tools and
resources.
