"use client";

import { useState } from "react";
import Link from "next/link";
import { KeyRound, Loader2, LockKeyhole } from "lucide-react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

const REASONS: Record<string, string> = {
  expired: "Your session expired. Sign in again to continue.",
  signed_out: "You have signed out.",
  demo: "Sign in to open the Smart Jeans demonstration. Its figures are invented and it is read-only.",
};

export function LoginForm({ configured, reason }: { configured: boolean; reason: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (failure) {
      setError(
        failure.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : "That email and password do not match an account.",
      );
      return;
    }
    // A full navigation, not a client transition: the router cache must never
    // show a previous user's workspace to the account that just signed in.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full reload on an identity change
    window.location.assign("/");
  };

  return (
    <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-5 flex items-center gap-2">
        <LockKeyhole className="size-5 text-slate-700 dark:text-slate-300" aria-hidden />
        <div>
          <h1 className="text-base font-semibold tracking-tight">Vantora AI</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">Sandbox treasury copilot</p>
        </div>
      </div>

      {reason && REASONS[reason] ? (
        <p role="status" className="mb-4 rounded-md border border-sky-200 bg-sky-50 p-2.5 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
          {REASONS[reason]}
        </p>
      ) : null}

      {!configured ? (
        <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">Sign-in is not configured on this server.</p>
          <p className="mt-1">
            The owner must set <code className="font-mono">BETTER_AUTH_SECRET</code> (32+ characters). Accounts can
            then be created from the sign-up page, or with <code className="font-mono">npm run users</code>. See the
            README.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          {error ? (
            <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={busy || !email || !password} className="mt-1">
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}
            Sign in
          </Button>
          <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            No account yet?{" "}
            <Link href="/signup" className="font-medium underline">
              Create one
            </Link>
            . A new account sets up its own company and can see nobody else&apos;s data. Staff accounts are added by the
            company owner, who sets the role (Owner, Analyst or Viewer). Sessions last 8 hours, and password recovery is
            not available on this server.
          </p>
        </form>
      )}
    </div>
  );
}
