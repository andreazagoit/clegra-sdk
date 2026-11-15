// The better-auth options that shape the database: what `npm run auth:schema`
// turns into db/auth-schema.ts. lib/auth.ts adds the runtime parts (database,
// secret, hooks, Next cookies). A plugin added here needs `npm run auth:schema`
// and `npm run db:generate`.
import type { BetterAuthOptions } from "better-auth"
import { organization } from "better-auth/plugins"

export const authSchemaOptions = {
  // People get their accounts from the CRM's operator (here: `npm run db:seed`), never by signing up.
  emailAndPassword: { enabled: true, disableSignUp: true },
  plugins: [
    // The tenant: every record belongs to the session's active organization.
    organization({ allowUserToCreateOrganization: false }),
  ],
} satisfies BetterAuthOptions
