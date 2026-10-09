import { useState } from "react";
import { authStore, signOut } from "../lib/auth.ts";
import { useStore } from "../lib/hooks.ts";

export function Account() {
  const auth = useStore(authStore);
  const [busy, setBusy] = useState(false);
  if (auth.status !== "signedIn") return null;
  const { me } = auth;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-extrabold tracking-tight">Account</h1>
      <dl className="divide-y divide-white/10">
        {[
          ["Name", me.user.name],
          ["Email", me.user.email],
          ["School", me.school.name],
          ["Role", me.role === "head" ? "School head" : "Teacher"],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 py-3">
            <dt className="text-dim">{k}</dt>
            <dd className="text-right font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await signOut();
          } finally {
            setBusy(false);
          }
        }}
        className="min-h-12 rounded-xl border border-white/20 bg-white/5 px-5 font-semibold disabled:opacity-60"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
