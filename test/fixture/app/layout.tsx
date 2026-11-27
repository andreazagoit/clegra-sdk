import { ClegraSite } from "@clegra/sdk/next"

// The bridge: in a workspace client's frame it reports where the site is and applies the client's theme (spec §5.1).
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
