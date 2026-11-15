import { betterAuth } from "better-auth"
import { nextCookies } from "better-auth/next-js"
import { organization } from "better-auth/plugins"

import { getDb, type Pool } from "./db"

/**
 * Sign-in for the app's own users: better-auth, email + password, with the
 * organization plugin (the tenant is the session's active organization).
 * Its tables live in the same database (better-auth's Kysely dialect on the
 * same pool); `npm run db:migrate` creates them.
 */
export function createAuth(pool: Pool, options: { validateSchema?: boolean } = {}) {
  return betterAuth({
    appName: "Warehouse",
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3930",
    // better-auth refuses to start in production without it; in development it warns.
    secret: process.env.BETTER_AUTH_SECRET,
    database: pool,
    // On start better-auth compares its tables with the plugins and logs what is missing (off while migrating).
    ...(options.validateSchema === false ? { advanced: { database: { validateSchema: false } } } : {}),
    // Staff accounts are made by an admin (here: the seed), not by a public sign-up form.
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: { expiresIn: 60 * 60 * 24 * 7 },
    databaseHooks: {
      session: {
        create: {
          // A new session starts in the person's first organization (each demo person belongs to one).
          before: async (session) => {
            const rows = await pool.query(`SELECT "organizationId" FROM member WHERE "userId" = $1 ORDER BY "createdAt" LIMIT 1`, [session.userId])
            const organizationId = rows.rows[0]?.organizationId
            return { data: { ...session, activeOrganizationId: typeof organizationId === "string" ? organizationId : null } }
          },
        },
      },
    },
    plugins: [
      organization({ creatorRole: "admin", allowUserToCreateOrganization: false }),
      // Last: lets server actions set the session cookie.
      nextCookies(),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

const holder = globalThis as unknown as { __warehouseAuth?: Promise<Auth> }

/** The app's better-auth instance, made on first use (never at build time). */
export function getAuth(): Promise<Auth> {
  holder.__warehouseAuth ??= getDb().then((db) => createAuth(db.pool))
  return holder.__warehouseAuth
}
