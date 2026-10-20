"use client";

/**
 * Redeems a staff invitation link.
 *
 * The token lives in the URL, never in session storage or a cookie, so
 * signing in or out and coming back to the exact same link always works.
 * Acceptance itself is bound to the signed-in account's own email — the
 * server refuses it otherwise — so copying someone else's link grants
 * nothing.
 */

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CircleCheck, LoaderCircle } from "lucide-react";

import { SessionExpiredError } from "./client-api";
import { companyAction } from "./company-api";

export function AcceptInviteForm() {
  const token = useSearchParams().get("token") ?? "";
  // Computed once, from the URL that is already known at first render, so
  // the effect below never needs to set state synchronously in its body.
  const [state, setState] = useState<"need-auth" | "accepting" | "done" | "error">(token ? "accepting" : "error");
  const [error, setError] = useState<string | null>(token ? null : "This link is missing its invitation token.");
  // A ref, not a state flag: it must survive React's development-only
  // double-invocation of this effect (mount, cleanup, mount again) so the
  // request to burn this single-use token is sent at most once. Without
  // this, two concurrent requests can race — the server already refuses
  // the second as "already used" (correctly: the invitation grants access
  // exactly once), but a naive client would show that refusal to the user
  // even when their own first request was the one that succeeded.
  const requested = useRef(false);

  useEffect(() => {
    if (!token || requested.current) return;
    requested.current = true;
    let live = true;
    void companyAction<{ companyId: string }>("accept_invitation", { token })
      .then((result) => {
        if (!live) return;
        document.cookie = `vantora_company=${encodeURIComponent(result.companyId)}; path=/; SameSite=Lax; max-age=${60 * 60 * 24 * 365}`;
        setState("done");
      })
      .catch((cause) => {
        if (!live) return;
        if (cause instanceof SessionExpiredError) {
          setState("need-auth");
          return;
        }
        setState("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [token]);

  if (state === "done") {
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        <CircleCheck className="size-8 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <p className="text-sm text-slate-700 dark:text-slate-300">You now have access to this company.</p>
        <Link href="/" className="text-sm font-medium text-sky-700 hover:underline dark:text-sky-400">
          Go to the dashboard
        </Link>
      </div>
    );
  }

  if (state === "need-auth") {
    return (
      <div className="flex w-full max-w-sm flex-col gap-3 text-center">
        <p className="text-sm text-slate-700 dark:text-slate-300">
          Sign in or create an account with the email this invitation was sent to, then come back to this exact link.
        </p>
        <div className="flex justify-center gap-3 text-sm font-medium text-sky-700 dark:text-sky-400">
          <Link href="/login" className="hover:underline">
            Sign in
          </Link>
          <Link href="/signup" className="hover:underline">
            Create an account
          </Link>
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="w-full max-w-sm text-center">
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </p>
      </div>
    );
  }

  return (
    <p role="status" className="text-xs text-slate-500 dark:text-slate-400">
      <LoaderCircle className="mr-2 inline size-3.5 animate-spin" aria-hidden />
      Checking this invitation…
    </p>
  );
}
