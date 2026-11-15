import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { withModelApp } from "modelapp/next"
import type { NextConfig } from "next"

const here = dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  // PGlite (local development database only) ships WebAssembly and data files: loaded by Node as is, never bundled.
  serverExternalPackages: ["@electric-sql/pglite"],
  // The monorepo root, where node_modules is.
  turbopack: { root: join(here, "../../..") },
  // No generated AGENTS.md in the project.
  agentRules: false,
}

// /mcp, /.well-known/modelapp.json and the OAuth metadata → app/api/modelapp/[...path]/route.ts.
export default withModelApp(nextConfig)
