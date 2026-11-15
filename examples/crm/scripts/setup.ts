// First run: .env.local with generated secrets (if missing), then the migrations and the demo data.
import { randomBytes } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

const file = new URL("../.env.local", import.meta.url)
if (existsSync(file)) console.log(".env.local is there: kept")
else {
  const secret = randomBytes(32).toString("base64url")
  const password = randomBytes(18).toString("base64url")
  writeFileSync(
    file,
    [
      "# Written by `npm run setup`. Local only: never commit it.",
      `BETTER_AUTH_SECRET=${secret}`,
      "BETTER_AUTH_URL=http://localhost:3920",
      `DEMO_PASSWORD=${password}`,
      "DEMO_SIGNIN=1",
      "",
    ].join("\n"),
    { mode: 0o600 },
  )
  console.log("wrote .env.local (generated BETTER_AUTH_SECRET and DEMO_PASSWORD)")
}

const cwd = new URL("..", import.meta.url)
for (const script of ["scripts/migrate.ts", "scripts/seed.ts"]) execFileSync(process.execPath, ["--import", "tsx", script], { cwd, stdio: "inherit" })
