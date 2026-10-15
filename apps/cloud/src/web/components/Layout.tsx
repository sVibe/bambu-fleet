import { NavLink, Outlet } from "react-router";
import { useMe } from "../api.ts";
import { cx } from "./ui.tsx";

const NAV = [
  { to: "/", label: "Fleet", end: true },
  { to: "/queue", label: "Queue" },
  { to: "/history", label: "History" },
  { to: "/parts", label: "Parts" },
  { to: "/analytics", label: "Materials" },
];

export function Layout() {
  const me = useMe();
  const links = me.data?.role === "admin" ? [...NAV, { to: "/admin", label: "Admin" }] : NAV;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-hairline bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:gap-6 sm:px-6">
          <NavLink to="/" className="flex shrink-0 items-center gap-2 font-semibold">
            <span
              aria-hidden
              className="grid size-7 place-items-center rounded-lg bg-accent text-sm text-white"
            >
              B
            </span>
            <span className="hidden sm:inline">Bambu Fleet</span>
          </NavLink>
          <nav className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                className={({ isActive }) =>
                  cx(
                    "rounded-lg px-3 py-1.5 text-sm whitespace-nowrap",
                    isActive ? "bg-wash font-medium text-ink" : "text-ink-2 hover:text-ink",
                  )
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          {me.data && (
            <div className="hidden shrink-0 text-right text-xs leading-tight md:block">
              <div className="text-ink">{me.data.email}</div>
              <div className="text-muted capitalize">{me.data.role}</div>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
