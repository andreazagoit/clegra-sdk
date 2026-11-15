import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { NextConfig } from "next"

const here = dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  // PGlite (local development database) ships WebAssembly and data files: loaded by Node as is, never bundled.
  serverExternalPackages: ["@electric-sql/pglite"],
  // The monorepo root, where node_modules is.
  turbopack: { root: join(here, "../../..") },
}

export default nextConfig
