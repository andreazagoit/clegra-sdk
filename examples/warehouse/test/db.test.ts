import assert from "node:assert/strict"
import { test } from "node:test"

test("production without DATABASE_URL is a clear error, never PGlite", async () => {
  const env = process.env as Record<string, string | undefined>
  env.NODE_ENV = "production"
  delete env.DATABASE_URL
  const { getDb } = await import("../lib/db")
  await assert.rejects(getDb(), /DATABASE_URL is not set/)
})
