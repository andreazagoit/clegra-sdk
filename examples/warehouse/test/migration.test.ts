// 004_tenants.sql on a database that already has data (the local PGlite, a deployed demo): migrated from 003 with
// rows in every table, nothing is lost, organizations become tenants, person ids stay, and a host's person can write.
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"

import { getMigrations } from "better-auth/db/migration"

process.env.PGLITE_DIR = "memory://"
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url")
delete process.env.CLEGRA_PUBLIC_URL

const { closeDb, getDb, sql } = await import("../lib/db")
const { createAuth } = await import("../lib/auth")
const { migrate } = await import("../lib/migrate")

const MIGRATIONS = join(import.meta.dirname, "..", "db", "migrations")

after(async () => {
  await closeDb()
})

test("004 keeps the existing rows, makes every organization a tenant and frees the person columns", async () => {
  // The database as it was before 004: better-auth's tables, then 001–003, journaled as lib/migrate.ts does.
  const db = await getDb()
  const auth = createAuth(db.pool, { validateSchema: false })
  await auth.$context
  await (await getMigrations(auth.options)).runMigrations()
  await sql(`CREATE TABLE schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < "004").sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, name), "utf8"))
    await sql(`INSERT INTO schema_migration (name) VALUES ($1)`, [name])
  }
  await sql(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('u1', 'Test Admin', 'admin@example.test', true, now(), now())`)
  await sql(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('o1', 'Test Shop', 'test-shop', now())`)
  await sql(`INSERT INTO product (id, organization_id, sku, name, category, unit, sale_price, purchase_cost, reorder_level) VALUES ('p1', 'o1', 'T-1', 'Test screws', 'fasteners', 'box', 5, 2, 1)`)
  await sql(`INSERT INTO sales_order (id, organization_id, number, customer_name, status, created_by, confirmed_by, confirmed_at) VALUES ('s1', 'o1', 'SO-2026-0001', 'Test customer', 'confirmed', 'u1', 'u1', now())`)
  await sql(`INSERT INTO sales_order_line (order_id, line_no, product_id, quantity, unit_price) VALUES ('s1', 1, 'p1', 2, 5)`)
  await sql(`INSERT INTO stock_movement (id, organization_id, product_id, kind, quantity, user_id) VALUES ('m1', 'o1', 'p1', 'in', 10, 'u1'), ('m2', 'o1', 'p1', 'out', 2, 'u1')`)

  assert.deepEqual(await migrate(), ["004_tenants.sql", "005_clegra_store.sql", "006_clegra_lifecycle.sql"])
  // 005: the store table under the package's name, its index too.
  assert.deepEqual(await sql(`SELECT to_regclass('clegra_store')::text AS t, to_regclass('clegra_store_expires_at')::text AS i`), [{ t: "clegra_store", i: "clegra_store_expires_at" }])

  assert.deepEqual(await sql(`SELECT id, kind, organization_id FROM tenant`), [{ id: "o1", kind: "organization", organization_id: "o1" }])
  assert.deepEqual(await sql(`SELECT tenant_id, stock, stock_status FROM product_stock`), [{ tenant_id: "o1", stock: 8, stock_status: "ok" }])
  assert.deepEqual(await sql(`SELECT tenant_id, total, line_count, created_by, confirmed_by FROM sales_order_total`), [{ tenant_id: "o1", total: "10.00", line_count: 1, created_by: "u1", confirmed_by: "u1" }])
  assert.deepEqual(await sql(`SELECT id, person_id FROM stock_movement ORDER BY id`), [{ id: "m1", person_id: "u1" }, { id: "m2", person_id: "u1" }])

  // A workspace installation holds data; its person is not a better-auth user.
  await sql(`INSERT INTO tenant (id, kind) VALUES ('shop@https://node.test', 'workspace')`)
  await sql(`INSERT INTO product (id, tenant_id, sku, name, category, unit, sale_price, purchase_cost) VALUES ('p2', 'shop@https://node.test', 'T-1', 'Test screws', 'fasteners', 'box', 5, 2)`)
  await sql(`INSERT INTO stock_movement (id, tenant_id, product_id, kind, quantity, person_id) VALUES ('m3', 'shop@https://node.test', 'p2', 'in', 1, 'host-person-1')`)
  // Neither kind can pretend to be the other, and data needs a tenant.
  await assert.rejects(sql(`INSERT INTO tenant (id, kind) VALUES ('o2', 'workspace')`), /check/i)
  await assert.rejects(sql(`INSERT INTO tenant (id, kind, organization_id) VALUES ('x@y', 'organization', 'o1')`), /check|unique/i)
  await assert.rejects(sql(`INSERT INTO product (id, tenant_id, sku, name, category, unit, sale_price, purchase_cost) VALUES ('p3', 'nobody', 'T-1', 'X', 'tools', 'pcs', 1, 1)`), /foreign key/i)

  // A product on an order line stays; deleting the organization deletes all its data, through its tenant.
  await assert.rejects(sql(`DELETE FROM product WHERE id = 'p1'`), /foreign key/i)
  await sql(`DELETE FROM "organization" WHERE id = 'o1'`)
  assert.deepEqual(await sql(`SELECT tenant_id FROM product ORDER BY id`), [{ tenant_id: "shop@https://node.test" }])
  assert.deepEqual(await migrate(), [], "applied once")
})
