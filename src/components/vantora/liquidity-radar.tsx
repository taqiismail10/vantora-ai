"use client";

/** Tab 1 — Liquidity Radar: where the cash breaks, and what it breaks on. */

import { useState } from "react";
import { AlertTriangle, ChevronDown, ShieldAlert, ShieldCheck, Waves } from "lucide-react";

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
import { deferralDays, deferralFeePct, pledgeableAr, uncertaintyWindows } from "@/lib/quant-client";
import { cn } from "@/lib/utils";

import { dayDate } from "./dates";
import { FanChart } from "./fan-chart";
import { DeterministicBadge, KpiCard, Metric, money, money2, pct, SectionHeading } from "./primitives";

/** Mirrors the ranker: these two dilute the borrowing base, the others do not. */
const MATCH_EXCEPTIONS = new Set(["QTY_VARIANCE", "PRICE_VARIANCE"]);

/** The 3-way match verdict, and what it costs the SME when it is not clean. */
const MATCH_BADGE: Record<string, { label: string; className: string }> = {
  MATCH_CLEAN: {
    label: "3-way clean",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300",
  },
  QTY_VARIANCE: {
    label: "GR/IR qty variance",
    className: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300",
  },
  PRICE_VARIANCE: {
    label: "GR/IR price variance",
    className: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300",
  },
  MEMO_QUARANTINED: {
    label: "memo quarantined",
    className: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300",
  },
};

/** Short, readable supplier archetypes for the AP table. */
const ARCHETYPE_LABEL: Record<string, string> = {
  MONOPOLY_STRICT: "single-source",
  FLEXIBLE_PARTNER: "strategic partner",
  COMMERCIAL_NEGOTIATOR: "commercial mill",
  STATUTORY: "statutory",
  OVERHEAD: "overhead",
};

function reliabilityTone(score: number) {
  if (score >= 0.9) return "text-emerald-700 dark:text-emerald-400";
  if (score >= 0.75) return "text-amber-700 dark:text-amber-400";
  return "text-rose-700 dark:text-rose-400";
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
              : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
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
          <span key={index} className="font-semibold text-rose-700 line-through decoration-rose-500 dark:text-rose-400">
            {part.hit}
          </span>
        ),
      )}
    </p>
  );
}

