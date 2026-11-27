import { listen } from "@clegra/sdk/node"

import { shipmentsApp } from "./clegra/app"
import { shipmentsAuth } from "./auth"
import { createShipmentsApp, SHIPMENTS_INSTALLATION } from "./fixture"
import { serveShipments } from "./serve"

/**
 * Starts the Shipments app server (MCP at /mcp, the manifest at /.well-known/clegra.json, the index at /openapi.json).
 * The data are invented and in memory: a restart starts again from the seed.
 *
 *   npm start      with the app's own sign-in (src/auth.ts):
 *                    SHIPMENTS_PUBLIC_URL  the app's public address (required; MCP at <url>/mcp, sign-in at <url>/signin)
 *                    SHIPMENTS_SIGNIN_KEY  the sign-in's signing key (required in production), CLEGRA_CLIENT_ORIGINS
 *                    SHIPMENTS_HOST        default 0.0.0.0
 *   npm run dev    on 127.0.0.1 only, signed in by the development sign-in (test people, a printed token); never in production
 *   SHIPMENTS_PORT default 4319
 */
async function main() {
  const dev = process.argv.includes("--dev")
  const port = Number(process.env.SHIPMENTS_PORT ?? 4319)
  if (dev) {
    const served = createShipmentsApp({ issuer: `http://127.0.0.1:${port}` })
    const running = await listen(served, { port, host: "127.0.0.1" })
    const token = await served.dev!.token({ person: "ada", permissions: "all", installation: SHIPMENTS_INSTALLATION })
    console.log(`Shipments (dev) on ${running.url}. A token for Ada, while this process runs:\n  npx @clegra/sdk check ${running.url} --token ${token}`)
    stopOn(running.close)
    return
  }
  // The sign-in reads the app's definition (its title and permissions as scopes); the app is served with it.
  const { auth } = shipmentsAuth(shipmentsApp)
  const served = serveShipments({ auth })
  const running = await listen(served, { port, host: process.env.SHIPMENTS_HOST ?? "0.0.0.0" })
  console.log(`Shipments on ${running.url}: MCP address ${auth.resource}, signed in at ${new URL("/signin", auth.resource)}`)
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
