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
