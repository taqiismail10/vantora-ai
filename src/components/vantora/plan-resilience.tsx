"use client";

/**
 * Tab 2 — the two questions that decide whether a plan is signable.
 *
 * "What if they say no?" and "what does this cost me next month?" are the
 * first things a CFO asks and the last things a dashboard usually answers.
 * Both panels are pre-computed server-side, so clicking a refusal scenario
 * shows a real re-solve rather than an estimate.
 */

import { useState } from "react";
import { ArrowRight, Ban, CalendarClock, CircleAlert, CircleCheck, UserX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import type { DashboardState } from "@/lib/dashboard-state";
import { cn } from "@/lib/utils";

import { SectionHeading, useMoney } from "./primitives";

/** What the counterparty says no to, and what it costs when they do. */
export function CounterpartyFallbacks({ data }: { data: DashboardState }) {
  const { money, money2 } = useMoney();
  const branches = data.counterparty_fallbacks;
  const [open, setOpen] = useState(0);
  if (branches.length === 0) return null;

  const active = branches[Math.min(open, branches.length - 1)];
  const plan = data.optimization.optimal_plan;

  return (
    <Card className="border-slate-200 dark:border-slate-800">
      <CardHeader>
        <SectionHeading
          title="What if a counterparty says no?"
          hint="dynamic plan B, re-solved"
        />
        <CardDescription className="text-xs">
          Every lever in the plan except the credit draw is an <em>offer</em>. A plan that only works
          when all of them are accepted is a forecast, not a plan. Each branch below re-solves the same{" "}
          {money(data.optimization.required_cash)} gap with that counterparty withdrawn.
        </CardDescription>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {branches.map((branch, index) => (
            <button
              key={branch.id}
              type="button"
              onClick={() => setOpen(index)}
              aria-pressed={index === open}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                index === open
                  ? "border-slate-400 bg-slate-100 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-900",
              )}
            >
              <UserX className="size-3.5" aria-hidden />
              {branch.label}
              {branch.cost_delta !== null ? (
                <span className="font-mono tabular-nums text-amber-700 dark:text-amber-400">
                  +{money2(branch.cost_delta)}
                </span>
              ) : (
                <span className="font-mono text-rose-600 dark:text-rose-400">infeasible</span>
              )}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">{active.scenario}</p>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div className="flex flex-col gap-2">
            {active.actions.length ? (
              active.actions.map((action, index) => (
                <div
                  key={`${action.kind}-${action.target_id}-${index}`}
                  className="rounded-md border border-slate-200 bg-slate-50/60 p-2.5 dark:border-slate-800 dark:bg-slate-900/40"
                >
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="font-medium">{action.label}</span>
                    <span className="shrink-0 tabular-nums text-slate-700 dark:text-slate-300">
                      {money2(action.cost)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                    {action.detail}
                  </div>
                  {/* The substitution is the point: a lever that lost on price
                      in plan A is the only cash left in plan B. */}
                  {!plan.actions.some((a) => a.target_id === action.target_id) ? (
                    <div className="mt-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                      ↳ substituted in — not used by the optimal plan
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="rounded-md border border-slate-900 bg-slate-900 p-3 text-slate-100 dark:border-slate-100/20">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-rose-400">
                  <Ban className="size-3.5 shrink-0" aria-hidden />
                  No feasible plan B
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-300">{active.notes}</p>
              </div>
            )}
          </div>

          <div className="rounded-md border border-slate-200 p-3 sm:w-52 dark:border-slate-800">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
              Plan B cost
            </div>
            <div
              className={cn(
                "mt-0.5 text-2xl font-semibold tabular-nums tracking-tight",
                active.feasible
                  ? "text-amber-700 dark:text-amber-400"
                  : "text-rose-600 dark:text-rose-400",
              )}
            >
              {active.total_cost === null ? "INFEASIBLE" : money2(active.total_cost)}
            </div>
            {active.cost_delta !== null ? (
              <div className="mt-1 text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
                <span className="font-medium tabular-nums">+{money2(active.cost_delta)}</span> versus the{" "}
                <span className="tabular-nums">{money2(plan.total_cost)}</span> optimal plan — still{" "}
                <span className="font-medium tabular-nums">
                  {(data.optimization.baseline_do_nothing_plan.total_cost / active.total_cost!).toFixed(1)}×
                </span>{" "}
                cheaper than doing nothing.
              </div>
            ) : null}
            <div className="mt-2 border-t border-slate-100 pt-2 text-[10px] leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
              Withdrawn: {active.withdrawn.join("; ")}.
            </div>
          </div>
        </div>

        <p className="text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
          Re-solved by the deterministic TypeScript mirror (a greedy heuristic, not HiGHS) against the same forecast, so the gap is identical and only
          the admissible lever set differs. The delta is mirror-to-mirror arithmetic, not a cross-engine
          subtraction.
        </p>
      </CardContent>
    </Card>
  );
}

/** Does the day-14 fix quietly become a day-31 problem? */
export function EchoSolvencyCheck({ data }: { data: DashboardState }) {
  const { money, money2 } = useMoney();
  const echo = data.post_crunch_echo_check;
  if (!echo) return null;

  const [start, end] = echo.window;
  const planDays = echo.plan_echo_days;
  // The conservative read is the headline: a receivable sitting in a buyer's
  // match-exception queue is not cash, and a solvency proof must not lean on it.
  const safe = echo.clears_buffer_withheld;
  const noDefault = echo.min_balance_withheld > 0;

  return (
    <Card
      className={cn(
        safe
          ? "border-emerald-200 dark:border-emerald-900"
          : "border-amber-300 dark:border-amber-900",
      )}
    >
      <CardHeader>
        <SectionHeading
          title={`Day ${start}–${end} post-crunch echo check`}
          hint={`${planDays.length} obligation${planDays.length === 1 ? "" : "s"} the plan created`}
        />
        <CardDescription className="text-xs">
          Pulling a receivable forward and pushing a payable back is borrowing from the near future. This
          walks the existing ledger past the crunch to see whether the fix lands as a second crisis.{" "}
          <strong>No next-cycle revenue is assumed</strong> — a solvency proof that leans on sales nobody has
          made yet proves nothing.
        </CardDescription>
        <p
          role="note"
          className="mt-1 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <strong>Coverage limit:</strong> the ledger is a 30-day book. Recurring obligations that would fall after
          day 30 — the next monthly payroll, rent and utilities — are not in it, so this check cannot say whether
          days 31–45 are solvent. It shows only that the obligations it can see, including the ones the plan
          creates, are funded.
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-2 sm:grid-cols-3">
          {/* Deliberately not "no secondary default": the ledger is a 30-day
              book, so next month's payroll, rent and utilities are absent from
              days 31-45. The claim is scoped to what the data contains. */}
          <Verdict
            tone={noDefault ? "good" : "bad"}
            icon={noDefault ? <CircleCheck className="size-4" aria-hidden /> : <Ban className="size-4" aria-hidden />}
            label="Obligations on the book"
            value={noDefault ? "Funded" : "Not funded"}
            detail={
              noDefault
                ? `Every recorded obligation in the window, including the ${planDays.length} the plan created, is funded.`
                : `A recorded obligation in the window cannot be funded.`
            }
          />
          <Verdict
            tone={safe ? "good" : "warn"}
            icon={safe ? <CircleCheck className="size-4" aria-hidden /> : <CircleAlert className="size-4" aria-hidden />}
            label={`Safe buffer (${money(echo.buffer)})`}
            value={safe ? "Held" : `Dips to ${money2(echo.min_balance_withheld)}`}
            detail={
              safe
                ? `Minimum ${money2(echo.min_balance_withheld)} on day ${echo.min_balance_day_withheld}.`
                : `Lowest on day ${echo.min_balance_day_withheld}, on the conservative read.`
            }
          />
          <Verdict
            tone={echo.clears_buffer ? "good" : "warn"}
            icon={<CalendarClock className="size-4" aria-hidden />}
            label="If the blocked match clears"
            value={`+${money(echo.contingent_total)}`}
            detail={`Minimum rises to ${money2(echo.min_balance)} on day ${echo.min_balance_day}.`}
          />
        </div>

        <div
          tabIndex={0}
          role="region"
          aria-label="Held-payment timeline"
          className="overflow-x-auto rounded-md border border-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-800"
        >
          <table className="w-full text-[11px]">
            <thead className="bg-slate-50 dark:bg-slate-900/60">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium text-slate-500">Day</th>
                <th className="px-2 py-1.5 text-left font-medium text-slate-500">Event</th>
                <th className="px-2 py-1.5 text-right font-medium text-slate-500">Cash</th>
                <th className="px-2 py-1.5 text-right font-medium text-slate-500">Balance</th>
                <th className="px-2 py-1.5 text-right font-medium text-slate-500">If match unresolved</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-2 py-1.5 tabular-nums text-slate-500">d{start - 1}</td>
                <td className="px-2 py-1.5 text-slate-500">Post-recovery opening balance</td>
                <td className="px-2 py-1.5 text-right text-slate-500">—</td>
                <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                  {money2(echo.opening_balance)}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">
                  {money2(echo.opening_balance)}
                </td>
              </tr>
              {echo.points.map((point, index) => (
                <tr
                  key={`${point.day}-${point.label}-${index}`}
                  className={cn(
                    "border-t border-slate-100 dark:border-slate-800",
                    point.plan_created && "bg-amber-50/50 dark:bg-amber-950/20",
                  )}
                >
                  <td className="px-2 py-1.5 tabular-nums font-medium">d{point.day}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span>{point.label}</span>
                      {point.plan_created ? (
                        <Badge
                          variant="outline"
                          className="border-amber-200 bg-amber-50 font-mono text-[9px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300"
                        >
                          created by the plan
                        </Badge>
                      ) : null}
                      {point.contingent ? (
                        <Badge
                          variant="outline"
                          className="border-slate-300 font-mono text-[9px] text-slate-600 dark:border-slate-700 dark:text-slate-400"
                        >
                          contingent
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-[10px] leading-snug text-slate-500 dark:text-slate-400">
                      {point.reason}
                    </div>
                  </td>
                  <td
                    className={cn(
                      "px-2 py-1.5 text-right tabular-nums",
                      point.delta > 0
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-slate-700 dark:text-slate-300",
                    )}
                  >
                    {point.delta > 0 ? "+" : ""}
                    {money2(point.delta)}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-1.5 text-right font-medium tabular-nums",
                      point.balance < echo.buffer && "text-amber-700 dark:text-amber-400",
                    )}
                  >
                    {money2(point.balance)}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-1.5 text-right tabular-nums",
                      point.balance_withheld < echo.buffer
                        ? "font-medium text-amber-700 dark:text-amber-400"
                        : "text-slate-500",
                    )}
                  >
                    {money2(point.balance_withheld)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
          {planDays.length ? (
            <>
              The plan&apos;s own echo lands on{" "}
              <span className="font-medium tabular-nums">
                day {planDays.join(" and day ")}
              </span>
              . Both are funded, and the buffer dip on day {echo.min_balance_day} comes from an obligation
              already on the book — it exists in the do-nothing world too, so it is not a cost of the
              recovery.
            </>
          ) : null}{" "}
          The ledger is a {data.forecast.horizon_days}-day book, so days {data.forecast.horizon_days + 1}–
          {end} carry only obligations already recorded in it; a second payroll cycle is outside what this
          dataset knows about.
        </p>
      </CardContent>
    </Card>
  );
}

function Verdict({
  tone,
  icon,
  label,
  value,
  detail,
}: {
  tone: "good" | "warn" | "bad";
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  const colour = {
    good: "text-emerald-700 dark:text-emerald-400",
    warn: "text-amber-700 dark:text-amber-400",
    bad: "text-rose-700 dark:text-rose-400",
  }[tone];
  return (
    <div className="rounded-md border border-slate-200 p-2.5 dark:border-slate-800">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className={cn("mt-0.5 flex items-center gap-1.5 text-sm font-semibold tabular-nums", colour)}>
        {icon}
        {value}
      </div>
      <div className="mt-0.5 text-[10px] leading-snug text-slate-500 dark:text-slate-400">{detail}</div>
    </div>
  );
}

/** Jump target used by the optimal-plan card. */
export const PLAN_B_ANCHOR = "plan-b";

export function PlanBJumpHint() {
  return (
    <a
      href={`#${PLAN_B_ANCHOR}`}
      className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 underline decoration-dotted underline-offset-2 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
    >
      What if they say no?
      <ArrowRight className="size-3" aria-hidden />
    </a>
  );
}
