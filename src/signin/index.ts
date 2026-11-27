// `@clegra/sdk/signin`: the app's own sign-in (module.ts), its development form (dev.ts), the password login, stores.
export {
  AUTHORIZE_PATH,
  createSignIn,
  JWKS_PATH,
  newSignInKey,
  OFFLINE_SCOPE,
  PERSONAL_KEY_PREFIX,
  pkceChallenge,
  REVOKE_PATH,
  TOKEN_PATH,
  type Login,
  type PersonalKey,
  type SignIn,
  type SignInAccount,
  type SignInApp,
  type SignInLink,
  type SignInOptions,
} from "./module"
export { DEV_CODE_ATTEMPTS, DEV_ISSUER, devSignIn, HOST_TOKEN_SECONDS, type DevCaller, type DevPerson, type DevSignInOptions, type DevTools } from "./dev"
export { MemorySignInStore, SqlSignInStore, type SignInStore } from "./store"
export { base64url, hashPassword, verifyPassword } from "../crypto"
export { passwordLogin, type PasswordAccount, type PasswordLogin, type PasswordLoginOptions } from "./password"
export { frameCookie } from "./cookies"
