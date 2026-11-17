# Changelog

## Unreleased

- Depends on `@clegra/sdk` (the package's scoped name); imports `@clegra/sdk`, `@clegra/sdk/node`,
  `@clegra/sdk/testing`.

## 1.0.0 (2026-11-17)

- First version as a Clegra app (`clegra`): a courier's shipments and pickups on a Node server (`clegra/node`),
  invented data in memory.
- Entities `shipment` (namespaced kind `com.clegra.shipment`, keyed by tracking number) and `pickup` (kind `event`);
  actions `book_pickup` and `cancel_pickup` (always confirmed) and the app-only `check_deliveries`; pages `shipments`
  (badge: late shipments), `pickups`, `overview` and the shipment's record page in sections; navigation in one
  section; the schedule `delivery_check` with the typed notifications `delivered` and `late` to
  `{ permission: "shipments.view" }`; lifecycle export and delete; the agent `logistics`.
- `src/fixture.ts`: an in-process fixture for a workspace host's tests (`createShipmentsApp`, `shipmentsManifest`).