export function LiquidityRadar({ data }: { data: DashboardState }) {
  const [showRecovery, setShowRecovery] = useState(false);
  const [showQuantMath, setShowQuantMath] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [openMemo, setOpenMemo] = useState<string | null>(null);
  const { forecast, optimization, state, memos } = data;
  // The correlation dial lives in the header stress drawer now, beside the
  // three other controls that perturb the same forecast. This tab reports
  // where it was set rather than offering a second, competing copy of it.
  const rho = data.stress.rho;
  const pledgeable = pledgeableAr(state);
  const dilution = state.invoices_ar.reduce((sum, i) => sum + i.amount, 0) - pledgeable;
  const crunchDay = forecast.first_shortfall_day ?? optimization.crunch_day;
  const crunchP10 = forecast.p10_trajectory[crunchDay - 1];
  const wc = forecast.working_capital_metrics;
  const meanSpread =
    forecast.p90_trajectory.reduce((sum, v, i) => sum + (v - forecast.p10_trajectory[i]), 0) /
    forecast.horizon_days;
  const windows = uncertaintyWindows(forecast);
  const crunchCoincides =
    forecast.p10_trajectory[crunchDay - 1] === forecast.p90_trajectory[crunchDay - 1];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Ledger cash (as-of date)"
          value={money(state.current_cash)}
          sublabel={
            data.execution.has_position
              ? `Buffer ${money(state.minimum_safe_buffer)} · sandbox account now ${money(data.execution.account.cash_cents / 100)} after settled actions`
              : `Minimum safe buffer ${money(state.minimum_safe_buffer)}`
          }
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
          sublabel={`of ${forecast.n_simulations.toLocaleString()} simulated trajectories breach the buffer (seed ${forecast.seed}) — under the model's assumptions, not a guarantee`}
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
                    ? `With the plan (${money2(data.cost_breakdown.cash_cents / 100)} cash)`
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
              aria-pressed={showQuantMath}
              onClick={() => setShowQuantMath((value) => !value)}
            >
              {showQuantMath ? "Hide" : "Show"} model details
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-[11px]"
              aria-pressed={showTable}
              aria-controls="fan-chart-table"
              onClick={() => setShowTable((value) => !value)}
            >
              {showTable ? "Hide" : "View"} as table
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <FanChart data={data} showRecovery={showRecovery} showQuantMath={showQuantMath} />

          {showTable ? <ForecastTable data={data} showRecovery={showRecovery} /> : null}

          {showQuantMath ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
              <span
                className="inline-flex items-center gap-1.5 font-mono"
                title="Systemic correlation between buyer payment delays. Above zero the whole receivables book slips together. Set it in the header stress drawer."
              >
                <Waves className="size-3" aria-hidden />
                ρ = {rho.toFixed(1)}
                {rho > 0 ? " · correlated" : " · independent"}
              </span>
              {crunchCoincides ? (
                <span>
                  P10 = P50 = P90 on day {crunchDay}: at least 80% of runs end that day on exactly{" "}
                  {money(forecast.p10_trajectory[crunchDay - 1])}, because in those runs exactly the same receivables have
                  arrived by then. Some runs do differ — an invoice early or late — but fewer than 10% each way, so the
                  percentiles cannot show them. That is certainty inside the model (authored payment-delay
                  assumptions, fixed bills, no new sales), not a guarantee about real buyers.
                </span>
              ) : null}
              <span>
                Uncertainty sits on{" "}
                {windows.length
                  ? windows
                      .map((w) => `days ${w.from}–${w.to} (widest ${money(w.max_spread)} on day ${w.max_day})`)
                      .join(" and ")
                  : "no day: every run gives the same path"}
                : that is when receivable timing changes the outcome.
              </span>
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
                  <span className="text-slate-600"> (zero width — no invoice can land in that window)</span>
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

      {/* Stacked until there is room for every column of both ledgers; side by
          side at 1536px+ so "Early pay" and the default penalty are never
          hidden behind an internal scroll. */}
      <div className="grid gap-4 2xl:grid-cols-2">
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
                  <TableHead>Match &amp; terms</TableHead>
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
                        <div className="text-[11px] text-slate-600 dark:text-slate-400">{invoice.customer_name}</div>
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
                      <TableCell className="min-w-[11rem]">
                        <Badge
                          variant="outline"
                          className={cn(
                            "font-mono text-[10px]",
                            MATCH_BADGE[invoice.match_status ?? "MATCH_CLEAN"]?.className,
                          )}
                          title={invoice.match_exception_detail || undefined}
                        >
                          {MATCH_BADGE[invoice.match_status ?? "MATCH_CLEAN"]?.label ?? invoice.match_status}
                        </Badge>
                        <div className="mt-0.5 flex flex-col gap-0.5 text-[10px] text-slate-600 dark:text-slate-400">
                          {(invoice.revenue_concentration_pct ?? 0) >= 0.3 ? (
                            <span
                              className="font-medium text-amber-700 dark:text-amber-400"
                              title="Concentration risk: dunning this buyer to collect one invoice risks the rest of the book, so outbound text is clerk-signed only."
                            >
                              {pct(invoice.revenue_concentration_pct ?? 0, 0)} of revenue · clerk-signed only
                            </span>
                          ) : (
                            <span className="tabular-nums">
                              {pct(invoice.revenue_concentration_pct ?? 0, 0)} of revenue
                            </span>
                          )}
                          {invoice.msa_governed_terms ? (
                            <span title={invoice.terms_conflict_note || undefined}>
                              {invoice.invoice_stated_terms} printed ·{" "}
                              <span className="font-medium text-slate-700 dark:text-slate-300">
                                {invoice.msa_governed_terms} governs
                              </span>
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        {invoice.early_payment_discount_eligible ? (
                          <span className="tabular-nums">
                            {pct(invoice.early_payment_discount_pct ?? 0)} / {invoice.early_payment_settles_in_days}d
                          </span>
                        ) : MATCH_EXCEPTIONS.has(invoice.match_status ?? "") ? (
                          <span
                            className="text-[10px] text-amber-700 dark:text-amber-400"
                            title="Blocked in the buyer's GR/IR exception queue: no discount, and excluded from the borrowing base until reconciled."
                          >
                            blocked by match
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {!memo ? (
                          <span className="inline-flex items-center gap-1 text-slate-600">
                            <ShieldCheck className="size-3" /> none
                          </span>
                        ) : memo.quarantined ? (
                          <button
                            type="button"
                            onClick={() => setOpenMemo(expanded ? null : invoice.id)}
                            aria-expanded={expanded}
                            className="inline-flex items-center gap-1 rounded font-medium text-rose-700 underline decoration-dotted underline-offset-2 hover:text-rose-700 dark:text-rose-400"
                          >
                            <ShieldAlert className="size-3" /> quarantined
                            <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                            <ShieldCheck className="size-3" /> clean
                          </span>
                        )}
                      </TableCell>
                    </TableRow>,
                    expanded && memo ? (
                      <TableRow key={`${invoice.id}-memo`} className="bg-rose-50/60 hover:bg-rose-50/60 dark:bg-rose-950/20">
                        <TableCell colSpan={9} className="p-3">
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
                        <div className="text-[11px] text-slate-600 dark:text-slate-400">{payable.supplier_name}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-slate-600 dark:text-slate-400">
                          <span className="font-mono">
                            {ARCHETYPE_LABEL[payable.supplier_archetype ?? "OVERHEAD"]}
                          </span>
                          {payable.line_stop_risk ? (
                            <span
                              className="font-medium text-rose-700 dark:text-rose-400"
                              title="Not deferrable at any price: withholding payment stops the line."
                            >
                              · line stop
                            </span>
                          ) : null}
                          {payable.payroll_lock_day ? (
                            <span
                              className="font-medium text-amber-700 dark:text-amber-400"
                              title="The bank direct-deposit file locks here. After it the run cannot be re-cut, so this is the real deadline."
                            >
                              · file locks d{payable.payroll_lock_day}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(payable.amount)}</TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          payable.due_day === crunchDay && "font-semibold text-rose-700 dark:text-rose-400",
                        )}
                      >
                        d{payable.due_day}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {payable.is_flexible ? (
                          <>
                            +{deferralDays(payable)}d @ {pct(deferralFeePct(payable), 2)}
                            {(payable.past_extension_count ?? 0) >= 1 &&
                            (payable.extension_surcharge_pct ?? 0) > 0 ? (
                              <div
                                className="text-[10px] font-medium text-amber-700 dark:text-amber-400"
                                title="Goodwill already spent: the step surcharge applies on top of the base fee."
                              >
                                incl. +{pct(payable.extension_surcharge_pct ?? 0, 1)} step
                              </div>
                            ) : null}
                            {payable.credit_insured_by ? (
                              <div
                                className="text-[10px] text-slate-600"
                                title={`${payable.credit_insured_by} withdraws cover past ${payable.insurance_revocation_day_cap ?? 30} days, which converts the account to cash-in-advance and triggers bureau reporting.`}
                              >
                                {payable.credit_insured_by} cap {payable.insurance_revocation_day_cap ?? 30}d
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-slate-600">
                            {payable.is_payroll ? "statutory" : "fixed"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(payable.relationship_risk ?? 0).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{pct(payable.late_fee_pct ?? 0, 1)}</TableCell>
                      <TableCell>
                        {payable.is_critical ? (
                          <span className="inline-flex items-center gap-1 font-medium text-rose-700 dark:text-rose-400">
                            <AlertTriangle className="size-3" /> {money(payable.default_penalty ?? 0)}
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
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
            <CardDescription className="text-xs text-slate-600 dark:text-slate-400">
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

      <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
        Totals: {money2(wc.total_ar_outstanding)} AR against {money2(wc.total_ap_due)} AP, average daily burn{" "}
        {money2(wc.average_daily_burn)}.
        {/* The borrowing base is not the AR balance. A receivable the buyer's
            own ERP has blocked cannot be assigned, so it dilutes out — which is
            the difference between what a lender quotes and what it advances. */}
        {dilution > 0 ? (
          <>
            {" "}
            Borrowing base is <span className="font-medium tabular-nums">{money(pledgeable)}</span>, not{" "}
            <span className="tabular-nums">{money(wc.total_ar_outstanding)}</span>:{" "}
            <span className="tabular-nums">{money(dilution)}</span> is diluted out by unreconciled match
            exceptions and cannot be pledged.
          </>
        ) : null}
      </p>
    </div>
  );
}

/** The fan chart's numbers, for anyone who cannot or would rather not read a chart. */
function ForecastTable({ data, showRecovery }: { data: DashboardState; showRecovery: boolean }) {
  const { forecast } = data;
  return (
    <div id="fan-chart-table" className="mt-3 max-h-80 overflow-auto rounded-md border border-slate-200 dark:border-slate-800">
      <table className="w-full text-[11px]">
        <caption className="sr-only">Projected daily cash, P10 / P50 / P90, for the 30-day horizon</caption>
        <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900">
          <tr>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">Day</th>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">Date</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">P10 (late payers)</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">P50 (typical)</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">P90</th>
            {showRecovery ? <th scope="col" className="px-2 py-1.5 text-right font-medium">P10 with plan</th> : null}
          </tr>
        </thead>
        <tbody>
          {forecast.p10_trajectory.map((p10, index) => (
            <tr key={index} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-2 py-1 tabular-nums">{index + 1}</td>
              <td className="px-2 py-1">{dayDate(data.scenario.as_of_date, index + 1)}</td>
              <td className={cn("px-2 py-1 text-right tabular-nums", p10 < data.state.minimum_safe_buffer && "font-medium text-rose-700 dark:text-rose-300")}>
                {money(p10)}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">{money(forecast.p50_trajectory[index])}</td>
              <td className="px-2 py-1 text-right tabular-nums">{money(forecast.p90_trajectory[index])}</td>
              {showRecovery ? (
                <td className="px-2 py-1 text-right tabular-nums">{money(data.post_recovery_p10_trajectory[index])}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
