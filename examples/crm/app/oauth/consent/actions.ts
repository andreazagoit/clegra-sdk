"use server"
import { headers } from "next/headers"

import { auth } from "@/lib/auth"
import { authRequest, followOAuth } from "@/lib/oauth-pages"

/** The person's answer on the consent page: better-auth sends them back to the client, with a code or `access_denied`. */
export async function consentAction(oauthQuery: string, accept: boolean) {
  const requestHeaders = await headers()
  const response = await auth().api.oauth2Consent({ body: { accept, oauth_query: oauthQuery }, headers: requestHeaders, request: authRequest("/oauth2/consent", requestHeaders), asResponse: true })
  await followOAuth(response)
}
