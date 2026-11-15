"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const path = usePathname()
  const active = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`)
  return (
    <Link href={href} className={`rounded-md px-2.5 py-1.5 text-sm ${active ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-200 hover:text-stone-900"}`} aria-current={active ? "page" : undefined}>
      {children}
    </Link>
  )
}
