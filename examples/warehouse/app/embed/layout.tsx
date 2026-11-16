/**
 * Pages made to be framed by a host (MAP `url` pages, spec §5.1): no app chrome, a neutral background, compact. Who
 * looks is the caller of the host's sign-in ticket (`getEmbedCaller`, in each page), never the site's own session.
 */
export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-white p-3 text-sm">{children}</div>
}
