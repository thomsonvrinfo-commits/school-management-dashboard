import { NavLink, Navigate, Outlet, useLocation } from "react-router";
import type { Role } from "@schoolpulse/domain";
import { sessionExpired } from "../lib/api.ts";
import { authStore } from "../lib/auth.ts";
import { loadQueue } from "../lib/sync-engine.ts";
import { useLive, useStore } from "../lib/hooks.ts";
import { SyncBadge } from "./sync-badge.tsx";

const NAV: Record<Role, { to: string; label: string }[]> = {
  teacher: [
    { to: "/today", label: "Today" },
    { to: "/sync", label: "Sync" },
    { to: "/account", label: "Account" },
  ],
  head: [
    { to: "/overview", label: "Overview" },
    { to: "/account", label: "Account" },
  ],
};

export const homeFor = (role: Role) => (role === "teacher" ? "/today" : "/overview");

/** Everything behind sign-in. The server still enforces every permission; this only keeps the screens tidy. */
export function RequireAuth() {
  const auth = useStore(authStore);
  const expired = useStore(sessionExpired);
  const location = useLocation();
  const needsAttention = useLive(async () => (await loadQueue()).filter((q) => q.status === "conflict" || q.status === "failed").length, [], 0);

  if (auth.status === "loading") return <p className="p-6 text-dim">Opening SchoolPulse…</p>;
  if (auth.status === "signedOut") return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  const { me } = auth;
  const wide = me.role === "head";
  return (
    <div className="mx-auto flex min-h-dvh flex-col" style={{ maxWidth: wide ? "56rem" : "30rem" }}>
      <header className="glass sticky top-0 z-20 flex items-center justify-between gap-3 border-b px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <p className="truncate text-sm font-semibold">{me.school.name}</p>
        {me.role === "teacher" ? <SyncBadge /> : null}
      </header>

      {expired ? (
        <div role="alert" className="mx-4 mt-3 rounded-xl border border-late/40 bg-late/10 px-4 py-3 text-sm">
          <p className="font-semibold">Your sign-in has expired.</p>
          <p className="mt-0.5 text-dim">Your work is safe on this phone. Sign in again to send it to the school.</p>
          <NavLink to="/login" className="mt-2 inline-block min-h-11 py-2.5 font-semibold text-violet underline">
            Sign in again
          </NavLink>
        </div>
      ) : null}

      <main className="flex-1 px-4 pb-32 pt-5">
        <Outlet />
      </main>

      <nav aria-label="Main" className="glass fixed inset-x-0 bottom-0 z-20 border-t pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <ul className="mx-auto flex" style={{ maxWidth: wide ? "56rem" : "30rem" }}>
          {NAV[me.role].map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  `relative flex min-h-14 items-center justify-center text-sm font-semibold ${isActive ? "text-violet" : "text-dim"}`
                }
              >
                {item.label}
                {item.to === "/sync" && needsAttention > 0 ? (
                  <span className="ml-1.5 inline-flex size-5 items-center justify-center rounded-full bg-absent text-xs font-bold text-night" aria-label={`${needsAttention} need attention`}>
                    {needsAttention}
                  </span>
                ) : null}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

export function RequireRole({ role, children }: { role: Role; children: React.ReactNode }) {
  const auth = useStore(authStore);
  if (auth.status !== "signedIn") return null;
  if (auth.me.role !== role) return <Navigate to={homeFor(auth.me.role)} replace />;
  return <>{children}</>;
}
