import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { VantoraDashboard } from "@/components/vantora/dashboard";
import { Landing } from "@/components/vantora/landing";
import { buildDashboardState, CompanyNotReadyError } from "@/lib/dashboard-data";
import { publicSignupEnabled } from "@/lib/server/auth";
import { companiesForUser } from "@/lib/server/companies";
import { AccessError, requireActor, requireSession } from "@/lib/server/identity";
import { BASELINE_SCENARIO } from "@/lib/server/plan";

export default function Home() {
  return (
    <Suspense fallback={<Booting />}>
      <Workspace />
    </Suspense>
  );
}

/**
 * One address, three audiences: a visitor gets the landing page, an account
 * with no usable company goes to onboarding, and everyone else gets the
 * dashboard. A real company with no account yet is a 409 from the builder,
 * which is onboarding's cue — not an error to show.
 */
async function Workspace() {
  // The forecast, the optimiser, the sandbox position and the audit chain are
  // all per-request state, so this subtree must never be prerendered.
  await connection();
  const incoming = await headers();
  const request = new Request("http://internal/", { headers: incoming });

  const session = await requireSession(request).catch(() => null);
  if (!session) return <Landing signupEnabled={publicSignupEnabled()} />;
  if (companiesForUser(session.userId).length === 0) redirect("/onboarding");

  let actor;
  try {
    actor = await requireActor(request, "read");
  } catch (error) {
    if (!(error instanceof AccessError)) throw error;
    if (error.status === 401) redirect("/login");
    if (error.status === 403) return <Blocked message={error.message} />;
    throw error;
  }

  let initial;
  try {
    initial = await buildDashboardState(actor, BASELINE_SCENARIO);
  } catch (error) {
    // Only "this company has nothing to forecast from yet" goes to onboarding.
    // Any other conflict is shown, because onboarding would not resolve it and
    // redirecting would bounce the owner between two screens.
    if (error instanceof CompanyNotReadyError) redirect("/onboarding");
    if (error instanceof AccessError) return <Blocked message={error.message} />;
    throw error;
  }

  // Keyed by account: the dashboard holds its first payload in state, so a
  // different signed-in user must get a fresh component, never a stale view.
  return <VantoraDashboard key={`${actor.userId}:${actor.businessId}`} initial={initial} />;
}

function Blocked({ message }: { message: string }) {
  return (
    <main className="flex flex-1 items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
      <div role="alert" className="max-w-md rounded-xl border border-amber-300 bg-white p-5 text-sm dark:border-amber-900 dark:bg-slate-900">
        <p className="font-medium">You are signed in, but cannot open this workspace.</p>
        <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">{message}</p>
      </div>
    </main>
  );
}

/** Shaped like the verdict bar, so the first paint already shows where the answer will be. */
function Booting() {
  return (
    <div className="flex flex-1 flex-col gap-4 bg-slate-50 p-4 dark:bg-slate-950" aria-busy="true">
      <p role="status" className="text-xs text-slate-500 dark:text-slate-400">
        Checking your session, then running the 1,000-path forecast and the recovery optimiser…
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        {["How short", "Decide by", "Cost to fix"].map((label) => (
          <div key={label} className="h-28 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
            <div className="mt-3 h-6 w-2/3 animate-pulse rounded bg-slate-200 motion-reduce:animate-none dark:bg-slate-800" />
            <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-slate-100 motion-reduce:animate-none dark:bg-slate-800" />
          </div>
        ))}
      </div>
    </div>
  );
}
