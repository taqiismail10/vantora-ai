"use client";

/** Tab 1 — Liquidity Radar: where the cash breaks, and what it breaks on. */

import { useState } from "react";
import { AlertTriangle, ShieldAlert, ShieldCheck } from "lucide-react";

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
import { cn } from "@/lib/utils";

import { FanChart } from "./fan-chart";
import { DeterministicBadge, KpiCard, Metric, money, money2, pct, SectionHeading } from "./primitives";

function reliabilityTone(score: number) {
  if (score >= 0.9) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 0.75) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

export function LiquidityRadar({ data }: { data: DashboardState }) {
  const [showRecovery, setShowRecovery] = useState(true);
  const { forecast, optimization, state, memos } = data;
  const crunchDay = forecast.first_shortfall_day ?? optimization.crunch_day;
  const crunchP10 = forecast.p10_trajectory[crunchDay - 1];
  const wc = forecast.working_capital_metrics;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Current cash"
          value={money(state.current_cash)}
          sublabel={`Minimum safe buffer ${money(state.minimum_safe_buffer)}`}
          tone="neutral"
          footnote={<DeterministicBadge method="Ledger" />}
        />
        <KpiCard
          label={`Day-${crunchDay} P10 projected cash`}
          value={money(crunchP10)}
          sublabel={`P50 ${money(forecast.p50_trajectory[crunchDay - 1])} · P90 ${money(
            forecast.p90_trajectory[crunchDay - 1],
          )}`}
          tone="bad"
          footnote={<DeterministicBadge method={`Monte Carlo · ${forecast.n_simulations.toLocaleString()} runs`} />}
        />
        <KpiCard
          label="Required buffer gap"
          value={money(optimization.required_cash)}
          sublabel={`Below the ${money(state.minimum_safe_buffer)} safe buffer on day ${crunchDay}`}
          tone="bad"
          footnote={<DeterministicBadge method="P10 decomposition" />}
        />
        <KpiCard
          label="Shortfall probability"
          value={pct(forecast.shortfall_probability, 1)}
          sublabel={`of ${forecast.n_simulations.toLocaleString()} trajectories breach the buffer (seed ${forecast.seed})`}
          tone={forecast.shortfall_probability > 0.5 ? "bad" : "warn"}
          footnote={<DeterministicBadge method={`Seeded · reproducible`} />}
        />
      </div>

      <Card className="border-slate-200 dark:border-slate-800">
        <CardHeader>
          <CardTitle className="text-sm">30-day Cash-Flow-at-Risk fan</CardTitle>
          <CardDescription className="text-xs">
            {forecast.n_simulations.toLocaleString()} seeded trajectories · truncated-normal B2B payment delays
            with a log-normal dispute tail · {forecast.engine_source === "python-fastapi" ? "numpy/scipy" : "TS mirror"}
          </CardDescription>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              variant={showRecovery ? "default" : "outline"}
              onClick={() => setShowRecovery((value) => !value)}
            >
              {showRecovery ? "Hide" : "Show"} post-recovery P10
            </Button>
            <Badge
              variant="outline"
              className="border-transparent bg-emerald-100 font-mono text-[10px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
            >
              Restores to {money(optimization.optimal_plan.post_recovery_p10_balance)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <FanChart data={data} showRecovery={showRecovery} />
          <div className="mt-2 grid gap-x-8 gap-y-0 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Days sales outstanding" value={`${wc.days_sales_outstanding} d`} tone="warn" />
            <Metric label="Days payable outstanding" value={`${wc.days_payable_outstanding} d`} />
            <Metric label="Cash conversion gap" value={`${wc.cash_conversion_gap_days} d`} tone="warn" />
            <Metric label="P50 runway" value={`${wc.runway_days_p50} d`} tone="bad" />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-slate-200 dark:border-slate-800">
          <CardHeader>
            <SectionHeading
              title="Accounts receivable"
              hint={`${money(wc.total_ar_outstanding)} outstanding`}
            />
            <CardDescription className="text-xs">
              Delay distribution and reliability drive the Monte Carlo arrival day. The memo column is the
              injection screen, not a model judgement.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Due</TableHead>
                  <TableHead className="text-right">Delay (μ±σ)</TableHead>
                  <TableHead className="text-right">P90 arrival</TableHead>
                  <TableHead className="text-right">Reliability</TableHead>
                  <TableHead>Early pay</TableHead>
                  <TableHead>Memo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.invoices_ar.map((invoice) => {
                  const memo = memos.find((m) => m.invoice_id === invoice.id);
                  const inPlan = optimization.optimal_plan.actions.some(
                    (a) => a.target_id === invoice.id && a.kind === "ar_early_discount",
                  );
                  return (
                    <TableRow key={invoice.id} className={cn(inPlan && "bg-emerald-50/60 dark:bg-emerald-950/20")}>
                      <TableCell className="font-medium">
                        <div className="whitespace-nowrap">{invoice.id}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">{invoice.customer_name}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(invoice.amount)}</TableCell>
                      <TableCell className="text-right tabular-nums">d{invoice.due_day}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {invoice.expected_delay_days_mean}±{invoice.expected_delay_days_std} d
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        d{Math.round(forecast.invoice_p90_payment_day[invoice.id] ?? invoice.due_day)}
                      </TableCell>
                      <TableCell
                        className={cn("text-right font-medium tabular-nums", reliabilityTone(invoice.reliability_score))}
                      >
                        {invoice.reliability_score.toFixed(2)}
                      </TableCell>
                      <TableCell>
                        {invoice.early_payment_discount_eligible ? (
                          <span className="tabular-nums">
                            {pct(invoice.early_payment_discount_pct ?? 0)} / {invoice.early_payment_settles_in_days}d
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {!memo ? (
                          <span className="inline-flex items-center gap-1 text-slate-400">
                            <ShieldCheck className="size-3" /> none
                          </span>
                        ) : memo.quarantined ? (
                          <span className="inline-flex items-center gap-1 font-medium text-rose-600 dark:text-rose-400">
                            <ShieldAlert className="size-3" /> quarantined
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <ShieldCheck className="size-3" /> clean
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
            <SectionHeading title="Accounts payable" hint={`${money(wc.total_ap_due)} due in horizon`} />
            <CardDescription className="text-xs">
              Deferral windows and relationship-risk weights are the optimiser&apos;s AP levers. Critical suppliers
              carry a default penalty on top of the late fee.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>Payable</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Due</TableHead>
                  <TableHead>Deferral window</TableHead>
                  <TableHead className="text-right">Rel. risk</TableHead>
                  <TableHead className="text-right">Late fee</TableHead>
                  <TableHead>Critical</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.payables_ap.map((payable) => {
                  const inPlan = optimization.optimal_plan.actions.some(
                    (a) => a.target_id === payable.id && a.kind === "ap_deferral",
                  );
                  return (
                    <TableRow
                      key={payable.id}
                      className={cn(
                        inPlan && "bg-emerald-50/60 dark:bg-emerald-950/20",
                        payable.due_day === crunchDay && "bg-rose-50/70 dark:bg-rose-950/20",
                      )}
                    >
                      <TableCell className="font-medium">
                        <div className="whitespace-nowrap">{payable.id}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">{payable.supplier_name}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(payable.amount)}</TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          payable.due_day === crunchDay && "font-semibold text-rose-600 dark:text-rose-400",
                        )}
                      >
                        d{payable.due_day}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {payable.is_flexible ? (
                          <>
                            +{payable.max_deferral_days}d @ {pct(payable.deferral_fee_pct ?? 0, 2)}
                          </>
                        ) : (
                          <span className="text-slate-400">fixed</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(payable.relationship_risk ?? 0).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{pct(payable.late_fee_pct ?? 0, 1)}</TableCell>
                      <TableCell>
                        {payable.is_critical ? (
                          <span className="inline-flex items-center gap-1 font-medium text-rose-600 dark:text-rose-400">
                            <AlertTriangle className="size-3" /> {money(payable.default_penalty ?? 0)}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {memos.some((m) => m.quarantined) ? (
        <Card className="border-rose-200 bg-rose-50/50 dark:border-rose-900 dark:bg-rose-950/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm text-rose-700 dark:text-rose-300">
              <ShieldAlert className="size-4" /> Quarantined invoice memos
            </CardTitle>
            <CardDescription className="text-xs">
              Screened before any model sees them. The raw text never leaves the API route; what follows is the
              sanitised excerpt with the patterns that matched.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {memos
              .filter((memo) => memo.quarantined)
              .map((memo) => (
                <div key={memo.invoice_id} className="rounded-lg border border-rose-200 bg-white p-3 dark:border-rose-900 dark:bg-slate-950">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium">
                      {memo.invoice_id} · {memo.customer_name}
                    </span>
                    <Badge
                      variant="outline"
                      className="border-transparent bg-rose-100 font-mono text-[10px] text-rose-800 dark:bg-rose-950 dark:text-rose-300"
                    >
                      severity: {memo.severity}
                    </Badge>
                    {memo.matched_patterns.map((pattern) => (
                      <Badge key={pattern} variant="outline" className="font-mono text-[10px]">
                        {pattern}
                      </Badge>
                    ))}
                  </div>
                  <p className="mt-2 font-mono text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
                    {memo.sanitized_excerpt}
                  </p>
                </div>
              ))}
          </CardContent>
        </Card>
      ) : null}

      <p className="text-[11px] text-slate-500 dark:text-slate-400">
        Totals: {money2(wc.total_ar_outstanding)} AR against {money2(wc.total_ap_due)} AP, average daily burn{" "}
        {money2(wc.average_daily_burn)}.
      </p>
    </div>
  );
}
