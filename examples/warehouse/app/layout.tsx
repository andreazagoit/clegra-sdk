import { ClegraSite } from "@clegra/sdk/next"
import type { Metadata } from "next"

import "./globals.css"

export const metadata: Metadata = {
  title: { default: "Warehouse", template: "%s · Warehouse" },
  description: "Products, stock movements and orders of a small shop.",
}

// Shown as its site in a workspace client's frame (spec §5.1), the bridge (<ClegraSite />) tells the client where the
// person is and takes the client's theme.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ClegraSite />
      </body>
    </html>
  )
}
