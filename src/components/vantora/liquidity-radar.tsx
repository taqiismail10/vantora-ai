"use client";

/** Tab 1 — Liquidity Radar: where the cash breaks, and what it breaks on. */

import { useState } from "react";
import { AlertTriangle, ChevronDown, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";

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

/** Two mutually exclusive states, shown as one control rather than a checkbox. */
function Segmented({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-800 dark:bg-slate-900">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition-colors disabled:opacity-60",
            option.value === value
              ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-slate-100"
              : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Mark the exact substrings the detectors fired on, inside the memo text. */
function StruckMemo({ text, spans }: { text: string; spans: string[] }) {
  // Longest first so an outer match wins over a substring of it.
  const ordered = [...new Set(spans)].filter(Boolean).sort((a, b) => b.length - a.length);
  let parts: (string | { hit: string })[] = [text];
  for (const span of ordered) {
    parts = parts.flatMap((part) => {
      if (typeof part !== "string" || !part.includes(span)) return [part];
      const pieces = part.split(span);
      return pieces.flatMap((piece, index) => (index === 0 ? [piece] : [{ hit: span }, piece]));
    });
  }
  return (
    <p className="font-mono text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
      {parts.map((part, index) =>
        typeof part === "string" ? (
          <span key={index}>{part}</span>
        ) : (
          <span key={index} className="font-semibold text-rose-600 line-through decoration-rose-500 dark:text-rose-400">
            {part.hit}
          </span>
        ),
      )}
    </p>
  );
}

const RHO_STEPS = [
  { value: "0", label: "0.0 Independent" },
  { value: "0.3", label: "0.3 Moderate" },
  { value: "0.6", label: "0.6 Sector stress" },
];

export function LiquidityRadar({
  data,
  rho,
  onRhoChange,
  busy,
}: {
  data: DashboardState;
  rho: number;
  onRhoChange: (next: number) => void;
  busy: boolean;
}) {
  const [showRecovery, setShowRecovery] = useState(false);
  const [showQuantMath, setShowQuantMath] = useState(false);
  const [openMemo, setOpenMemo] = useState<string | null>(null);
  const { forecast, optimization, state, memos } = data;
  const crunchDay = forecast.first_shortfall_day ?? optimization.crunch_day;
  const crunchP10 = forecast.p10_trajectory[crunchDay - 1];
  const wc = forecast.working_capital_metrics;
  const meanSpread =
    forecast.p90_trajectory.reduce((sum, v, i) => sum + (v - forecast.p10_trajectory[i]), 0) /
    forecast.horizon_days;

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
          // Neutral on purpose. The verdict bar above owns the one large rose
          // number on the page; these cards are the evidence behind it, and a
          // second alarm-coloured figure makes neither of them mean anything.
          tone="neutral"
          footnote={<DeterministicBadge method={`Monte Carlo · ${forecast.n_simulations.toLocaleString()} runs`} />}
        />
        <KpiCard
          label="Required buffer gap"
          value={money(optimization.required_cash)}
          sublabel={`Below the ${money(state.minimum_safe_buffer)} safe buffer on day ${crunchDay}`}
          tone="neutral"
          footnote={<DeterministicBadge method="P10 decomposition" />}
        />
        <KpiCard
          label="Shortfall probability"
          value={pct(forecast.shortfall_probability, 1)}
          sublabel={`of ${forecast.n_simulations.toLocaleString()} trajectories breach the buffer (seed ${forecast.seed})`}
          tone="neutral"
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
            {/* An infeasible plan has no cost to offer, so there is no second
                state to toggle into — saying "with the $0 plan" would claim one. */}
            <Segmented
              value={showRecovery ? "plan" : "nothing"}
              disabled={!optimization.optimal_plan.feasible}
              onChange={(next) => setShowRecovery(next === "plan")}
              options={[
                { value: "nothing", label: "If you do nothing" },
                {
                  value: "plan",
                  label: optimization.optimal_plan.feasible
                    ? `With the ${money(optimization.optimal_plan.total_cost)} plan`
                    : "No feasible plan",
                },
              ]}
            />
            {showRecovery && optimization.optimal_plan.feasible ? (
              <Badge
                variant="outline"
                className="border-transparent bg-emerald-100 font-mono text-[10px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
              >
                Restores to {money(optimization.optimal_plan.post_recovery_p10_balance)}
              </Badge>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="text-[11px]"
              onClick={() => setShowQuantMath((value) => !value)}
            >
              {showQuantMath ? "Hide" : "Show"} P90 &amp; quant math
            </Button>

            <div className="ml-auto flex items-center gap-2">
              <span
                className="text-[11px] text-slate-500 dark:text-slate-400"
                title="Systemic correlation between customer payment delays. Above zero the whole receivables book slips together."
              >
                Correlation ρ
              </span>
              <Segmented
                value={String(rho)}
                disabled={busy}
                onChange={(next) => onRhoChange(Number(next))}
                options={RHO_STEPS}
              />
              {busy ? <Loader2 className="size-3.5 animate-spin text-slate-400" /> : null}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <FanChart data={data} showRecovery={showRecovery} showQuantMath={showQuantMath} />

          {showQuantMath ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
              <span>
                Mean P90−P10 spread{" "}
                <span className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
                  {money(meanSpread)}
                </span>{" "}
                at ρ={rho.toFixed(1)}
              </span>
              <span>
                Day-{crunchDay} P10 95% CI{" "}
                <span className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
                  {money(forecast.p10_ci_95[0])} … {money(forecast.p10_ci_95[1])}
                </span>
                {forecast.p10_ci_95[0] === forecast.p10_ci_95[1] ? (
                  <span className="text-slate-400"> (zero width — no invoice can land in that window)</span>
                ) : null}
              </span>
              <span className="font-mono">
                seed {forecast.seed} · {forecast.n_simulations.toLocaleString()} runs
              </span>
            </div>
          ) : null}

          {/* Working-capital facts are context, not alarms: neutral ink. */}
          <div className="mt-2 grid gap-x-8 gap-y-0 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Days sales outstanding" value={`${wc.days_sales_outstanding} d`} />
            <Metric label="Days payable outstanding (COGS)" value={`${wc.days_payable_outstanding} d`} />
            <Metric label="Cash conversion gap" value={`${wc.cash_conversion_gap_days} d`} />
            <Metric label="P50 runway" value={`${wc.runway_days_p50} d`} />
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
                {state.invoices_ar.flatMap((invoice) => {
                  const memo = memos.find((m) => m.invoice_id === invoice.id);
                  const inPlan = optimization.optimal_plan.actions.some(
                    (a) => a.target_id === invoice.id && a.kind === "ar_early_discount",
                  );
                  const expanded = openMemo === invoice.id;
                  return [
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
                          <button
                            type="button"
                            onClick={() => setOpenMemo(expanded ? null : invoice.id)}
                            aria-expanded={expanded}
                            className="inline-flex items-center gap-1 rounded font-medium text-rose-600 underline decoration-dotted underline-offset-2 hover:text-rose-700 dark:text-rose-400"
                          >
                            <ShieldAlert className="size-3" /> quarantined
                            <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <ShieldCheck className="size-3" /> clean
                          </span>
                        )}
                      </TableCell>
                    </TableRow>,
                    expanded && memo ? (
                      <TableRow key={`${invoice.id}-memo`} className="bg-rose-50/60 hover:bg-rose-50/60 dark:bg-rose-950/20">
                        <TableCell colSpan={8} className="p-3">
                          <div className="rounded-md border border-rose-200 bg-white p-3 dark:border-rose-900 dark:bg-slate-950">
                            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                              <span className="font-medium text-rose-700 dark:text-rose-300">
                                Raw memo text as received — severity {memo.severity}
                              </span>
                              {memo.matched_patterns.map((pattern) => (
                                <Badge
                                  key={pattern}
                                  variant="outline"
                                  className="border-rose-200 bg-rose-50 font-mono text-[10px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300"
                                >
                                  {pattern}
                                </Badge>
                              ))}
                            </div>
                            <div className="mt-2">
                              <StruckMemo text={memo.sanitized_excerpt} spans={memo.matched_text} />
                            </div>
                            <p className="mt-2 text-[11px] font-medium text-slate-600 dark:text-slate-400">
                              Quarantined at data ingestion — never entered LLM context.
                            </p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null,
                  ];
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
