import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Navigate, useNavigate } from "react-router";
import { loginRequest } from "@schoolpulse/contracts";
import { ApiFailure, NetworkFailure, sessionExpired } from "../lib/api.ts";
import { authStore, signIn } from "../lib/auth.ts";
import { useStore } from "../lib/hooks.ts";
import { homeFor } from "../components/shell.tsx";
import type { z } from "zod";

const schema = loginRequest.pick({ email: true, password: true });
type Fields = z.infer<typeof schema>;

export function Login() {
  const auth = useStore(authStore);
  const expired = useStore(sessionExpired);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<Fields>({ resolver: zodResolver(schema) });

  if (auth.status === "signedIn" && !expired) return <Navigate to={homeFor(auth.me.role)} replace />;

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await signIn(values);
      const next = authStore.get();
      navigate(next.status === "signedIn" ? homeFor(next.me.role) : "/", { replace: true });
    } catch (e) {
      if (e instanceof NetworkFailure) setError("You are offline. Connect to the internet to sign in.");
      else if (e instanceof ApiFailure) setError(e.message);
      else setError(e instanceof Error ? e.message : "Could not sign in.");
    }
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">SchoolPulse</h1>
      <p className="mt-1 text-dim">Sign in with the email your school gave you.</p>

      <form onSubmit={onSubmit} noValidate className="mt-8 space-y-4">
        <div>
          <label htmlFor="email" className="text-sm font-semibold">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            className="mt-1 min-h-12 w-full rounded-xl border border-white/15 bg-white/5 px-3 text-base placeholder:text-dim/60"
            aria-invalid={formState.errors.email ? true : undefined}
            aria-describedby={formState.errors.email ? "email-error" : undefined}
            {...register("email")}
          />
          {formState.errors.email ? (
            <p id="email-error" className="mt-1 text-sm text-absent">
              Enter the email address you were registered with.
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="password" className="text-sm font-semibold">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            className="mt-1 min-h-12 w-full rounded-xl border border-white/15 bg-white/5 px-3 text-base"
            aria-invalid={formState.errors.password ? true : undefined}
            aria-describedby={formState.errors.password ? "password-error" : undefined}
            {...register("password")}
          />
          {formState.errors.password ? (
            <p id="password-error" className="mt-1 text-sm text-absent">
              Enter your password.
            </p>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="rounded-xl border border-absent/40 bg-absent/10 px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={formState.isSubmitting}
          className="min-h-12 w-full rounded-xl bg-violet text-base font-bold text-night disabled:opacity-60"
        >
          {formState.isSubmitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
