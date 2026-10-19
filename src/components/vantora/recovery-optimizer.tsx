"use client";

/** Tab 2 — Recovery Optimizer: three priced counterfactuals and the lender screen. */

import {
  ArrowRight,
  BadgeCheck,
  Ban,
  CircleDollarSign,
  EyeOff,
  Megaphone,
  ShieldCheck,
  TrendingDown,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DashboardState } from "@/lib/dashboard-state";
import type { PermissionTier } from "@/lib/security/permission-gate";
import type { RecoveryPlanResult } from "@/lib/quant-client";
import { cn } from "@/lib/utils";

import { StatusChip } from "./execution-queue";

import { CounterpartyFallbacks, EchoSolvencyCheck, PLAN_B_ANCHOR, PlanBJumpHint } from "./plan-resilience";
import {
  DeterministicBadge,
  impliedApr,
  Metric,
  money,
  money2,
  pct,
  SectionHeading,
  TierBadge,
} from "./primitives";

/**
 * Relationship risk consumed by a plan, against the SME's own cap. For the
 * do-nothing baseline the risk is not a weight but a count of suppliers that
 * actually default.
 */
function riskScore(data: DashboardState, plan: RecoveryPlanResult) {
  const budget = data.state.max_relationship_risk ?? 1;
  const defaults = plan.actions.filter((a) => a.kind === "missed_payable").length;
  if (defaults > 0) {
    return {
      label: `${defaults} supplier default${defaults === 1 ? "" : "s"}`,
      tone: "bad" as const,
    };
  }
  const consumed = plan.actions
    .filter((a) => a.kind === "ap_deferral")
    .reduce(
      (sum, a) => sum + (data.state.payables_ap.find((p) => p.id === a.target_id)?.relationship_risk ?? 0),
      0,
    );
  return {
    label: `${consumed.toFixed(2)} of ${budget.toFixed(2)} budget`,
    tone: consumed > budget * 0.75 ? ("warn" as const) : ("good" as const),
  };
}

