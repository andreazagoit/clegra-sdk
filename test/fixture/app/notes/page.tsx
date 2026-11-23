import { getClegraCaller } from "@clegra/sdk/next"

import { app } from "../../clegra"

export const metadata = { title: "Notes" }

export default async function Notes() {
  const caller = await getClegraCaller(app)
  return <p data-notes>{caller ? `notes for ${caller.person?.name}` : "signed out"}</p>
}
