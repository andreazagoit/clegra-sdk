import { ClegraSite } from "@clegra/sdk/next"
import type { Metadata } from "next"
import type { ReactNode } from "react"

import "./globals.css"

export const metadata: Metadata = { title: { default: "CRM", template: "%s · CRM" }, description: "Companies, contacts and deals of a small sales team." }

// Shown as its site in a workspace client's frame (spec §5.1), the bridge (<ClegraSite />) tells the client where the
// person is and takes the client's theme.
export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen text-sm antialiased">
        {children}
        <ClegraSite />
      </body>
    </html>
  )
}
