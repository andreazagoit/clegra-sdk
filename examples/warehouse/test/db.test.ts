import assert from "node:assert/strict"
import { test } from "node:test"

test("production without DATABASE_URL is a clear error, never PGlite", async () => {
  const env = process.env as Record<string, string | undefined>
  env.NODE_ENV = "production"
  delete env.DATABASE_URL
  const { getDb } = await import("../lib/db")
  await assert.rejects(getDb(), /DATABASE_URL is not set/)
})

test("production without MODELAPP_PUBLIC_URL is a clear error", async () => {
  const env = process.env as Record<string, string | undefined>
  env.NODE_ENV = "production"
  delete env.MODELAPP_PUBLIC_URL
  const { publicUrl } = await import("../lib/site")
  assert.throws(() => publicUrl(), /MODELAPP_PUBLIC_URL is not set/)
  env.MODELAPP_PUBLIC_URL = "https://warehouse.example.com/app"
  assert.throws(() => publicUrl(), /origin only/)
})
