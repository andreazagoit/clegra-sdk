import Link from "next/link"

import { companyNames, listContacts, type ListQuery } from "@/lib/crm"
import { formatDate } from "@/lib/format"
import { requireMember } from "@/lib/session"

import { Card, inputClass, Notice, PageTitle, param, secondaryButtonClass, Td, Th } from "../../_components/ui"
import { logCallAction } from "../actions"

export const metadata = { title: "Contacts" }

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const member = await requireMember()
  const sp = await searchParams
  const q = param(sp.q)?.trim() ?? ""
  const company = param(sp.company)?.trim() || undefined
  const query: ListQuery = { filters: company ? { company } : {}, ...(q ? { text: q, textFields: ["name", "email"] } : {}), sort: { field: "name", dir: "asc" }, limit: 200 }
  const contacts = await listContacts(member.orgId, query)
  const names = await companyNames(member.orgId, [...new Set(contacts.rows.map((c) => c.company))])
  const here = `/contacts${company || q ? `?${new URLSearchParams({ ...(company ? { company } : {}), ...(q ? { q } : {}) })}` : ""}`
  return (
    <>
      <PageTitle>Contacts</PageTitle>
      <Notice notice={param(sp.notice)} error={param(sp.error)} />
      <form className="mb-4 flex flex-wrap items-center gap-2" action="/contacts">
        <input name="q" defaultValue={q} placeholder="Search name or email" className={`${inputClass} w-64`} />
        {company ? <input type="hidden" name="company" value={company} /> : null}
        <button type="submit" className={secondaryButtonClass}>Search</button>
        {q || company ? <Link href="/contacts" className="text-zinc-500 hover:text-zinc-900">Clear</Link> : null}
      </form>
      <Card>
        <table className="w-full border-collapse">
          <thead>
            <tr><Th>Name</Th><Th>Email</Th><Th>Company</Th><Th>Last call</Th>{member.can("contacts.edit") ? <Th>Log a call</Th> : null}</tr>
          </thead>
          <tbody>
            {contacts.rows.map((c) => (
              <tr key={c.id} data-contact={c.id}>
                <Td className="font-medium">{c.name}</Td>
                <Td>{c.email}</Td>
                <Td>{names[c.company] ?? c.company}</Td>
                <Td>
                  {c.lastCall ? formatDate(c.lastCall) : <span className="text-zinc-400">Never</span>}
                  {c.lastNote ? <p className="text-xs text-zinc-500">{c.lastNote}</p> : null}
                </Td>
                {member.can("contacts.edit") ? (
                  <Td>
                    <form action={logCallAction.bind(null, c.id)} className="flex gap-2">
                      <input type="hidden" name="returnTo" value={here} />
                      <input name="note" required maxLength={500} placeholder="Note" className={`${inputClass} w-44`} aria-label={`Call note for ${c.name}`} />
                      <button type="submit" className={secondaryButtonClass}>Log</button>
                    </form>
                  </Td>
                ) : null}
              </tr>
            ))}
            {contacts.rows.length === 0 ? <tr><Td className="text-zinc-500">No contacts match.</Td></tr> : null}
          </tbody>
        </table>
      </Card>
    </>
  )
}
