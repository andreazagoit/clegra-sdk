import { getClegraCaller } from "@clegra/sdk/next"
import Link from "next/link"

import { app } from "../../clegra"

// Who the site ticket signed in, or "signed out" (no ticket, a top-level visit, an expired session).
export const metadata = { title: "Board" }

export default async function Board() {
  const caller = await getClegraCaller(app)
  return (
    <>
      <p data-caller>{caller ? `${caller.person?.name} · ${caller.installation} · ${caller.can("notes.view") ? "notes.view" : "-"} · ${caller.theme ?? "-"} · ${caller.locale ?? "-"}` : "signed out"}</p>
      <Link href="/notes?status=open" data-next>
        Notes
      </Link>
    </>
  )
}
