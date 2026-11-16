/**
 * THE PROTOCOL'S NAMES, IN ONE PLACE. Everything that carries the name on the
 * wire derives from `id` below: the SDK, the conformance checks and hosts
 * import these, so renaming the protocol is this file plus a search-replace
 * of the package and folder names. No dependencies.
 */

/** In prose: «Model App Protocol (MAP)» on first use, then «MAP». */
export const PROTOCOL_NAME = "Model App Protocol"
export const PROTOCOL_SHORT_NAME = "MAP"
/** The technical name (never the ambiguous word «map»). */
export const PROTOCOL_ID = "modelapp"
export const SPEC_VERSION = "1.0"

/** Where every app serves its manifest. */
export const MANIFEST_PATH = `/.well-known/${PROTOCOL_ID}.json`
/** The scheme of record and fragment URIs: `modelapp://<app>/<type>/<key>`; the manifest's own resource is `modelapp://<app>`. */
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
/** The tool hosts resolve record and fragment URIs with. */
export const RESOLVE_TOOL = `${PROTOCOL_ID}_resolve`
/** The `$id` of the manifest's JSON Schema. */
export const SCHEMA_ID = `urn:${PROTOCOL_ID}:manifest:${SPEC_VERSION}`

/** The tool a host (or the app's own view) asks for an embed ticket with (spec §5.1): app-only, hidden from models. */
export const EMBED_TOOL = `${PROTOCOL_ID}_embed`
/** The `typ` of an embed ticket (a JWT, one minute, used once). */
export const EMBED_TICKET_TYPE = `${PROTOCOL_ID}-embed+jwt`
/** The `typ` of the embed session a ticket is exchanged for (the cookie's value). */
export const EMBED_SESSION_TYPE = `${PROTOCOL_ID}-embed-session+jwt`
/** The form field the ticket is posted in. */
export const EMBED_TICKET_FIELD = "ticket"
/** Where, under the embed path, the ticket is exchanged: a `_` segment, never a Next.js page (private folder). */
export const EMBED_EXCHANGE_SEGMENT = "_ticket"
/** The embed session cookie of a page is `<prefix><page>` (`__Secure-`: it is always Secure). */
export const EMBED_COOKIE_PREFIX = `__Secure-${PROTOCOL_ID}-embed-`
/** How long a ticket lives at most, in seconds, and the clock skew allowed when it is checked. */
export const EMBED_TICKET_SECONDS = 60
export const EMBED_SKEW_SECONDS = 5
