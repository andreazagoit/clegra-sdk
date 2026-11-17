import { listen } from "@clegra/sdk/node"

import { defineShipmentsApp } from "./app"
import { shipmentsAuth } from "./auth"
import { createShipmentsApp, SHIPMENTS_INSTALLATION } from "./fixture"

/**
 * Starts the Shipments app server (MCP at /mcp, the manifest at /.well-known/clegra.json).
 * The data are invented and in memory: a restart starts again from the seed.
 *
 *   npm start      for workspace hosts:
 *                    SHIPMENTS_PUBLIC_URL  the address the nodes install it from (required; MCP at <url>/mcp)
 *                    CLEGRA_ISSUERS        the trusted nodes, `issuer` or `issuer|jwksUri`, comma-separated (required)
 *                    SHIPMENTS_HOST        default 0.0.0.0
 *   npm run dev    on 127.0.0.1 only, signed in by the SDK's dev authority (test people, a printed token); never in production
 *   SHIPMENTS_PORT default 4319
 */
async function main() {
  const dev = process.argv.includes("--dev")
  const port = Number(process.env.SHIPMENTS_PORT ?? 4319)
  if (dev) {
    const app = createShipmentsApp()
    const running = await listen(app, { port, host: "127.0.0.1" })
    const token = await app.devToken({ person: "ada", permissions: "all", installation: SHIPMENTS_INSTALLATION })
    console.log(`Shipments (dev) on ${running.url}. A token for Ada, while this process runs:\n  npx @clegra/sdk check ${running.url} --token ${token}`)
    stopOn(running.close)
    return
  }
  const auth = shipmentsAuth()
  const app = defineShipmentsApp({ auth })
  const running = await listen(app, { port, host: process.env.SHIPMENTS_HOST ?? "0.0.0.0" })
  console.log(`Shipments on ${running.url}: MCP address ${auth.resource}, trusting ${auth.issuers.map((i) => i.issuer).join(", ")}`)
  stopOn(running.close)
}

function stopOn(close: () => Promise<void>) {
  const stop = async () => {
    await close()
    process.exit(0)
  }
  process.once("SIGTERM", () => void stop())
  process.once("SIGINT", () => void stop())
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
