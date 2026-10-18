"use client";

/** Tab 2 — Recovery Optimizer: three priced counterfactuals and the lender screen. */

import { BadgeCheck, Ban, CircleDollarSign, TrendingDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
}) {
  const risk = riskScore(data, plan);
  const apr = impliedApr(plan.total_cost, plan.cash_raised);
  const ring = {
    good: "border-emerald-300 dark:border-emerald-800",
    warn: "border-amber-300 dark:border-amber-800",
    bad: "border-rose-300 dark:border-rose-800",
  }[tone];
  const costTone = {
    good: "text-emerald-600 dark:text-emerald-400",
    warn: "text-amber-600 dark:text-amber-400",
    bad: "text-rose-600 dark:text-rose-400",
  }[tone];

  return (
    <Card className={cn("border-2", ring)}>
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
        <CardDescription className="text-xs">{caption}</CardDescription>
        {savings ? (
          <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{savings}</div>
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
              className="rounded-lg border border-slate-200 bg-slate-50/60 p-2.5 dark:border-slate-800 dark:bg-slate-900/40"
            >
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium">{action.label}</span>
                <span className={cn("shrink-0 tabular-nums", costTone)}>{money2(action.cost)}</span>
              </div>
              <div className="mt-0.5 text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                {action.detail}
              </div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">{plan.notes}</p>
      </CardContent>
    </Card>
  );
}

export function RecoveryOptimizer({ data }: { data: DashboardState }) {
  const o = data.optimization;
  const matched = o.matched_financing_options;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-3">
        <PlanCard
          data={data}
          plan={o.optimal_plan}
          title="Optimal recovery plan"
          caption={`Minimum-cost mix closing the ${money(o.required_cash)} day-${o.crunch_day} gap.`}
          savings={`Saves ${money2(o.savings_vs_naive)} vs naive borrowing · ${money2(
            o.savings_vs_do_nothing,
          )} vs doing nothing`}
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
          caption="Late fees on what goes unpaid plus the default penalties on critical suppliers."
          method="Penalty schedule"
          tier="TIER_0_AUTO_READ"
          tone="bad"
          icon={<TrendingDown className="size-4" />}
        />
      </div>

      <Card className="border-slate-200 dark:border-slate-800">
        <CardHeader>
          <SectionHeading
            title="Financing eligibility & affordability matrix"
            hint={`${matched.filter((m) => m.eligible).length} of ${matched.length} facilities eligible`}
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
              {matched.map((option) => {
                const quoted = data.state.financing_options.find((f) => f.id === option.id);
                const used = o.optimal_plan.actions.find((a) => a.target_id === option.id);
                return (
                  <TableRow
                    key={option.id}
                    className={cn(
                      !option.eligible && "opacity-70",
                      used && "bg-emerald-50/60 dark:bg-emerald-950/20",
                    )}
                  >
                    <TableCell className="tabular-nums text-slate-400">{option.rank}</TableCell>
                    <TableCell className="font-medium">
                      <div className="whitespace-nowrap">{option.provider}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">{option.id}</div>
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
                    <TableCell>
                      {option.eligible ? (
                        <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                          <BadgeCheck className="size-3" />
                          {used ? `matched · ${money2(used.cash_impact)} drawn` : "eligible"}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
                          <Ban className="size-3 shrink-0" /> rejected — {option.rejection_reason}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
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
