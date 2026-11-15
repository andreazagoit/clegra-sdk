import { defineConfig } from "drizzle-kit"

// `npm run db:generate` writes a migration from db/schema.ts into drizzle/ (no database needed).
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./drizzle",
})
