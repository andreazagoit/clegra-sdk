import { ClegraSite, getClegraCaller } from "@clegra/sdk/next"

import { app } from "../clegra"

// In a Clegra client the document starts in the client's theme and language (the caller's): no flash, no mismatch
// with what the bridge sets (spec §5.1 step 8).
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const caller = await getClegraCaller(app)
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
