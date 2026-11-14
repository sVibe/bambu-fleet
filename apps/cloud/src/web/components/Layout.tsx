import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useMe } from "../api.ts";
import { cx } from "./ui.tsx";

const NAV = [
  { to: "/", label: "Fleet", end: true },
  { to: "/queue", label: "Queue" },
  { to: "/history", label: "History" },
  { to: "/parts", label: "Parts" },
  { to: "/analytics", label: "Materials" },
  { to: "/utilization", label: "Utilization" },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cx(
    "rounded-lg px-3 py-1.5 text-sm whitespace-nowrap",
    isActive ? "bg-wash font-medium text-ink" : "text-ink-2 hover:text-ink",
  );

export function Layout() {
  const me = useMe();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const links = me.data?.role === "admin" ? [...NAV, { to: "/admin", label: "Admin" }] : NAV;
  // A job page belongs under History, which links to it.
  const section = pathname.startsWith("/jobs/") ? "/history" : pathname;
  const current = links.find((l) => (l.end ? section === l.to : section.startsWith(l.to)));

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
          {/* Phones get the current page and a menu; seven links don't fit across. */}
          <span className="min-w-0 flex-1 truncate font-medium md:hidden">{current?.label}</span>
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-controls="nav-menu"
            onClick={() => setMenuOpen((open) => !open)}
            className="rounded-lg border border-hairline bg-raised px-3 py-1.5 text-sm md:hidden"
          >
            {menuOpen ? "Close" : "Menu"}
          </button>
          <nav className="-mx-1 hidden min-w-0 flex-1 gap-1 overflow-x-auto md:flex">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end} className={linkClass}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          {me.data && (
            <div className="hidden shrink-0 text-right text-xs leading-tight lg:block">
              <div className="text-ink">{me.data.email}</div>
              <div className="text-muted capitalize">{me.data.role}</div>
            </div>
          )}
        </div>
        {menuOpen && (
          <nav id="nav-menu" className="border-t border-hairline px-4 py-3 md:hidden">
            <div className="grid grid-cols-2 gap-1">
              {links.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.end}
                  className={linkClass}
                  onClick={() => setMenuOpen(false)}
                >
                  {l.label}
                </NavLink>
              ))}
            </div>
            {me.data && (
              <p className="mt-3 truncate px-3 text-xs text-muted">
                {me.data.email} · <span className="capitalize">{me.data.role}</span>
              </p>
            )}
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
