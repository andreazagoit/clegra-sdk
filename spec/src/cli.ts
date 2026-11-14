#!/usr/bin/env -S npx tsx
import { checkApp, formatReport } from "./conformance"

// modelapp check <url> [--token <bearer>]   (or MODELAPP_TOKEN in the environment)
const [command, ...args] = process.argv.slice(2)
const url = args.find((a) => !a.startsWith("--"))
const at = args.indexOf("--token")
const token = at >= 0 ? args[at + 1] : process.env.MODELAPP_TOKEN
if (command !== "check" || !url) {
  console.error("usage: modelapp check <url> [--token <bearer>]")
  process.exit(2)
}
const report = await checkApp({ url, ...(token ? { token } : {}) })
console.log(formatReport(report))
// 0: conformant; 1: a check failed; 3: nothing failed but the MCP checks did not run (no token).
process.exit(!report.ok ? 1 : report.complete ? 0 : 3)