function PlanCard({
  data,
  plan,
  title,
  caption,
  method,
  tier,
  tone,
  icon,
  savings,
  recommended,
  onApprove,
}: {
  data: DashboardState;
  plan: RecoveryPlanResult;
  title: string;
  caption: string;
  method: string;
  tier: PermissionTier;
  tone: "good" | "warn" | "bad";
  icon: React.ReactNode;
  savings?: string;
  /** Exactly one card carries the ring. The others are evidence, not options. */
  recommended?: boolean;
  onApprove?: () => void;
}) {
  const risk = riskScore(data, plan);
  const apr = impliedApr(plan.total_cost, plan.cash_raised);
  const costTone = {
    good: "text-emerald-700 dark:text-emerald-400",
    warn: "text-amber-700 dark:text-amber-400",
    bad: "text-rose-600 dark:text-rose-400",
  }[tone];
  const costRatio = plan.cash_raised > 0 ? plan.total_cost / plan.cash_raised : 0;

  return (
    <Card
      className={cn(
        recommended
          ? "ring-1 ring-emerald-500 dark:ring-emerald-500"
          : "border-slate-200 dark:border-slate-800",
      )}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <span className={costTone}>{icon}</span>
            {title}
          </CardTitle>
          <TierBadge tier={tier} />
        </div>
        <div className={cn("text-3xl font-semibold tabular-nums tracking-tight", costTone)}>
          {money2(plan.total_cost)}
        </div>
        {plan.cash_raised > 0 ? (
          <div className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
            {pct(costRatio, 1)} of cash raised ({money2(plan.total_cost)} total · {pct(apr, 1)} annualised)
          </div>
        ) : null}
        <CardDescription className="text-xs">{caption}</CardDescription>
        {plan.breaches_statutory_payroll ? <PayrollBreachCallout data={data} /> : null}
        {savings ? (
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{savings}</div>
        ) : null}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <DeterministicBadge method={method} />
          <Badge
            variant="outline"
            className={cn(
              "border-transparent font-mono text-[10px]",
              plan.meets_buffer
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                : "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
            )}
          >
            {plan.meets_buffer ? "buffer restored" : "buffer breached"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <Metric label="Expected cost" value={money2(plan.total_cost)} tone={tone} />
          <Metric
            label="APR equivalent (30d)"
            value={plan.cash_raised > 0 ? pct(apr) : "n/a — no cash raised"}
            tone={tone}
          />
          <Metric label="Cash raised" value={money2(plan.cash_raised)} />
          <Metric
            label="Day-14 P10 after plan"
            value={money2(plan.post_recovery_p10_balance)}
            tone={plan.meets_buffer ? "good" : "bad"}
          />
          <Metric label="Risk score" value={risk.label} tone={risk.tone} mono={false} />
        </div>
        <div className="flex flex-col gap-2">
          {plan.actions.map((action, index) => (
            <div
              key={`${action.kind}-${action.target_id}-${index}`}
              className="rounded-md border border-slate-200 bg-slate-50/60 p-2.5 dark:border-slate-800 dark:bg-slate-900/40"
            >
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium">{action.label}</span>
                <span className={cn("shrink-0 tabular-nums", costTone)}>{money2(action.cost)}</span>
              </div>
              <div className="mt-0.5 text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                {action.detail}
              </div>
              {/* The modality is the point: these are offers, not outcomes. A
                  counterparty has to say yes before any of this is money. */}
              {COUNTERPARTY_ASSUMPTION[action.kind] ? (
                <div className="mt-1 text-[11px] italic text-slate-500 dark:text-slate-400">
                  ↳ {COUNTERPARTY_ASSUMPTION[action.kind]}
                </div>
              ) : null}
              {recommended ? <PlanActionStatus data={data} kind={action.kind} target={action.target_id} /> : null}
            </div>
          ))}
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">{plan.notes}</p>
        {recommended && onApprove && plan.feasible ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              onClick={onApprove}
              disabled={!data.viewer.capabilities.includes("approve") || !data.execution.bundle}
              className="text-[11px]"
            >
              Approve this plan
              <ArrowRight className="size-3.5" aria-hidden />
            </Button>
            {!data.viewer.capabilities.includes("approve") ? (
              <span className="text-[11px] text-slate-500 dark:text-slate-400">Only the OWNER can approve.</span>
            ) : !data.execution.bundle ? (
              <span className="text-[11px] text-slate-500 dark:text-slate-400">Already submitted — track it in the action center.</span>
            ) : null}
            <PlanBJumpHint />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** What each lever assumes about someone who has not agreed to it yet. */
const COUNTERPARTY_ASSUMPTION: Record<string, string> = {
  ar_early_discount: "if the customer accepts the discount · offer drafted, not sent",
  ap_deferral: "if the supplier agrees to the new date · request drafted, not sent",
  bridge_draw: "if underwriting confirms the quote · match-clean on the deterministic screen",
};

function PayrollBreachCallout({ data }: { data: DashboardState }) {
  const payroll = data.state.payables_ap.find((p) => p.is_payroll);
  return (
    <div className="rounded-md border border-slate-900 bg-slate-900 px-2.5 py-2 text-slate-100 dark:border-slate-100/20">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-rose-400">
        <Ban className="size-3.5 shrink-0" />
        Statutory payroll breach (infeasible)
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
        Missing the {money(payroll?.amount ?? 0)} {payroll?.supplier_name ?? "payroll run"} is a statutory and
        operational failure, not a late fee you can buy. This baseline is priced for comparison only — it is
        not an option the owner may choose at any price.
      </p>
    </div>
  );
}

/**
 * What waiting costs.
 *
 * A step curve, not a line: the cost does not drift upward, it jumps when a
 * lever expires. Each step names the lever that closed to cause it.
 */
function ProcrastinationCurve({ data }: { data: DashboardState }) {
  const points = data.procrastination_curve;
  if (points.length === 0) return null;
  const feasibleCosts = points.map((p) => p.total_cost).filter((c): c is number => c !== null);
  const peak = Math.max(...feasibleCosts, 1);

  return (
    <Card className="border-slate-200 dark:border-slate-800">
      <CardHeader>
        <SectionHeading
          title="The cost of procrastination"
          hint={`same ${money(data.optimization.required_cash)} gap, fewer ways to close it`}
        />
        <CardDescription className="text-xs">
          Each horizon re-runs the optimiser with only the levers an owner who waited that long still has.
          The gap never moves; the means of closing it expire one at a time.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        {points.map((point) => {
          const width = point.total_cost === null ? 100 : Math.max((point.total_cost / peak) * 100, 2);
          return (
            <div key={point.day_waited} className="grid gap-1 sm:grid-cols-[11rem_1fr_7rem] sm:items-center">
              <div className="text-xs font-medium tabular-nums">
                {point.label}
                <span className="ml-1 font-normal text-slate-500">{point.days_remaining}d left</span>
              </div>
              <div className="h-5 w-full overflow-hidden rounded-sm bg-slate-100 dark:bg-slate-900">
                <div
                  className={cn(
                    "h-full rounded-sm transition-[width] duration-500",
                    point.total_cost === null
                      ? "bg-slate-900 dark:bg-slate-200"
                      : point.total_cost > (feasibleCosts[0] ?? 0) * 2
                        ? "bg-amber-500"
                        : "bg-emerald-500",
                  )}
                  style={{ width: `${width}%` }}
                />
              </div>
              <div
                className={cn(
                  "text-right text-xs font-semibold tabular-nums",
                  point.total_cost === null
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-slate-900 dark:text-slate-100",
                )}
              >
                {point.total_cost === null ? "INFEASIBLE" : money2(point.total_cost)}
              </div>
              <div className="text-[11px] text-slate-500 sm:col-span-3 sm:pl-[11rem] dark:text-slate-400">
                ↳ {point.expired_lever}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/**
 * The lender screen, grouped by what it means for the owner.
 *
 * A rejection here is the product working: it is the screen refusing to spend
 * the SME's credit file or its time on a facility that cannot help.
 */
function PROTECTIVE_REASON(
  option: DashboardState["optimization"]["matched_financing_options"][number],
  crunchDay: number,
): string {
  const reason = option.rejection_reason ?? "";
  const late = reason.match(/funds in (\d+)d/);
  if (late) {
    const days = Number(late[1]) - crunchDay;
    return `Too slow — funds in ${late[1]}d, arriving ${days} day${days === 1 ? "" : "s"} after your day-${crunchDay} payroll run.`;
  }
  const credit = reason.match(/credit score (\d+) below minimum (\d+)/);
  if (credit) {
    return `Credit score ${credit[1]} < ${credit[2]} minimum — blocks a wasted hard credit pull.`;
  }
  if (reason.includes("collateral")) {
    return "No assignable receivables — match exceptions have diluted the borrowing base to nothing.";
  }
  return reason || "Screened out.";
}

export function RecoveryOptimizer({
  data,
  onApprove,
}: {
  data: DashboardState;
  onApprove?: () => void;
}) {
  const o = data.optimization;
  const matched = o.matched_financing_options;
  const eligible = matched.filter((m) => m.eligible);
  const screened = matched.filter((m) => !m.eligible);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-3">
        <PlanCard
          data={data}
          plan={o.optimal_plan}
          recommended
          onApprove={onApprove}
          title="Optimal recovery plan"
          caption={`Minimum-cost mix closing the ${money(o.required_cash)} day-${o.crunch_day} gap.`}
          savings={
            o.optimal_plan.feasible
              ? `${money2(data.cost_breakdown.cash_cents / 100)} cash + ${money2(
                  data.cost_breakdown.risk_cents / 100,
                )} modelled relationship risk · ${money2(o.savings_vs_naive)} below naive borrowing on the same objective`
              : undefined
          }
          method={
            data.engine.optimization_source === "python-fastapi"
              ? `MILP · HiGHS · ${o.solver_status}`
              : `Greedy mirror · ${o.solver_status}`
          }
          tier="TIER_2_HITL_APPROVAL"
          tone="good"
          icon={<BadgeCheck className="size-4" />}
        />
        <PlanCard
          data={data}
          plan={o.naive_borrowing_plan}
          title="Naive borrowing"
          caption={`The whole ${money(o.required_cash)} from the fastest facility, ignoring free working-capital levers.`}
          method="Closed-form cost"
          tier="TIER_2_HITL_APPROVAL"
          tone="warn"
          icon={<CircleDollarSign className="size-4" />}
        />
        <PlanCard
          data={data}
          plan={o.baseline_do_nothing_plan}
          title="Do nothing"
          caption="Late fees plus default penalties — penalty sizes are scenario assumptions, not quotes. Shown for contrast, not as an option."
          method="Penalty schedule"
          tier="TIER_0_AUTO_READ"
          tone="bad"
          icon={<TrendingDown className="size-4" />}
        />
      </div>

      <BenchmarkNote data={data} />

      <div id={PLAN_B_ANCHOR} className="flex flex-col gap-4">
        <CounterpartyFallbacks data={data} />
        <EchoSolvencyCheck data={data} />
      </div>

      <ProcrastinationCurve data={data} />

      <Card className="border-slate-200 dark:border-slate-800">
        <CardHeader>
          <SectionHeading
            title="Financing eligibility & affordability matrix"
            hint={`${eligible.length} available to you · ${screened.length} screened out to protect you`}
          />
          <CardDescription className="text-xs">
            Screening order is fixed and deterministic: credit score, then funding speed against the day-
            {o.crunch_day} deadline, then AR collateral coverage. Rejections quote the failing test.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Facility</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Quoted APR</TableHead>
                <TableHead className="text-right">Effective APR (30d)</TableHead>
                <TableHead className="text-right">Funding</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Cost on draw</TableHead>
                <TableHead>Screen result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[
                { rows: eligible, label: `Available to you (${eligible.length})`, good: true },
                { rows: screened, label: `Screened out to protect you (${screened.length})`, good: false },
              ].flatMap((group) => [
                group.rows.length ? (
                  <TableRow key={group.label} className="hover:bg-transparent">
                    <TableCell
                      colSpan={9}
                      className={cn(
                        "bg-slate-50 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] dark:bg-slate-900/60",
                        group.good
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-slate-500 dark:text-slate-400",
                      )}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {group.good ? <BadgeCheck className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
                        {group.label}
                      </span>
                    </TableCell>
                  </TableRow>
                ) : null,
                ...group.rows.map((option) => {
                  const quoted = data.state.financing_options.find((f) => f.id === option.id);
                  const used = o.optimal_plan.actions.find((a) => a.target_id === option.id);
                  return (
                  <TableRow
                    key={option.id}
                    className={cn(
                      !option.eligible && "bg-slate-50/60 dark:bg-slate-900/40",
                      used && "bg-emerald-50/60 dark:bg-emerald-950/20",
                    )}
                  >
                    <TableCell className="tabular-nums text-slate-500">{option.rank}</TableCell>
                    <TableCell className="font-medium">
                      <div className="whitespace-nowrap">{option.provider}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">{option.id}</div>
                      {/* Notice of Assignment is the hidden cost of factoring:
                          the facility is priced in APR, but it is paid in the
                          vendor relationship when your buyer is told. */}
                      {quoted?.requires_notice_of_assignment ? (
                        <div
                          className="mt-0.5 flex items-start gap-1 text-[10px] leading-snug text-amber-700 dark:text-amber-400"
                          title={quoted.notice_of_assignment_note || undefined}
                        >
                          <Megaphone className="mt-px size-3 shrink-0" />
                          Notifies your buyer (NOA)
                        </div>
                      ) : quoted?.is_existing_facility ? (
                        <div className="mt-0.5 flex items-start gap-1 text-[10px] leading-snug text-emerald-700 dark:text-emerald-400">
                          <EyeOff className="mt-px size-3 shrink-0" />
                          Confidential · already underwritten
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-slate-500 dark:text-slate-400">
                      {option.product_type.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{pct(quoted?.apr ?? 0)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {pct(option.effective_apr)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums",
                        option.funding_days >= o.crunch_day && "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {option.funding_days} d
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(option.max_available)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money2(option.effective_cost_30d)}</TableCell>
                    <TableCell className="min-w-[18rem]">
                      {option.eligible ? (
                        <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400">
                          <BadgeCheck className="size-3" />
                          {used ? `matched · ${money2(used.cash_impact)} drawn` : "eligible"}
                        </span>
                      ) : (
                        // Second person, and the consequence rather than the
                        // predicate: a rejection should feel like cover, not
                        // like the owner failing a test.
                        <span className="inline-flex items-start gap-1 text-slate-600 dark:text-slate-400">
                          <Ban className="mt-0.5 size-3 shrink-0" />
                          {PROTECTIVE_REASON(option, o.crunch_day)}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                  );
                }),
              ])}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="border-slate-200 dark:border-slate-800">
        <CardHeader>
          <SectionHeading title="Mathematical proof summary" hint={`solver status: ${o.solver_status}`} />
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed tabular-nums text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">
            {o.mathematical_proof_summary}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

/** The status of this plan action in the sandbox, if it has gone anywhere yet. */
function PlanActionStatus({ data, kind, target }: { data: DashboardState; kind: string; target: string }) {
  const record = data.execution.actions.find((a) => a.kind === kind && a.target_id === target);
  if (!record) return null;
  return (
    <div className="mt-1.5">
      <StatusChip status={record.status} kind={record.kind} />
    </div>
  );
}

/**
 * What the solver is worth here, measured rather than asserted: the MILP and
 * the greedy mirror were run on every shipped scenario
 * (`scripts/benchmark-milp-vs-greedy.ts`) and the result is quoted as is.
 */
function BenchmarkNote({ data }: { data: DashboardState }) {
  const b = data.benchmark;
  if (!b) return null;
  return (
    <details className="rounded-md border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
      <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-300">
        Model details: MILP versus a greedy heuristic, measured
      </summary>
      <p className="mt-1.5 leading-relaxed">
        Across all {b.scenarios} shipped scenario and stress-dial combinations, the HiGHS MILP and a greedy
        cost-per-dollar heuristic produced the <strong>same cost in {b.identical} of {b.identical + b.milp_cheaper + b.greedy_cheaper}</strong>{" "}
        feasible cases and agreed on all {b.both_infeasible} infeasible ones ({b.milp_cheaper} cases where the MILP
        was cheaper). On this data the MILP does not find cheaper plans; what it adds is a proof that the plan is
        optimal and a place where hard constraints — payroll is never deferred, the relationship-risk budget, the
        trade-credit insurance cap — are enforced rather than hoped for. Benchmark run {b.run_at.slice(0, 10)}.
      </p>
    </details>
  );
}
