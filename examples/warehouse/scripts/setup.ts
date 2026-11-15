// npm run setup — writes .env.local with generated secrets (only what is missing), then migrates and seeds.
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

const file = ".env.local"
const current = existsSync(file) ? readFileSync(file, "utf8") : ""
const has = (key: string) => new RegExp(`^${key}=.+`, "m").test(current)
const add: string[] = []
if (!has("BETTER_AUTH_SECRET")) add.push(`BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}`)
if (!has("DEMO_PASSWORD")) add.push(`DEMO_PASSWORD=${randomBytes(12).toString("base64url")}`)
if (!/^BETTER_AUTH_URL=/m.test(current)) add.push("BETTER_AUTH_URL=http://localhost:3930")
if (!/^DEMO_SIGNIN=/m.test(current)) add.push("DEMO_SIGNIN=1")
if (add.length) {
  writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`, { mode: 0o600 })
  console.log(`${file}: added ${add.map((l) => l.split("=")[0]).join(", ")}`)
} else console.log(`${file}: complete`)

for (const script of ["db:migrate", "db:seed"]) execFileSync("npm", ["run", "--silent", script], { stdio: "inherit" })
console.log("\nReady: npm run dev, then open http://localhost:3930 (the demo password is DEMO_PASSWORD in .env.local).")
