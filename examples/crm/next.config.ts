import path from "node:path"

import { withModelApp } from "modelapp/next"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The example lives in a monorepo: its dependencies (and modelapp) are installed at the root.
  turbopack: { root: path.join(import.meta.dirname, "../../..") },
  // The embedded Postgres (local runs only) loads its WebAssembly and data files at run time: never bundled.
  serverExternalPackages: ["@electric-sql/pglite"],
  // The repository keeps its own agent instructions; no generated AGENTS.md in the example.
  agentRules: false,
  // No page may be framed, except the embeddable ones (/embed/*, their policy is set in proxy.ts).
  headers: async () => [{ source: "/((?!embed/).*)", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }] }],
}

// MCP at /mcp, the manifest and the OAuth metadata under /.well-known/, all served by app/api/modelapp/[...path].
export default withModelApp(nextConfig)
