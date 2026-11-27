// The runtime's environment, read without Node's own modules: `process.env` where the runtime has one (Node, Bun,
// Deno's Node compatibility, Next.js), nothing elsewhere (an edge runtime).

type Env = Record<string, string | undefined>

/** The environment variables, or an empty set on a runtime without them. */
export const env = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {}

/** Whether this is a production run (`NODE_ENV=production`). */
export const isProduction = () => env().NODE_ENV === "production"
