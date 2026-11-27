import { checkApp, formatReport } from "./check"
import { initMain } from "./init/index"

// clegra check <url> [--token T] [--read-token T] [--confirm-call JSON] [--json]   (tokens also CLEGRA_TOKEN, CLEGRA_READ_TOKEN)
// clegra init [dir] [--ui] [--dry-run]    (@clegra/sdk added to an existing Next.js App Router app; --ui: @clegra/ui too)
const USAGE = `usage: clegra check <url> [--token <bearer>] [--read-token <bearer>] [--confirm-call '{"tool":"…","arguments":{…}}'] [--json]
       clegra init [dir] [--ui] [--dry-run]`

const VALUED = new Set(["--token", "--read-token", "--confirm-call"])

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv
  if (command === "init") return initMain(args)
  if (command !== "check") {
    console.error(USAGE)
    return 2
  }
  const flag = (name: string) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const unknown = args.filter((a, i) => a.startsWith("--") && !VALUED.has(a) && a !== "--json" && !VALUED.has(args[i - 1] ?? ""))
  const urls = args.filter((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1] ?? ""))
  const token = flag("--token") ?? process.env.CLEGRA_TOKEN
  const readToken = flag("--read-token") ?? process.env.CLEGRA_READ_TOKEN
  const rawCall = flag("--confirm-call")
  if (unknown.length || urls.length !== 1 || !token) {
    console.error(!token && urls.length === 1 && !unknown.length ? "clegra check: give a token of the app's own sign-in (--token or CLEGRA_TOKEN)" : USAGE)
    return 2
  }
  let confirmCall: { tool: string; arguments: Record<string, unknown> } | undefined
  if (rawCall) {
    try {
      const parsed = JSON.parse(rawCall) as { tool?: unknown; arguments?: unknown }
      if (typeof parsed.tool !== "string") throw new Error("no tool")
      confirmCall = { tool: parsed.tool, arguments: (parsed.arguments ?? {}) as Record<string, unknown> }
    } catch {
      console.error('clegra check: --confirm-call is JSON: {"tool":"<name>","arguments":{…}}')
      return 2
    }
  }
  const report = await checkApp({ url: urls[0]!, token, ...(readToken ? { readToken } : {}), ...(confirmCall ? { confirmCall } : {}) })
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report))
  // 0: nothing failed; 1: a check failed.
  return report.ok ? 0 : 1
}

process.exit(await main(process.argv.slice(2)))
