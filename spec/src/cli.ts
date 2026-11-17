#!/usr/bin/env -S npx tsx
import { checkApp, formatReport } from "./conformance"
import { initMain } from "./init/index"

// clegra check <url> [--token <bearer>]   (or CLEGRA_TOKEN in the environment)
// clegra init [dir] [--ui] [--dry-run]    (the clegra package added to an existing Next.js App Router app; --ui: clegra/ui too)
const USAGE = "usage: clegra check <url> [--token <bearer>]\n       clegra init [dir] [--ui] [--dry-run]"
const [command, ...args] = process.argv.slice(2)

if (command === "init") process.exit(initMain(args))

const url = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--token")
const at = args.indexOf("--token")
const token = at >= 0 ? args[at + 1] : process.env.CLEGRA_TOKEN
if (command !== "check" || !url) {
  console.error(USAGE)
  process.exit(2)
}
const report = await checkApp({ url, ...(token ? { token } : {}) })
console.log(formatReport(report))
// 0: conformant; 1: a check failed; 3: nothing failed but the MCP checks did not run (no token).
process.exit(!report.ok ? 1 : report.complete ? 0 : 3)
