import path from "node:path"

import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The example lives in a monorepo: its dependencies (and modelapp) are installed at the root.
  turbopack: { root: path.join(import.meta.dirname, "../../..") },
  // The embedded Postgres loads its WebAssembly and data files at run time: not bundled.
  serverExternalPackages: ["@electric-sql/pglite"],
  // The repository keeps its own agent instructions; no generated AGENTS.md in the example.
  agentRules: false,
}

export default nextConfig
