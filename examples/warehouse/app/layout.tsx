import type { Metadata } from "next"

import "./globals.css"

export const metadata: Metadata = {
  title: { default: "Warehouse", template: "%s · Warehouse" },
  description: "Products, stock movements and orders of a small shop.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
