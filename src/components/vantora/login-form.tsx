"use client";

import { useState } from "react";
import Link from "next/link";
import { KeyRound, LoaderCircle } from "lucide-react";

import { VantoraMark } from "./vantora-mark";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

const REASONS: Record<string, string> = {
  expired: "Your session expired. Sign in again to continue.",
  signed_out: "You have signed out.",
  demo: "Sign in to open the Smart Jeans demonstration. Its figures are invented and it is read-only.",
};

const INPUT =
  "h-9 rounded-md border border-white/10 bg-white/5 px-3 text-sm text-white outline-none placeholder:text-white/20 focus-visible:border-[#cdf632]/50 focus-visible:ring-2 focus-visible:ring-[#cdf632]/20";

export function LoginForm({
  configured,
  signupEnabled,
  reason,
}: {
  configured: boolean;
  signupEnabled: boolean;
  reason: string | null;
}) {
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
    <div className="w-full max-w-sm rounded-xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl">
      <div className="mb-5 flex items-center gap-2">
        <VantoraMark />
        <div>
          <h1 className="text-base font-semibold tracking-tight text-white">Welcome back</h1>
          <p className="text-xs text-white/40">Sandbox treasury copilot</p>
        </div>
      </div>

      {reason && REASONS[reason] ? (
        <p role="status" className="mb-4 rounded-md border border-white/10 bg-white/5 p-2.5 text-xs text-white/60">
          {REASONS[reason]}
        </p>
      ) : null}

      {!configured ? (
        <div role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
          <p className="font-medium">Sign-in is not configured on this server.</p>
          <p className="mt-1">
            The owner must set <code className="font-mono">BETTER_AUTH_SECRET</code> (32+ characters). Accounts can
            then be created from the sign-up page, or with <code className="font-mono">npm run users</code>. See the
            README.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <label className="flex flex-col gap-1 text-xs font-medium text-white/55">
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={INPUT}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-white/55">
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={INPUT}
            />
          </label>
          {error ? (
            <p role="alert" className="text-xs text-rose-400">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={busy || !email || !password} className="mt-1">
            {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}
            Continue
          </Button>
          {/* The transition to the other flow sits directly under the
              submit button. When the server has public sign-up switched
              off ("VANTORA_PUBLIC_SIGNUP=off"), the route would only bounce
              back here, so the state is explained instead of linking. */}
          {signupEnabled ? (
            <p className="text-[11px] text-white/50">
              Don&apos;t have an account?{" "}
              <Link href="/signup" className="font-medium text-white/75 underline">
                Sign up
              </Link>
            </p>
          ) : (
            <p className="text-[11px] text-white/50">
              Sign-up is off on this server. Accounts are provisioned by the business owner.
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-white/30">
            A new account sets up its own company and can see nobody else&apos;s data. Staff accounts are added by the
            company owner, who sets the role (Owner, Analyst or Viewer). Sessions last 8 hours, and password recovery is
            not available on this server.
          </p>
        </form>
      )}
    </div>
  );
}
