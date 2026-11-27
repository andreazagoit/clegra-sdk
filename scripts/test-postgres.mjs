// `npm run test:postgres`: the SQL stores' suite (src/sql-stores.test.ts) on a real Postgres through postgres.js, as
// well as PGlite. A scratch Postgres container is started for it on a free loopback port and removed at the end,
// whatever happens. CLEGRA_SDK_TEST_IMAGE names the image (default postgres:17-alpine; it is never pulled here).
// With CLEGRA_SDK_TEST_DATABASE_URL already set, no container is started and that database is used.
import { execFileSync, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const run = (env) => spawnSync("npx", ["tsx", "--test", "src/sql-stores.test.ts"], { cwd: root, stdio: "inherit", env: { ...process.env, ...env } }).status ?? 1

if (process.env.CLEGRA_SDK_TEST_DATABASE_URL) process.exit(run({}))

const image = process.env.CLEGRA_SDK_TEST_IMAGE ?? "postgres:17-alpine"
const name = `clegra-sdk-test-pg-${process.pid}`
const password = randomBytes(12).toString("hex")
const started = spawnSync("docker", ["run", "-d", "--rm", "--name", name, "--pull", "never", "-e", "POSTGRES_PASSWORD", "-p", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data", image], {
  encoding: "utf8",
  env: { ...process.env, POSTGRES_PASSWORD: password },
})
if (started.status !== 0) {
  console.error(`test:postgres: no scratch Postgres could start from ${image} (docker: ${(started.stderr || started.error?.message || "").trim()})`)
  process.exit(1)
}
let status = 1
try {
  const port = /:(\d+)\s*$/.exec(execFileSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" }).split("\n")[0])?.[1]
  if (!port) throw new Error("the container's port is unknown")
  const until = Date.now() + 60_000
  // pg_isready answers during the image's first start too: wait for a real query.
  while (spawnSync("docker", ["exec", "-e", "PGPASSWORD", name, "psql", "-U", "postgres", "-h", "127.0.0.1", "-c", "select 1"], { stdio: "ignore", env: { ...process.env, PGPASSWORD: password } }).status !== 0) {
    if (Date.now() > until) throw new Error("the scratch Postgres was not ready after 60 s")
    spawnSync("sleep", ["1"])
  }
  status = run({ CLEGRA_SDK_TEST_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres` })
} catch (error) {
  console.error(`test:postgres: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" })
}
process.exit(status)
