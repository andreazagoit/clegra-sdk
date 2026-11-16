import { cimd } from "@better-auth/cimd"
import { fetchClientMetadataResource } from "@better-auth/cimd/node"
import { mcp } from "@better-auth/mcp"
import { betterAuth } from "better-auth"
import { APIError } from "better-auth/api"
import { nextCookies } from "better-auth/next-js"
import { jwt, organization } from "better-auth/plugins"

import { getDb, type Pool } from "./db"
import { mcpResource, publicUrl } from "./site"

/** The scope MCP clients ask for, and the MAP route requires on every access token. */
export const MODELAPP_SCOPE = "modelapp"

export type AuthOptions = {
  /** Off while migrating: on start better-auth compares its tables with the plugins and logs what is missing. */
  validateSchema?: boolean
  /** How a client's metadata document (CIMD) is fetched (tests serve their own; default the DNS-pinning Node fetch). */
  fetchClientMetadata?: typeof fetchClientMetadataResource
}

/**
 * Sign-in for the app's own users, and the authorization server for MCP clients — all better-auth:
 *
 * - email + password, the organization plugin (the tenant is the session's active organization);
 * - jwt + mcp: ChatGPT, Claude or Clegra connect with OAuth 2.1 (PKCE, `resource`), the person signs in on
 *   /sign-in and agrees on /oauth/consent; access tokens are JWTs for `<site>/mcp` carrying the organization (`org`);
 * - cimd: clients identify themselves with an https URL (a Client ID Metadata Document). Dynamic client
 *   registration stays off: an open /oauth2/register would let anyone show any name on the consent page.
 *
 * Its tables live in the same database (better-auth's Kysely dialect on the same pool); `npm run db:migrate` creates them.
 */
export function createAuth(pool: Pool, options: AuthOptions = {}) {
  return betterAuth({
    appName: "Warehouse",
    // The issuer of access tokens is `<site>/api/auth`.
    baseURL: publicUrl(),
    // better-auth refuses to start in production without it; in development it warns.
    secret: process.env.BETTER_AUTH_SECRET,
    database: pool,
    // The client's address for rate limiting: on Vercel (and `next start` behind one proxy) x-real-ip / x-forwarded-for hold
    // the one address the platform saw; without it every client would share one bucket.
    advanced: { ipAddress: { ipAddressHeaders: ["x-real-ip", "x-forwarded-for"] }, ...(options.validateSchema === false ? { database: { validateSchema: false } } : {}) },
    // Staff accounts are made by an admin (here: the seed), not by a public sign-up form.
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: { expiresIn: 60 * 60 * 24 * 7 },
    // Sign-in attempts are counted in the database, so every server instance (serverless) shares the count.
    rateLimit: { storage: "database" },
    // The jwt plugin's /token hands out session JWTs; MCP clients use OAuth access tokens only.
    disabledPaths: ["/token"],
    databaseHooks: {
      session: {
        create: {
          // A session starts in the person's organization (here a person belongs to one): every sign-in, also
          // the one in the middle of an OAuth authorization, has an active organization for the token to carry.
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
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        resource: mcpResource(),
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        scopes: ["openid", "profile", "email", "offline_access", MODELAPP_SCOPE],
        postLogin: {
          // No organization step: the session hook above already chose the person's one organization.
          // (An app whose people belong to several would show a picker here and set shouldRedirect.)
          page: "/oauth/consent",
          shouldRedirect: () => false,
          // The connection is for the active organization: it goes into the consent and every access token.
          consentReferenceId: ({ session }) => {
            if (!session.activeOrganizationId) throw new APIError("BAD_REQUEST", { error: "invalid_request", error_description: "this account belongs to no organization" })
            return session.activeOrganizationId as string
          },
        },
        customAccessTokenClaims: ({ referenceId }) => (referenceId ? { org: referenceId } : {}),
      }),
      cimd({ fetchClientMetadataResource: options.fetchClientMetadata ?? fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
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
