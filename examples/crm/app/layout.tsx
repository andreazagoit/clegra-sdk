import { ClegraSite, getClegraCaller } from "@clegra/sdk/next"
import type { Metadata } from "next"
import type { ReactNode } from "react"

import { crmApp } from "@/clegra"

import "./globals.css"

export const metadata: Metadata = { title: { default: "CRM", template: "%s · CRM" }, description: "Companies, contacts and deals of a small sales team." }

// Shown as its site by a Clegra client (spec §5.1), the document starts in the client's theme and language (the
// caller's): no flash, no mismatch with what the bridge (<ClegraSite />) sets afterwards.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const caller = await getClegraCaller(crmApp)
  const theme = caller?.theme
  return (
    <html lang={caller?.locale ?? "en"} {...(theme ? { "data-theme": theme, className: theme === "dark" ? "dark" : undefined, style: { colorScheme: theme } } : {})}>
      <body className="min-h-screen text-sm antialiased">
        {children}
        <ClegraSite />
      </body>
    </html>
  )
}
