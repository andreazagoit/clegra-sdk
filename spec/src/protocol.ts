/**
 * THE NAMES CLEGRA APPS CARRY ON THE WIRE, IN ONE PLACE. Everything derives from
 * `PROTOCOL_ID` below: the package, the conformance checks and the Clegra host
 * import these. No dependencies.
 */

/** The technical name: the package's, the manifest's path, the URI scheme, the `_meta` key, the claim and the scope. */
export const PROTOCOL_ID = "clegra"
export const SPEC_VERSION = "1.0"

/**
 * The app's tint (spec §2 `accent`): one name of a closed palette, like Apple's apps' tint colours, never a free colour.
 * The colours themselves (light and dark, AA contrast) are the host's design library's (@clegra/ui `accents`); the
 * SDK knows only the names, so it needs no UI package at run time.
 */
export const APP_ACCENTS = ["blue", "indigo", "purple", "pink", "red", "orange", "yellow", "green", "teal", "gray"] as const
export type AppAccent = (typeof APP_ACCENTS)[number]
/** The accent of an app that declares none: Clegra's blue. */
export const DEFAULT_APP_ACCENT: AppAccent = "blue"

/** Where every app serves its manifest. */
export const MANIFEST_PATH = `/.well-known/${PROTOCOL_ID}.json`
/** The scheme of record and artifact URIs: `clegra://<app>/<type>/<key>`; the manifest's own resource is `clegra://<app>`. */
export const URI_SCHEME = PROTOCOL_ID
export const uriPrefix = (app: string) => `${URI_SCHEME}://${app}`
/** The one `_meta` key of the host protocol: `{ call, confirmation, settings }` on requests, `{ notifications, untrusted }` on results. */
export const META_KEY = PROTOCOL_ID
/** The claim of an access token that says who calls, for which installation. */
export const TOKEN_CLAIM = PROTOCOL_ID
/** The OAuth scope apps announce. */
export const OAUTH_SCOPE = PROTOCOL_ID
/** The `typ` of a confirmation proof (a JWT). */
export const CONFIRMATION_TYPE = `${PROTOCOL_ID}-confirm+jwt`
/** The tool hosts resolve record and artifact URIs with. */
export const RESOLVE_TOOL = `${PROTOCOL_ID}_resolve`
/** The `$id` of the manifest's JSON Schema. */
export const SCHEMA_ID = `urn:${PROTOCOL_ID}:manifest:${SPEC_VERSION}`

// The app's own site (spec §5.1): a Clegra client frames the app's real pages, the person signed in with a ticket.

/** Where the SDK's side of the site lives, on the app's own origin. */
export const SITE_PATH = `/${PROTOCOL_ID}/site`
/** The bridge script a site page loads (spec §5.1). */
export const SITE_BRIDGE_PATH = `${SITE_PATH}/bridge.js`
/** The messages between a site's frame and the client (spec §5.1 step 8). */
export const SITE_MESSAGES = {
  location: `${PROTOCOL_ID}/location`,
  context: `${PROTOCOL_ID}/context`,
} as const

// Views at the app's own origin (spec §5.3): a Clegra client frames them from the app itself, never from a host's page.

/** The tool a Clegra client asks for a view ticket with: app-only, hidden from models, only for a person's app token. */
export const VIEW_TOOL = `${PROTOCOL_ID}_view`
/** Where an app serves its views (under its `path`): `<path>/clegra/views/<the view URI's path>`, a POST with the ticket. */
export const VIEWS_PATH = `/${PROTOCOL_ID}/views`
/** The form field the view ticket is posted in. */
export const VIEW_TICKET_FIELD = "ticket"
/** How long a view ticket lives at most, in seconds; it is used once. */
export const VIEW_TICKET_SECONDS = 60
/** The meta tag a served view carries with the exact origin of the client that frames it (`<meta name content>`). */
export const VIEW_HOST_META = `${PROTOCOL_ID}-host`

// The reserved app-only tools only the installation-level caller (a workspace host's token with no person) is given.

/** Runs the stored «approve now, act later» runs that are due; also the name of its schedule. */
export const LATER_TOOL = `${PROTOCOL_ID}_later`
/** Tells the app its installation was enabled, disabled or uninstalled. */
export const INSTALLATION_TOOL = `${PROTOCOL_ID}_installation`
/** The tenant's data, as one file. */
export const EXPORT_TOOL = `${PROTOCOL_ID}_export`
/** Deletes everything the app keeps for the tenant. */
export const DELETE_TOOL = `${PROTOCOL_ID}_delete`
/** Every reserved tool name of the installation-level caller. */
export const INSTALLATION_TOOLS = [LATER_TOOL, INSTALLATION_TOOL, EXPORT_TOOL, DELETE_TOOL] as const

