"use client";

/**
 * The five-second verdict.
 *
 * Everything below this bar is evidence. This is the answer: what is wrong,
 * when it bites, and what it costs to fix. It is the only place on the screen
 * allowed to use a large rose number, so that number always means "shortfall"
 * and never "this cell is important".
 */

import { ArrowRight, Ban, CalendarClock, CheckCircle2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { DashboardState } from "@/lib/dashboard-state";
import { cn } from "@/lib/utils";

import { dayDate } from "./dates";
import { crunchDayIndex, useMoney } from "./primitives";

/** "2:00 PM" is the payroll bureau's file-lock time, not a computed value. */
const PAYROLL_LOCK_TIME = "2:00 PM";

function Column({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 px-4 py-3", className)}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
        {label}
      </div>
      {children}
    </div>
  );
}

export function VerdictBar({
  data,
  onReviewPlan,
}: {
  data: DashboardState;
  onReviewPlan: () => void;
}) {
  const { money, money2 } = useMoney();
  const { forecast, optimization: o, state } = data;
  const band = data.profile.alert_band;

  if (band === "GREEN") {
    const minP10 = Math.min(...forecast.p10_trajectory);
    const multiple = state.minimum_safe_buffer > 0 ? minP10 / state.minimum_safe_buffer : 0;
    return (
      <section
        aria-label="Executive verdict"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-emerald-200 bg-emerald-50/70 px-4 py-3 dark:border-emerald-900 dark:bg-emerald-950/30"
      >
        <CheckCircle2 className="size-5 shrink-0 text-emerald-700 dark:text-emerald-400" />
        <span className="text-xl font-semibold tabular-nums tracking-tight text-emerald-700 dark:text-emerald-300">
          {money(0)} shortfall across {forecast.horizon_days} days
        </span>
        <span className="text-xs text-emerald-800/80 dark:text-emerald-300/80">
          Min P10 <span className="font-medium tabular-nums">{money(minP10)}</span> (
          <span className="tabular-nums">{multiple.toFixed(1)}×</span> safe buffer) · No recovery action
          required
        </span>
      </section>
    );
  }

  if (band === "BLACK") {
    const headroom = o.matched_financing_options
      .filter((m) => m.eligible)
      .reduce((sum, m) => sum + m.max_available, 0);
    return (
      <section
        aria-label="Executive verdict"
        className="rounded-md border border-slate-900 bg-slate-900 px-4 py-3 text-slate-100 dark:border-slate-100/20"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Ban className="size-5 shrink-0 text-rose-400" />
          <span className="text-sm font-semibold uppercase tracking-[0.12em] text-rose-400">
            Infeasible via short-term levers
          </span>
          <span className="text-xl font-semibold tabular-nums tracking-tight">
            {money(o.required_cash)} day-{o.crunch_day} gap
          </span>
          <span className="text-xs text-slate-300">
            exceeds <span className="font-medium tabular-nums">{money(headroom)}</span> maximum available
            headroom
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
          Vantora refuses to originate predatory bridge debt into a gap it cannot close. Escalate to a bank
          workout or an equity cure.
        </p>
      </section>
    );
  }

  // RED: the three questions a distressed owner actually has.
  const crunchDay = forecast.first_shortfall_day ?? o.crunch_day;
  const crunchP10 = forecast.p10_trajectory[crunchDayIndex(crunchDay)];
  const crunchPayables = state.payables_ap.filter((p) => p.due_day === crunchDay);
  // The declared bank file-lock day wins over the engine's generic 72h rule:
  // the deadline is set by the payroll bureau's cutoff, not by a convention.
  const decisionDay =
    state.payables_ap.find((p) => p.is_payroll)?.payroll_lock_day ??
    forecast.decision_day ??
    Math.max(1, crunchDay - 3);
  const asOf = data.scenario.as_of_date;
  // Two different deficits, stated separately: below zero means the bills that
  // day cannot all be paid; below the buffer means the plant is running
  // without its operating cushion.
  const deficitToZero = Math.max(0, -crunchP10);
  const cash = data.cost_breakdown.cash_cents / 100;
  const risk = data.cost_breakdown.risk_cents / 100;
  const curve = data.procrastination_curve;
  const firstDearer = curve.find((p) => p.feasible && p.total_cost !== null && p.total_cost > o.optimal_plan.total_cost + 0.005);
  const lastFeasible = [...curve].reverse().find((p) => p.feasible);
  const firstInfeasible = curve.find((p) => !p.feasible);

  return (
    <section
      aria-label="Executive verdict"
      className="grid divide-y divide-slate-200 rounded-md border border-slate-300 bg-white dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-950 lg:grid-cols-3 lg:divide-x lg:divide-y-0"
    >
      <Column label="How short">
        {deficitToZero > 0 ? (
          <>
            <div className="text-3xl font-semibold tabular-nums tracking-tight text-rose-600 dark:text-rose-400">
              {money(deficitToZero)} short on day {crunchDay}
            </div>
            <div className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
              Projected (P10) cash falls to <span className="font-medium tabular-nums">{money(crunchP10)}</span> on{" "}
              {dayDate(asOf, crunchDay)}: the bills due that day cannot all be paid. Keeping the{" "}
              {money(state.minimum_safe_buffer)} operating buffer needs{" "}
              <span className="font-medium tabular-nums">{money(o.required_cash)}</span>. Ledger cash on the as-of
              date {money(state.current_cash)}.
              {data.execution.has_position ? (
                <span className="mt-1 block text-sky-800 dark:text-sky-300">
                  This is the diagnosis before any sandbox action. Now: {money(data.execution.account.cash_cents / 100)} settled
                  cash; day-{crunchDay} P10 projects to{" "}
                  {data.execution.projected_p10_at_crunch !== null ? money(data.execution.projected_p10_at_crunch) : "—"} if
                  pending counterparties respond as planned (see the execution queue).
                </span>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className="text-3xl font-semibold tabular-nums tracking-tight text-amber-700 dark:text-amber-400">
              {money(o.required_cash)} below buffer on day {crunchDay}
            </div>
            <div className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
              Projected (P10) cash stays positive at <span className="font-medium tabular-nums">{money(crunchP10)}</span>{" "}
              on {dayDate(asOf, crunchDay)}, but under the {money(state.minimum_safe_buffer)} operating buffer.
            </div>
          </>
        )}
      </Column>

      <Column label="Decide by">
        <div className="flex items-center gap-2 text-lg font-semibold tracking-tight text-amber-700 dark:text-amber-400">
          <CalendarClock className="size-4 shrink-0" aria-hidden />
          <span className="tabular-nums">
            {dayDate(asOf, decisionDay)}, {PAYROLL_LOCK_TIME} · day {decisionDay}
          </span>
        </div>
        <div className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
          The payroll bank file locks {crunchDay - decisionDay} days before the day-{crunchDay} run (
          {crunchPayables
            .map((p) => `${money(p.amount)} ${p.is_payroll ? "payroll" : p.supplier_name.split(" (")[0]}`)
            .join(" + ")}
          ).
        </div>
        <ul className="mt-0.5 flex flex-col gap-0.5 text-[11px] leading-relaxed text-slate-700 dark:text-slate-300">
          {firstDearer ? (
            <li>
              Waiting until day {firstDearer.day_waited} costs{" "}
              <span className="font-medium tabular-nums">
                +{money2((firstDearer.total_cost ?? 0) - o.optimal_plan.total_cost)}
              </span>{" "}
              ({firstDearer.expired_lever} closes).
            </li>
          ) : null}
          {lastFeasible && lastFeasible.day_waited > 0 ? (
            <li>
              Day {lastFeasible.day_waited} is the last point a plan still exists (
              <span className="tabular-nums">{money2(lastFeasible.total_cost ?? 0)}</span>).
            </li>
          ) : null}
          {firstInfeasible ? <li>From day {firstInfeasible.day_waited}, nothing can fund in time.</li> : null}
        </ul>
      </Column>

      <Column label="Cost to fix">
        <div className="flex flex-wrap items-baseline gap-2">
          <span
            className="text-3xl font-semibold tabular-nums tracking-tight text-emerald-700 dark:text-emerald-400"
            title="Fees, discounts and interest actually paid"
          >
            {money2(cash)}
          </span>
          <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">in cash</span>
        </div>
        <div className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
          {risk > 0 ? (
            <>
              plus a <span className="font-medium tabular-nums">{money2(risk)}</span> modelled relationship-risk
              charge — not money that leaves the account (solver objective{" "}
              <span className="tabular-nums">{money2(o.optimal_plan.total_cost)}</span>).{" "}
            </>
          ) : null}
          Restores day-{crunchDay} P10 to{" "}
          <span className="font-medium tabular-nums">{money(o.optimal_plan.post_recovery_p10_balance)}</span>
          {o.baseline_do_nothing_plan.breaches_statutory_payroll ? " and avoids a statutory payroll breach." : "."}
        </div>
        <Button size="sm" onClick={onReviewPlan} className="mt-1 w-fit text-[11px]">
          Review the plan
          <ArrowRight className="size-3.5" aria-hidden />
        </Button>
      </Column>
    </section>
  );
}

const STEPS = ["Understand", "Choose a plan", "Approve", "Track"] as const;

/**
 * Where the owner is in the journey, derived from real state: the plan exists,
 * how many actions are approved or submitted, and how many counterparties have
 * answered. Shown under the verdict on every tab.
 */
export function ProgressRail({ data, onNavigate }: { data: DashboardState; onNavigate: (tab: string) => void }) {
  const actions = data.execution.actions;
  const submitted = actions.filter((a) => !["PROPOSED", "APPROVED"].includes(a.status));
  const answered = submitted.filter((a) => ["ACCEPTED", "SETTLED", "DECLINED", "FAILED"].includes(a.status));
  const proposed = actions.filter((a) => a.status === "PROPOSED" || a.status === "APPROVED");
  const hasPlan = data.optimization.optimal_plan.feasible && data.optimization.optimal_plan.actions.length > 0;
  if (!hasPlan && !submitted.length) return null;

  const current = !submitted.length ? 2 : proposed.length ? 2 : 3;
  const details = [
    `day-${data.optimization.crunch_day} gap found`,
    `${data.optimization.optimal_plan.actions.length} actions priced`,
    proposed.length ? `${proposed.length} to approve` : `${submitted.length} submitted`,
    submitted.length ? `${answered.length} of ${submitted.length} counterparties answered` : "nothing sent yet",
  ];
  const tabs = ["liquidity", "optimizer", "copilot", "copilot"];

  return (
    <nav aria-label="Recovery progress" className="rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-950">
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STEPS.map((step, index) => {
          const state = index < current ? "done" : index === current ? "current" : "todo";
          return (
            <li key={step}>
              <button
                type="button"
                onClick={() => onNavigate(tabs[index])}
                aria-current={state === "current" ? "step" : undefined}
                className={cn(
                  "flex w-full items-start gap-2 rounded px-1.5 py-1 text-left focus-visible:outline-2 focus-visible:outline-sky-500",
                  state === "current" && "bg-sky-50 dark:bg-sky-950/40",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-[9px] font-semibold",
                    state === "done" && "border-emerald-500 bg-emerald-500 text-white",
                    state === "current" && "border-sky-600 text-sky-700 dark:text-sky-300",
                    state === "todo" && "border-slate-300 text-slate-500",
                  )}
                  aria-hidden
                >
                  {state === "done" ? "✓" : index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-[11px] font-medium">{step}</span>
                  <span className="block truncate text-[10px] text-slate-600 dark:text-slate-400">{details[index]}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Shown when the gate has refused to produce a plan but the band is not BLACK. */
export function VerdictFallback({ reason }: { reason: string }) {
  return (
    <section className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
      <TriangleAlert className="size-4 shrink-0" />
      {reason}
    </section>
  );
}
