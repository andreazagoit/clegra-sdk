import type { Metadata } from "next"
import type { ReactNode } from "react"

import "./globals.css"

export const metadata: Metadata = { title: { default: "CRM", template: "%s · CRM" }, description: "Companies, contacts and deals of a small sales team." }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen text-sm antialiased">{children}</body>
    </html>
  )
}
