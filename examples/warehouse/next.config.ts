import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { withClegra } from "@clegra/sdk/next"
import type { NextConfig } from "next"

const here = dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  // PGlite (local development database only) ships WebAssembly and data files: loaded by Node as is, never bundled.
  serverExternalPackages: ["@electric-sql/pglite"],
  // The repository root, where node_modules is (and @clegra/sdk itself).
  turbopack: { root: join(here, "../..") },
  // No generated AGENTS.md in the project.
  agentRules: false,
  // No page may be framed, except the embedded ones (/embed/*: their frame-ancestors come from proxy.ts), so sign-in
  // and consent can't be clickjacked.
  headers: async () => [{ source: "/((?!embed/).*)", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }] }],
}

// /mcp, /.well-known/clegra.json and the OAuth metadata → app/api/clegra/[...path]/route.ts.
export default withClegra(nextConfig)
