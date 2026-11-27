import Link from "next/link"
import type { ReactNode } from "react"

import type { Permission } from "@/lib/permissions"
import { requireMember } from "@/lib/session"

import { secondaryButtonClass } from "../_components/ui"
import { signOutAction } from "./actions"

// Each page with the permission it needs: the navigation shows a person only what they may open.
const NAV: { id: string; href: string; label: string; permission?: Permission }[] = [
  { id: "pipeline", href: "/", label: "Pipeline", permission: "deals.view" },
  { id: "board", href: "/board", label: "Board", permission: "deals.view" },
  { id: "deals", href: "/deals", label: "Deals", permission: "deals.view" },
  { id: "companies", href: "/companies", label: "Companies" },
  { id: "contacts", href: "/contacts", label: "Contacts" },
]

export default async function CrmLayout({ children }: { children: ReactNode }) {
  const member = await requireMember()
  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="font-semibold tracking-tight">
            CRM <span className="font-normal text-zinc-500">· {member.organizationName}</span>
          </Link>
          <nav className="flex gap-4" data-site-nav>
            {NAV.filter((item) => (!item.permission || member.can(item.permission))).map((item) => (
              <Link key={item.href} href={item.href} className="text-zinc-600 hover:text-zinc-900" data-testid={`nav-${item.id}`}>
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-zinc-600">
              {member.user.name} <span className="text-zinc-400">({member.role})</span>
            </span>
            <form action={signOutAction}>
              <button type="submit" className={secondaryButtonClass}>Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}
