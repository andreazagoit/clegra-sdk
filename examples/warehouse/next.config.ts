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
  // Who may frame a page is said in one place: proxy.ts (the app's own site, spec §5.1).
}

// /mcp, /.well-known/clegra.json and the OAuth metadata → app/api/clegra/[...path]/route.ts.
export default withClegra(nextConfig)
