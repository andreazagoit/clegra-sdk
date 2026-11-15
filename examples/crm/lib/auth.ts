// Sign-in: better-auth, email + password, organizations as tenants, and the OAuth authorization server of the
// MCP server (lib/auth-options.ts); its tables in the CRM's own database (Drizzle adapter). Created on first use.
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { nextCookies } from "better-auth/next-js"
import { and, asc, eq } from "drizzle-orm"

import * as schema from "@/db/schema"

import { authSchemaOptions } from "./auth-options"
import { db } from "./db"
import { publicOrigin } from "./site"

export function createAuth(env: Record<string, string | undefined> = process.env) {
  const secret = env.BETTER_AUTH_SECRET?.trim()
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set: run `npm run setup` (writes .env.local), or set it in the environment.")
  const options = authSchemaOptions(env)
  return betterAuth({
    ...options,
    secret,
    // The public origin; better-auth lives at /api/auth under it, which is the OAuth issuer.
    baseURL: publicOrigin(env),
    database: drizzleAdapter(db(), { provider: "pg", schema }),
    databaseHooks: {
      session: {
        create: {
          // A new session starts in the person's first organization: the tenant every page reads.
          before: async (session) => {
            const [first] = await db()
              .select({ organizationId: schema.member.organizationId })
              .from(schema.member)
              .where(eq(schema.member.userId, session.userId))
              .orderBy(asc(schema.member.createdAt))
              .limit(1)
            return { data: { ...session, activeOrganizationId: first?.organizationId ?? null } }
          },
        },
      },
    },
    // nextCookies last: it sets the cookies of sign-ins made in server actions.
    plugins: [...options.plugins, nextCookies()],
  })
}

export type Auth = ReturnType<typeof createAuth>

const holder = globalThis as typeof globalThis & { __crmAuth?: Auth }

export const auth = (): Auth => (holder.__crmAuth ??= createAuth())

/** The person's membership of an organization, read live: role, the person's and the organization's names. Null when not a member (or the user is gone). */
export async function membership(organizationId: string, userId: string): Promise<{ role: string; userName: string; organizationName: string } | null> {
  const [row] = await db()
    .select({ role: schema.member.role, userName: schema.user.name, organizationName: schema.organization.name })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
  return row ?? null
}
