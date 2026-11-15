"use server"
import { headers } from "next/headers"

import { answerConsent } from "@/lib/sign-in"

/** The person's answer on the consent page: better-auth sends them back to the client, with a code or `access_denied`. */
export async function consentAction(oauthQuery: string, accept: boolean) {
  await answerConsent(oauthQuery, accept, await headers())
}
