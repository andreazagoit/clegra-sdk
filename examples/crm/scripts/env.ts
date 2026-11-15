// Scripts read .env.local like `next dev` does (the environment wins).
import { existsSync } from "node:fs"

const file = new URL("../.env.local", import.meta.url)
if (existsSync(file)) process.loadEnvFile(file)
