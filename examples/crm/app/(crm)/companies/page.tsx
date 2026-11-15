import Link from "next/link"

import { INDUSTRIES, listCompanies, type ListQuery } from "@/lib/crm"
import { INDUSTRY_LABELS } from "@/lib/format"
import { requireMember } from "@/lib/session"

import { Card, inputClass, PageTitle, param, secondaryButtonClass, Td, Th } from "../../_components/ui"

export const metadata = { title: "Companies" }

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const member = await requireMember()
  const sp = await searchParams
  const q = param(sp.q)?.trim() ?? ""
  const industry = INDUSTRIES.find((i) => i === param(sp.industry))
  const query: ListQuery = { filters: industry ? { industry } : {}, ...(q ? { text: q, textFields: ["name"] } : {}), sort: { field: "name", dir: "asc" }, limit: 200 }
  const companies = await listCompanies(member.orgId, query)
  return (
    <>
      <PageTitle>Companies</PageTitle>
      <form className="mb-4 flex flex-wrap items-center gap-2" action="/companies">
        <input name="q" defaultValue={q} placeholder="Search companies" className={`${inputClass} w-64`} />
        <select name="industry" defaultValue={industry ?? ""} className={inputClass} aria-label="Industry">
          <option value="">All industries</option>
          {INDUSTRIES.map((i) => (
            <option key={i} value={i}>{INDUSTRY_LABELS[i]}</option>
          ))}
        </select>
        <button type="submit" className={secondaryButtonClass}>Filter</button>
        {q || industry ? <Link href="/companies" className="text-zinc-500 hover:text-zinc-900">Clear</Link> : null}
      </form>
      <Card>
        <table className="w-full border-collapse">
          <thead>
            <tr><Th>Name</Th><Th>City</Th><Th>Industry</Th><Th /></tr>
          </thead>
          <tbody>
            {companies.rows.map((c) => (
              <tr key={c.id} data-company={c.id}>
                <Td className="font-medium">{c.name}</Td>
                <Td>{c.city}</Td>
                <Td>{INDUSTRY_LABELS[c.industry]}</Td>
                <Td className="text-right">
                  <Link href={`/contacts?company=${c.id}`} className="text-zinc-500 hover:text-zinc-900">Contacts</Link>
                </Td>
              </tr>
            ))}
            {companies.rows.length === 0 ? <tr><Td className="text-zinc-500">No companies match.</Td></tr> : null}
          </tbody>
        </table>
      </Card>
    </>
  )
}
