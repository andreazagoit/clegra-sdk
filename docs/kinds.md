# Kinds: what they are for, third parties' kinds, and how a kind enters the standard

Normative text: [spec.md](spec.md) §3.1 (kinds), §3.2 (references across apps), §9 (workspace hosts). This page is
for app developers deciding whether to declare a kind, and for anyone who needs a kind the standard doesn't have.

## When a kind pays off — and when it doesn't

A kind says what an entity *is*, the same in every app: `person`, `organization`, `event`, `task`, `document`,
`product`, `order`. A workspace host that holds several apps uses it to

- draw one picker over every app that has organizations (an action input `ref: { kind: "organization" }`);
- show a reference stored in one app (`clegra://erp/customer/42`) with the owning app's live title, for each viewer;
- list people, companies, events and tasks of every app on one page, each row with its source;
- find the same customer in two apps by an equal **key** (`vatID`, `email`, `gtin`, `uid`) — never by name;
- give an assistant one tool (`find_records`) instead of N list tools.

It adds nothing when a workspace has one app per kind, for an app's own records (a deal, a ticket, a quote line:
declare no kind, don't invent one), or for aggregation across apps (not possible live; not a goal). A wrong `as`
(`as: "email"` on a notes field) is worse than none: it makes false matches. Mark only what *is* the property.

## A third party's kind

When your records are a thing the standard doesn't define (a shipment, a vehicle, a course), name it under a domain
you control, reverse-DNS, lowercase: `com.acme.shipment`. Define it in the manifest's `kinds` so hosts know its
properties and keys:

```ts
defineApp({
  name: "logistics",
  kinds: {
    "com.acme.shipment": {
      label: { en: "Shipment", it: "Spedizione" },
      properties: { tracking: { type: "string", key: true }, deliveredAt: { type: "date" } },
    },
  },
  entities: {
    shipment: { kind: "com.acme.shipment", schema: shipmentSchema, get, list },
  },
})
```

- Hosts match a dotted kind by its **exact name**: two apps using `com.acme.shipment` are sources of the same kind;
  `com.acme.shipments` is another kind.
- A key of a third party's kind is compared exactly, as it is (no normalisation), and must be a list filter.
- An entity whose dotted kind the manifest doesn't define may mark only the universal properties (`url`,
  `dateCreated`, `dateModified`).
- A host that doesn't know a kind (an unprefixed name that isn't standard, or a reserved one: `message`, `place`,
  `invoice`, `project`) treats the entity as one without a kind. Nothing breaks.
- The first definition a host reads labels the kind; if apps disagree on a property's type, each app's own
  definition still governs its fields (`kinds.properties` checks each manifest alone).

## How a kind enters the standard (the promotion rule)

The standard's vocabulary is small on purpose (proposal «Vocabulary creep»). A namespaced kind becomes a standard,
unprefixed kind only when **all** of these hold:

1. **Two independent apps** — different publishers, not one company's two products — use the same dotted kind with
   compatible properties, in production.
2. **A host behaviour uses it**: a picker, a kind page, a key match or an assistant tool that a workspace host actually
   ships for it. A kind nobody draws together is just a label.
3. **Keys are defined precisely**: which property identifies a record, and its normalised form (as `vatID` upper-cased
   without spaces). A property whose identifying form isn't settled stays a property, not a key (this is why
   `taxID` is a property and not a key in 1.0).
4. **Names come from schema.org** (verbatim), or JSCalendar/JSContact where schema.org has none.

Promotion is additive: within one `specVersion` kinds and properties are only added, never renamed or removed. The
promoted kind gets an unprefixed name in `kinds.json` for the next spec version; apps keep their dotted kind until
they move, and hosts treat the two as different kinds until then (no aliases).

## Clegra as a host (what it does today)

- **Names**: an app's `name` is unique in a workspace; when it's taken the administrator gives it another at install,
  and Clegra translates record URIs between the workspace name and the app's own on every call (spec §9.1). The name
  can't change after install: other apps keep URIs that carry it.
- **Fan-out**: every source of a kind is asked in parallel with the viewer's own token, 3 seconds each, one event per
  source; every source is named with its state (`ok`, `timeout`, `error`, `no-access`, `not-linked`); the list is
  partial unless all are ok; merged order only by a property every source sorts by.
- **References**: resolved by the owning app for each viewer: a title, or `no-access`, `gone`, `unreachable`,
  `unknown-app` — never a remembered title.
- **«Also in»** on a record page: records of other apps with an equal key, side by side, worded as a shared key; a
  person may state «same» / «not the same» (stored as two URIs, who and when, shown only when both resolve for the viewer).
- **The workspace's own people** are a `person` source like any app.
