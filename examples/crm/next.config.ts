import path from "node:path"

import { withClegra } from "@clegra/sdk/next"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The example is a workspace of this repository: its dependencies (and @clegra/sdk, the repository root) are installed at the root.
  turbopack: { root: path.join(import.meta.dirname, "../..") },
  // The embedded Postgres (local runs only) loads its WebAssembly and data files at run time: never bundled.
  serverExternalPackages: ["@electric-sql/pglite"],
  // The repository keeps its own agent instructions; no generated AGENTS.md in the example.
  agentRules: false,
  // Who may frame a page is said in one place: proxy.ts (the app's own site, spec §5.1).
}

// MCP at /mcp, the manifest and the OAuth metadata under /.well-known/, all served by app/api/clegra/[...path].
export default withClegra(nextConfig)
