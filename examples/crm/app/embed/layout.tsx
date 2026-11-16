import type { ReactNode } from "react"

// Pages made to be framed by a host (app `url` pages): no app chrome, compact.
export default function EmbedLayout({ children }: { children: ReactNode }) {
  return <div className="p-3 text-[13px]">{children}</div>
}
