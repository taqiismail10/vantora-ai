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

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DashboardState } from "@/lib/dashboard-state";
import { cn } from "@/lib/utils";

import { money, money2 } from "./primitives";

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
        <CheckCircle2 className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
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
  const crunchP10 = forecast.p10_trajectory[crunchDay - 1];
  const decisionDay = forecast.decision_day ?? Math.max(1, crunchDay - 3);
  const crunchPayables = state.payables_ap.filter((p) => p.due_day === crunchDay);
  const doNothing = o.baseline_do_nothing_plan.total_cost;
  const multiple = o.optimal_plan.total_cost > 0 ? doNothing / o.optimal_plan.total_cost : 0;

  return (
    <section
      aria-label="Executive verdict"
      className="grid divide-y divide-slate-200 rounded-md border border-slate-300 bg-white dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-950 lg:grid-cols-3 lg:divide-x lg:divide-y-0"
    >
      <Column label="What">
        <div className="text-3xl font-semibold tabular-nums tracking-tight text-rose-600 dark:text-rose-400">
          You are {money(o.required_cash)} short
        </div>
        <div className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
          Cash today <span className="font-medium tabular-nums">{money(state.current_cash)}</span> · day-
          {crunchDay} P10 <span className="font-medium tabular-nums">{money(crunchP10)}</span> against a{" "}
          <span className="font-medium tabular-nums">{money(state.minimum_safe_buffer)}</span> safe buffer
        </div>
      </Column>

      <Column label="When">
        <div className="flex items-center gap-2 text-lg font-semibold tracking-tight text-amber-700 dark:text-amber-400">
          <CalendarClock className="size-4 shrink-0" />
          <span className="tabular-nums">
            Payroll file lock: day {decisionDay} ({PAYROLL_LOCK_TIME})
          </span>
        </div>
        <div className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
          72h before the day-{crunchDay} collision:{" "}
          {crunchPayables
            .map((p) => `${money(p.amount)} ${p.is_payroll ? "payroll" : p.supplier_name.split(" (")[0]}`)
            .join(" + ")}
        </div>
      </Column>

      <Column label="Cost to fix">
        <div className="flex flex-wrap items-baseline gap-2">
          <span
            className="text-3xl font-semibold tabular-nums tracking-tight text-emerald-600 dark:text-emerald-400"
            title={`${money2(o.optimal_plan.total_cost)} exact`}
          >
            {money(o.optimal_plan.total_cost)}
          </span>
          <Badge variant="outline" className="font-mono text-[10px]" title="Exact solver output">
            {money2(o.optimal_plan.total_cost)}
          </Badge>
        </div>
        <div className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
          <span className="font-medium tabular-nums">{multiple.toFixed(1)}×</span> cheaper than doing nothing
          · restores day-{crunchDay} P10 to{" "}
          <span className="font-medium tabular-nums">
            {money(o.optimal_plan.post_recovery_p10_balance)}
          </span>
        </div>
        <Button size="sm" onClick={onReviewPlan} className="mt-1 w-fit text-[11px]">
          Review &amp; approve {o.optimal_plan.actions.length}-step plan
          <ArrowRight className="size-3.5" />
        </Button>
      </Column>
    </section>
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
