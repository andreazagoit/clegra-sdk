// The better-auth options: email + password, organizations (the tenant), and better-auth as the OAuth
// authorization server of the CRM's MCP server (jwt + mcp + cimd). lib/auth.ts adds the database, the
// secret and the hooks. They also shape the database: after a plugin change, `npm run auth:schema` then
// `npm run db:generate`.
import { cimd } from "@better-auth/cimd"
import { fetchClientMetadataResource } from "@better-auth/cimd/node"
import { mcp } from "@better-auth/mcp"
import type { BetterAuthOptions } from "better-auth"
import { APIError } from "better-auth/api"
import { jwt, organization } from "better-auth/plugins"

import { mcpResource } from "./site"

/** The scope Clegra app servers announce in their protected-resource metadata; tokens without it are refused. */
export const CLEGRA_SCOPE = "clegra"

/** The access-token claim that names the organization a connection is for. */
export const ORG_CLAIM = "org"

/**
 * `cimdTransport`: how Client ID Metadata Documents (and their key sets) are fetched. Default: better-auth's own,
 * public addresses only, pinned. A test passes a fake one to serve a client's documents in-process.
 */
export function authSchemaOptions(env?: Record<string, string | undefined>, cimdTransport: typeof fetchClientMetadataResource = fetchClientMetadataResource) {
  return {
    // People get their accounts from the CRM's operator (here: `npm run db:seed`), never by signing up.
    emailAndPassword: { enabled: true, disableSignUp: true },
    // The jwt plugin's /token hands out session JWTs; MCP clients get OAuth access tokens only.
    disabledPaths: ["/token"],
    plugins: [
      // The tenant: every record belongs to the session's active organization.
      organization({ allowUserToCreateOrganization: false }),
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        resource: mcpResource(env),
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        scopes: ["openid", "profile", "email", "offline_access", CLEGRA_SCOPE],
        // A connection is for one organization. Here a person belongs to exactly one (organizations are made by the
        // operator), and a new session starts in it (lib/auth.ts), so there is no organization page to choose on:
        // never redirect there. The organization is still always in the token, or the authorization fails.
        postLogin: {
          page: "/sign-in",
          shouldRedirect: () => false,
          consentReferenceId: ({ session }) => {
            const org = session.activeOrganizationId
            if (typeof org !== "string" || !org) throw new APIError("BAD_REQUEST", { error: "invalid_request", error_description: "this account belongs to no organization" })
            return org
          },
        },
        // The organization in every access token, also after a refresh.
        customAccessTokenClaims: ({ referenceId }) => (referenceId ? { [ORG_CLAIM]: referenceId } : {}),
      }),
      // Clients identified by an https URL (ChatGPT, Claude, VS Code…): no registration. Dynamic client
      // registration stays off: an open /register would let anyone show any name on the consent page.
      cimd({ fetchClientMetadataResource: cimdTransport, metadataProfile: "mcp-2026-07-28" }),
    ],
  } satisfies BetterAuthOptions
}
