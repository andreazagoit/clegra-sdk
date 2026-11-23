import { ClegraSite, getClegraCaller } from "@clegra/sdk/next"
import type { Metadata } from "next"

import { warehouseApp } from "@/lib/app"

import "./globals.css"

export const metadata: Metadata = {
  title: { default: "Warehouse", template: "%s · Warehouse" },
  description: "Products, stock movements and orders of a small shop.",
}

// Shown as its site by a Clegra client (spec §5.1), the document starts in the client's theme and language (the
// caller's): no flash, no mismatch with what the bridge (<ClegraSite />) sets afterwards.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const caller = await getClegraCaller(warehouseApp)
  const theme = caller?.theme
  return (
    <html lang={caller?.locale ?? "en"} {...(theme ? { "data-theme": theme, className: theme === "dark" ? "dark" : undefined, style: { colorScheme: theme } } : {})}>
      <body>
        {children}
        <ClegraSite />
      </body>
    </html>
  )
}
