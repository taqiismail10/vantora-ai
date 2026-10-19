"use client";

/**
 * Self-service sign-up.
 *
 * A new account is a member of no company until it creates one, so registering
 * grants access to nothing. There is no email delivery wired up on this
 * server, so this form never claims a message was sent or an address verified.
 */

import { useState } from "react";
import Link from "next/link";
import { Loader2, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

const MIN_PASSWORD = 12;

const INPUT =
  "h-9 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950";

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
      <div role="alert" className="w-full max-w-sm rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="font-medium">Accounts cannot be created on this server.</p>
        <p className="mt-1">
          Authentication is not configured. The owner must set <code className="font-mono">BETTER_AUTH_SECRET</code>{" "}
          (32+ characters). See the README.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-5 flex items-center gap-2">
        <UserPlus className="size-5 text-slate-700 dark:text-slate-300" aria-hidden />
        <div>
          <h1 className="text-base font-semibold tracking-tight">Create your account</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">You will set up your company next.</p>
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Your name
          <input className={INPUT} autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Email
          <input type="email" className={INPUT} autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
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
            className={tooShort ? "text-[11px] text-amber-700 dark:text-amber-400" : "text-[11px] text-slate-500 dark:text-slate-400"}
          >
            At least {MIN_PASSWORD} characters.
            {tooShort ? ` ${MIN_PASSWORD - password.length} more to go.` : ""}
          </span>
        </label>

        {error ? (
          <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={busy || !email || !name || password.length < MIN_PASSWORD} className="mt-1">
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UserPlus className="size-4" aria-hidden />}
          Create account
        </Button>

        <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          Your account starts with no company and no access to anyone else&apos;s data. This server sends no email, so
          there is nothing to verify — and password recovery is not available yet. If you lose your password, the
          server&apos;s operator has to re-provision the account.
        </p>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          Already have an account?{" "}
          <Link href="/login" className="font-medium underline">
            Sign in
          </Link>
          .
        </p>
      </form>
    </div>
  );
}
