/**
 * Shared frame and token handling for the two screens a person reaches from a link without being signed in.
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { buttonClass, Notice } from "../components/ui.tsx";
import { describeLinkProblem } from "../lib/staff-forms.ts";
import { takeLinkToken, type LinkKind } from "../lib/link-token.ts";

export function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Reads the token once from the address, remembers it for this tab, and takes it out of the address bar. */
export function useLinkToken(kind: LinkKind): string | null {
  const [token] = useState(() => {
    const taken = takeLinkToken(kind, window.location.hash, sessionStorageOrNull());
    if (taken.scrub) window.history.replaceState(null, "", window.location.pathname);
    return taken.token;
  });
  return token;
}

export function LinkPage({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-10">
      <p className="text-sm font-semibold text-dim">SchoolPulse</p>
      <h1 className="mt-1 text-3xl font-extrabold tracking-tight">{title}</h1>
      {intro ? <p className="mt-1 text-dim">{intro}</p> : null}
      <div className="mt-6 space-y-4">{children}</div>
    </main>
  );
}

/** A link that cannot be used: what happened, what to do next, and a way to sign in if that is the answer. */
export function LinkEnded({ code, purpose }: { code: string | undefined; purpose: "invitation" | "reset" }) {
  const p = describeLinkProblem(code, purpose);
  return (
    <>
      <Notice tone="warn"><strong>{p.title}.</strong> {p.body}</Notice>
      <Link to="/login" className={buttonClass("secondary")}>Go to sign in</Link>
    </>
  );
}
