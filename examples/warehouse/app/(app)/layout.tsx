import { signOutAction } from "@/app/actions"
import { NavLink } from "@/components/nav-link"
import { requireViewer } from "@/lib/session"

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireViewer()
  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold">Warehouse</span>
            <span className="text-sm text-stone-500">{viewer.orgName}</span>
          </div>
          <nav className="flex flex-wrap gap-1">
            <NavLink href="/">Dashboard</NavLink>
            <NavLink href="/products">Products</NavLink>
            <NavLink href="/stock">Stock board</NavLink>
            <NavLink href="/movements">Movements</NavLink>
            {viewer.can("orders.view") ? <NavLink href="/orders">Orders</NavLink> : null}
          </nav>
          <form action={signOutAction} className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-stone-600">
              {viewer.name} <span className="text-stone-400">· {viewer.role}</span>
            </span>
            {/* Shown by a Clegra client, the person signs in and out there. */}
            {viewer.via === "warehouse" ? (
              <button type="submit" className="text-stone-500 hover:text-stone-900">
                Sign out
              </button>
            ) : null}
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}
