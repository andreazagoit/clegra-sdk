import { calculateJwkThumbprint, decodeProtectedHeader, EmbeddedJWK, jwtVerify, type JWK, type JWTPayload } from "jose"

import { AuthError } from "./auth"
import { randomToken, sha256 } from "./crypto"

/**
 * DPoP (RFC 9449), the app's side: a token bound to a client's key (`cnf.jkt`) is accepted only with a fresh proof
 * signed by that key for exactly this request. Web Crypto only.
 */

export const DPOP_TYPE = "dpop+jwt"
/** The proof algorithms accepted (`dpop_signing_alg_values_supported`, the DPoP challenge's `algs`). */
export const DPOP_ALGS = ["EdDSA", "ES256"] as const
/** How far a proof's `iat` may be from now without a nonce; the window a proof's `jti` is remembered. */
export const DPOP_SKEW_SECONDS = 60
/** How long a nonce given by the app stays good. */
export const DPOP_NONCE_SECONDS = 300

/** A DPoP failure: `nonce` set when the client should retry with it (`use_dpop_nonce`). */
export class DpopError extends AuthError {
  constructor(
    message: string,
    readonly nonce: string | null = null,
  ) {
    super(message)
    this.name = "DpopError"
  }
}

/** What the check needs to keep: used proof ids, nonces given. */
export type DpopMemory = {
  once(key: string, ttlMs: number): Promise<boolean>
  get(key: string): Promise<unknown | null>
  set(key: string, value: unknown, ttlMs: number | null): Promise<void>
}

/** A new nonce, good for DPOP_NONCE_SECONDS. */
export async function dpopNonce(memory: DpopMemory): Promise<string> {
  const value = randomToken(18)
  await memory.set(`dpop-nonce:${value}`, true, DPOP_NONCE_SECONDS * 1000)
  return value
}

const urlWithoutQuery = (value: unknown): string | null => {
  if (typeof value !== "string" || !URL.canParse(value)) return null
  const url = new URL(value)
  url.search = url.hash = ""
  return url.toString()
}

/**
 * Checks a DPoP proof: `typ` dpop+jwt with a public `jwk`, signed by it; `htm` the method; `htu` exactly `input.htu`
 * (the configured address, never the request's own Host: behind a proxy that is not what the client called); `ath`
 * the token's hash when a token is presented with it; `iat` within 60 seconds unless it carries a nonce the app gave;
 * its `jti` used once; the key's thumbprint `jkt` when the token is bound to one. Returns the proof key's thumbprint.
 * Throws DpopError (with a nonce when the client should retry with one).
 */
export async function checkDpopProof(proof: string | null, input: { method: string; htu: string; token?: string; jkt?: string; memory: DpopMemory }): Promise<string> {
  if (!proof) throw new DpopError("a DPoP proof is required (the DPoP header)")
  let header: ReturnType<typeof decodeProtectedHeader>
  try {
    header = decodeProtectedHeader(proof)
  } catch {
    throw new DpopError("the DPoP proof is not a JWT")
  }
  const jwk = header.jwk as JWK | undefined
  if (header.typ !== DPOP_TYPE || !jwk || typeof jwk !== "object" || "d" in jwk || jwk.kty === "oct") throw new DpopError("the DPoP proof needs typ dpop+jwt and a public jwk")
  let payload: JWTPayload
  try {
    ;({ payload } = await jwtVerify(proof, EmbeddedJWK, { typ: DPOP_TYPE, algorithms: [...DPOP_ALGS], requiredClaims: ["iat", "jti", "htm", "htu"] }))
  } catch (error) {
    throw new DpopError(`the DPoP proof does not verify: ${error instanceof Error ? error.message : "invalid"}`)
  }
  const jkt = await calculateJwkThumbprint(jwk, "sha256")
  if (input.jkt !== undefined && jkt !== input.jkt) throw new DpopError("the DPoP proof is signed by another key than the token is bound to")
  if (payload.htm !== input.method) throw new DpopError(`the DPoP proof is for ${String(payload.htm)}, not ${input.method}`)
  if (urlWithoutQuery(payload.htu) !== urlWithoutQuery(input.htu)) throw new DpopError(`the DPoP proof is for ${String(payload.htu)}, not ${input.htu}`)
  if (input.token !== undefined && payload.ath !== (await sha256(input.token))) throw new DpopError("the DPoP proof is for another token (ath)")
  if (typeof payload.jti !== "string" || !payload.jti || payload.jti.length > 200) throw new DpopError("the DPoP proof needs a jti")
  const now = Math.floor(Date.now() / 1000)
  if (payload.nonce !== undefined) {
    if (typeof payload.nonce !== "string" || !(await input.memory.get(`dpop-nonce:${payload.nonce}`))) throw new DpopError("the DPoP nonce is unknown or expired", await dpopNonce(input.memory))
  } else if (Math.abs(now - Number(payload.iat)) > DPOP_SKEW_SECONDS) throw new DpopError("the DPoP proof's iat is too far from now: retry with the nonce given", await dpopNonce(input.memory))
  if (!(await input.memory.once(`dpop:${jkt}:${payload.jti}`, (DPOP_NONCE_SECONDS + DPOP_SKEW_SECONDS) * 1000))) throw new DpopError("this DPoP proof was already used")
  return jkt
}
