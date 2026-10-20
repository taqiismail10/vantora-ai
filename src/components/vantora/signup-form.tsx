"use client";

import { useState } from "react";
import Link from "next/link";
import { LoaderCircle, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

import { VantoraMark } from "./vantora-mark";

const MIN_PASSWORD = 12;

const INPUT =
  "h-9 w-full rounded-md border border-white/10 bg-white/5 px-3 text-sm text-white outline-none placeholder:text-white/20 focus-visible:border-[#cdf632]/50 focus-visible:ring-2 focus-visible:ring-[#cdf632]/20";

export function SignupForm({ configured }: { configured: boolean }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

  const submit = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(`Choose a password of at least ${MIN_PASSWORD} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.signUp.email({ email, password, name });
    if (failure) {
      setBusy(false);
      setError(
        failure.status === 429
          ? "Too many sign-up attempts from here. Wait a few minutes and try again."
          : (failure.message ?? "That account could not be created."),
      );
      return;
    }
    const { error: signInFailure } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (signInFailure) {
      setError("Your account was created, but signing in failed. Try signing in.");
      return;
    }
    // Full navigation on an identity change, as the sign-in form does.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full reload on an identity change
    window.location.assign("/onboarding");
  };

  if (!configured) {
    return (
      <div role="alert" className="w-full max-w-sm rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs leading-relaxed text-amber-200">
        <p className="font-medium">Accounts cannot be created on this server.</p>
        <p className="mt-1">
          Authentication is not configured. The owner must set <code className="font-mono">BETTER_AUTH_SECRET</code>{" "}
          (32+ characters). See the README.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm rounded-xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl">
      <div className="mb-5 flex items-center gap-2">
        <VantoraMark />
        <div>
          <h1 className="text-base font-semibold tracking-tight text-white">Create your account</h1>
          <p className="text-xs text-white/40">You will set up your company next.</p>
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <label className="flex flex-col gap-1 text-xs font-medium text-white/55">
          Your name
          <input className={INPUT} autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-white/55">
          Email
          <input type="email" className={INPUT} autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-white/55">
          Password
          <input
            type="password"
            className={INPUT}
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            aria-describedby="password-rule"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span
            id="password-rule"
            className={tooShort ? "text-[11px] text-amber-400" : "text-[11px] text-white/30"}
          >
            At least {MIN_PASSWORD} characters.
            {tooShort ? ` ${MIN_PASSWORD - password.length} more to go.` : ""}
          </span>
        </label>

        {error ? (
          <p role="alert" className="text-xs text-rose-400">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={busy || !email || !name || password.length < MIN_PASSWORD} className="mt-1">
          {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <UserPlus className="size-4" aria-hidden />}
          Create account
        </Button>

        <p className="text-[11px] text-white/50">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-white/75 underline">
            Sign in
          </Link>
        </p>

        <p className="text-[11px] leading-relaxed text-white/30">
          Your account starts with no company and no access to anyone else&apos;s data. This server sends no email, so
          there is nothing to verify — and password recovery is not available yet. If you lose your password, the
          server&apos;s operator has to re-provision the account.
        </p>
      </form>
    </div>
  );
}
