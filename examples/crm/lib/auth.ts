// Sign-in: better-auth, email + password, organizations as tenants, its tables
// in the CRM's own database (Drizzle adapter). Created on first use.
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { nextCookies } from "better-auth/next-js"
import { and, asc, eq } from "drizzle-orm"

import * as schema from "@/db/schema"

import { authSchemaOptions } from "./auth-options"
import { db } from "./db"

const LOCAL_URL = "http://localhost:3920"

export function createAuth(env: Record<string, string | undefined> = process.env) {
  const secret = env.BETTER_AUTH_SECRET?.trim()
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set: run `npm run setup` (writes .env.local), or set it in the environment.")
  const baseURL = env.BETTER_AUTH_URL?.trim() || (env.NODE_ENV === "production" ? undefined : LOCAL_URL)
  if (!baseURL) throw new Error("BETTER_AUTH_URL is not set: the CRM's public address (https://…) is needed in production.")
  return betterAuth({
    ...authSchemaOptions,
    secret,
    baseURL,
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
    plugins: [...authSchemaOptions.plugins, nextCookies()],
  })
}

export type Auth = ReturnType<typeof createAuth>

const holder = globalThis as typeof globalThis & { __crmAuth?: Auth }

export const auth = (): Auth => (holder.__crmAuth ??= createAuth())

/** The person's membership of an organization, read live: role and the organization's name. Null when not a member. */
export async function membership(organizationId: string, userId: string): Promise<{ role: string; organizationName: string } | null> {
  const [row] = await db()
    .select({ role: schema.member.role, organizationName: schema.organization.name })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
  return row ?? null
}
