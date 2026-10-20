/**
 * Bridge from Next.js to the Python quantitative engine.
 *
 * The wire contract is snake_case on purpose: it mirrors the Pydantic models in
 * `quant_engine/schemas.py` exactly, so there is no mapping layer to drift.
 *
 * If the FastAPI process is unreachable (unit tests, Vercel preview, cold dev
 * machine) every call falls back to a seeded TypeScript mirror that is
 * deterministic run-to-run, so the UI and the audit chain always have numbers.
 */

const ENGINE_URL = process.env.QUANT_ENGINE_URL ?? "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 2_500;
const N_SIMULATIONS = 1_000;
const SEED = 42;
const BRIDGE_TERM_DAYS = 30;

// ----------------------------------------------------------------- wire contract

export type MatchStatus = "MATCH_CLEAN" | "QTY_VARIANCE" | "PRICE_VARIANCE" | "MEMO_QUARANTINED";
export type SupplierArchetype =
  | "MONOPOLY_STRICT"
  | "FLEXIBLE_PARTNER"
  | "COMMERCIAL_NEGOTIATOR"
  | "STATUTORY"
  | "OVERHEAD";

export interface ArInvoiceInput {
  id: string;
  customer_name: string;
  amount: number;
  due_day: number;
  expected_delay_days_mean: number;
  expected_delay_days_std: number;
  reliability_score: number;
  early_payment_discount_eligible?: boolean;
  early_payment_discount_pct?: number;
  early_payment_settles_in_days?: number;
  /** Share of plant revenue this buyer represents. Drives the signatory rule. */
  revenue_concentration_pct?: number;
  /** 3-way match state. Anything but MATCH_CLEAN is stuck in a GR/IR queue. */
  match_status?: MatchStatus;
  match_exception_detail?: string;
  invoice_stated_terms?: string;
  msa_governed_terms?: string;
  terms_conflict_note?: string;
  allowed_signatory_role?: string;
  /** An in-flight facility draw modelled as an inflow. Never discountable, never collateral. */
  inflow_kind?: "invoice" | "expected_funding";
}

export interface ApPayableInput {
  id: string;
  supplier_name: string;
  amount: number;
  due_day: number;
  is_flexible?: boolean;
  max_deferral_days?: number;
  deferral_fee_pct?: number;
  relationship_risk?: number;
  late_fee_pct?: number;
  is_critical?: boolean;
  default_penalty?: number;
  /** Wages: missing it is a statutory breach. Declared, never inferred from the name. */
  is_payroll?: boolean;
  /** Bank file-lock day. The real deadline, earlier than the due day. */
  payroll_lock_day?: number | null;
  supplier_archetype?: SupplierArchetype;
  /** Extensions already granted: goodwill is a stock, not a rate. */
  past_extension_count?: number;
  /** Added to deferral_fee_pct once past_extension_count >= 1. */
  extension_surcharge_pct?: number;
  line_stop_risk?: string;
  credit_insured_by?: string;
  /** Deferring past this revokes cover, so it caps the window. */
  insurance_revocation_day_cap?: number;
}

export interface FinancingOptionInput {
  id: string;
  provider: string;
  product_type: "invoice_factoring" | "bridge_loan" | "line_of_credit" | "merchant_advance";
  max_amount: number;
  apr: number;
  origination_fee_pct?: number;
  min_credit_score?: number;
  funding_days: number;
  requires_ar_collateral?: boolean;
  ar_coverage_ratio?: number;
  /** Already underwritten: no fresh application, no new hard credit pull. */
  is_existing_facility?: boolean;
  /** Factor notifies the buyer directly. Confidential lines do not. */
  requires_notice_of_assignment?: boolean;
  notice_of_assignment_note?: string;
}

export interface SmeFinancialState {
  current_cash: number;
  minimum_safe_buffer: number;
  credit_score: number;
  monthly_revenue: number;
  invoices_ar: ArInvoiceInput[];
  payables_ap: ApPayableInput[];
  financing_options: FinancingOptionInput[];
  company_name?: string;
  horizon_days?: number;
  max_relationship_risk?: number;
  relationship_risk_price?: number;
  /** DPO divides AP by daily COGS, not daily revenue, so the margin is required. */
  gross_margin?: number;
  /** Systemic correlation between customer payment delays, 0 to 0.95. */
  correlation_rho?: number;
}

export interface WorkingCapitalMetrics {
  /** Null when monthly revenue isn't recorded — not computable, not zero. */
  days_sales_outstanding: number | null;
  /** Null when monthly revenue isn't recorded (COGS is derived from it) — not computable, not zero. */
  days_payable_outstanding: number | null;
  cash_conversion_gap_days: number | null;
  total_ar_outstanding: number;
  total_ap_due: number;
  average_daily_burn: number;
  runway_days_p50: number;
}

export type EngineSource = "python-fastapi" | "typescript-fallback";

export interface ForecastResult {
  company_name: string;
  horizon_days: number;
  p10_trajectory: number[];
  p50_trajectory: number[];
  p90_trajectory: number[];
  shortfall_detected: boolean;
  first_shortfall_day: number | null;
  /** 72h before the crunch: the last day the full lever set is still open. */
  decision_day: number | null;
  /** Distribution-free 95% CI on the crunch-day P10 estimate. */
  p10_ci_95: [number, number];
  p10_shortfall_amount: number;
  p50_shortfall_amount: number;
  shortfall_probability: number;
  working_capital_metrics: WorkingCapitalMetrics;
  minimum_safe_buffer: number;
  n_simulations: number;
  seed: number;
  invoice_p90_payment_day: Record<string, number>;
  engine_source: EngineSource;
}

export interface PlanAction {
  kind: "ar_early_discount" | "ap_deferral" | "bridge_draw" | "missed_payable" | "none";
  target_id: string;
  label: string;
  cash_impact: number;
  cost: number;
  detail: string;
}

export interface RecoveryPlanResult {
  name: string;
  actions: PlanAction[];
  cash_raised: number;
  total_cost: number;
  post_recovery_p10_balance: number;
  meets_buffer: boolean;
  /** False when no admissible combination of levers closes the gap. */
  feasible: boolean;
  /** A payroll run goes unpaid on its due date: a statutory breach, not a trade-off. */
  breaches_statutory_payroll: boolean;
  notes: string;
}

export interface MatchedFinancingOption {
  id: string;
  provider: string;
  product_type: string;
  eligible: boolean;
  rejection_reason: string | null;
  max_available: number;
  effective_cost_30d: number;
  effective_apr: number;
  funding_days: number;
  rank: number;
}

export interface OptimizationResult {
  company_name: string;
  crunch_day: number;
  required_cash: number;
  optimal_plan: RecoveryPlanResult;
  baseline_do_nothing_plan: RecoveryPlanResult;
  naive_borrowing_plan: RecoveryPlanResult;
  matched_financing_options: MatchedFinancingOption[];
  solver_status: string;
  mathematical_proof_summary: string;
  savings_vs_naive: number;
  savings_vs_do_nothing: number;
  engine_source: EngineSource;
}

// ----------------------------------------------------------------- public surface

async function callEngine<T>(path: string, state: SmeFinancialState): Promise<T | null> {
  try {
    const response = await fetch(`${ENGINE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null; // offline, timed out, or non-JSON: the caller falls back.
  }
}

export async function forecastCashFlow(state: SmeFinancialState): Promise<ForecastResult> {
  const remote = await callEngine<ForecastResult>("/api/quant/forecast", state);
  return remote
    ? { ...remote, engine_source: "python-fastapi" }
    : localForecast(state);
}

export async function optimizeRecovery(state: SmeFinancialState): Promise<OptimizationResult> {
  const remote = await callEngine<OptimizationResult>("/api/quant/optimize", state);
  return remote
    ? { ...remote, engine_source: "python-fastapi" }
    : localOptimize(state);
}

export async function engineHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${ENGINE_URL}/health`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Where the simulated outcomes actually differ: contiguous days on which the
 * P90-P10 band is open, with the widest point of each. A day outside every
 * window has P10 = P50 = P90, which means at least 80% of runs end that day on
 * exactly the same balance; the runs that differ are fewer than 10% on each
 * side, so the percentiles cannot show them.
 */
export function uncertaintyWindows(forecast: ForecastResult): { from: number; to: number; max_spread: number; max_day: number }[] {
  const windows: { from: number; to: number; max_spread: number; max_day: number }[] = [];
  forecast.p90_trajectory.forEach((p90, i) => {
    const spread = Math.round((p90 - forecast.p10_trajectory[i]) * 100) / 100;
    if (spread <= 0) return;
    const day = i + 1;
    const last = windows.at(-1);
    if (last && last.to === day - 1) {
      last.to = day;
      if (spread > last.max_spread) Object.assign(last, { max_spread: spread, max_day: day });
    } else windows.push({ from: day, to: day, max_spread: spread, max_day: day });
  });
  return windows;
}

/**
 * The P10 cash line as it would run once the optimal plan is executed, for the
 * chart overlay.
 *
 * ponytail: the plan's cash is applied in one step from the crunch day onward
 * rather than re-simulating 1,000 trajectories per candidate plan. That holds
 * over a 30-day horizon because every lever lands by the crunch day and every
 * repayment (deferred payable, bridge term) falls outside it. The authoritative
 * single number remains `optimal_plan.post_recovery_p10_balance`.
 */
export function postRecoveryP10Trajectory(
  forecast: ForecastResult,
  optimization: OptimizationResult,
): number[] {
  const { crunch_day, optimal_plan } = optimization;
  if (!crunch_day) return [...forecast.p10_trajectory];
  return forecast.p10_trajectory.map((value, index) =>
    index + 1 >= crunch_day ? round2(value + optimal_plan.cash_raised) : value,
  );
}

// ------------------------------------------------------- cost of procrastination

export interface ProcrastinationPoint {
  /** Days the owner let pass before acting. */
  day_waited: number;
  days_remaining: number;
  label: string;
  /** Null when no lever set left can close the gap. */
  total_cost: number | null;
  feasible: boolean;
  /** What closed between the previous decision point and this one. */
  expired_lever: string;
}

/** Today, the last quiet week, the deferral deadline, the payroll lock, the eve. */
const DECISION_HORIZONS = [0, 4, 7, 11, 13];
/** A supplier only agrees to a deferral if asked this far before the bill falls due. */
const AP_DEFERRAL_NOTICE_DAYS = 6;
/** An early-pay offer still has to be read, approved and queued before it settles. */
const AR_OFFER_LEAD_DAYS = 2;

/** The levers still open to an owner who has already waited `dayWaited` days. */
function openLevers(state: SmeFinancialState, crunchDay: number, dayWaited: number) {
  const daysRemaining = crunchDay - dayWaited;
  const invoices = state.invoices_ar.map((inv) => ({
    ...inv,
    early_payment_discount_eligible:
      (inv.early_payment_discount_eligible ?? false) &&
      (inv.early_payment_settles_in_days ?? 3) + AR_OFFER_LEAD_DAYS <= daysRemaining,
  }));
  const payables = state.payables_ap.map((ap) => ({
    ...ap,
    is_flexible: (ap.is_flexible ?? false) && ap.due_day - dayWaited >= AP_DEFERRAL_NOTICE_DAYS,
  }));
  const financing = state.financing_options.filter((f) => f.funding_days < daysRemaining);

  const names = [
    ...invoices.filter((i) => i.early_payment_discount_eligible).map((i) => `${i.customer_name} early-pay discount`),
    ...payables.filter((p) => p.is_flexible).map((p) => `${p.supplier_name} deferral`),
    ...financing.map((f) => `${f.provider} (${f.funding_days}d funding)`),
  ];
  return { narrowed: { ...state, invoices_ar: invoices, payables_ap: payables, financing_options: financing }, names };
}

/**
 * What waiting costs, priced rather than asserted.
 *
 * Each point re-runs the optimiser against the same forecast with only the
 * levers an owner who waited that long still has: an early-pay offer needs
 * lead time to be accepted, a supplier needs notice before the bill falls due,
 * and a facility is useless once it cannot fund before the crunch. The gap
 * itself never moves — only the means of closing it.
 */
export function procrastinationCurve(
  state: SmeFinancialState,
  forecast: ForecastResult,
  optimization: OptimizationResult,
): ProcrastinationPoint[] {
  const crunchDay = optimization.crunch_day;
  if (!crunchDay) return []; // nothing to be late for

  let previous: string[] | null = null;
  return DECISION_HORIZONS.filter((d) => d < crunchDay).map((dayWaited) => {
    const daysRemaining = crunchDay - dayWaited;
    const { narrowed, names } = openLevers(state, crunchDay, dayWaited);
    const result = localOptimize(narrowed, forecast);
    const lost = previous ? previous.filter((n) => !names.includes(n)) : [];
    previous = names;

    return {
      day_waited: dayWaited,
      days_remaining: daysRemaining,
      label: dayWaited === 0 ? `Day 0 (today, ${daysRemaining}d out)` : `Day ${dayWaited} (${daysRemaining}d out)`,
      total_cost: result.optimal_plan.feasible ? result.optimal_plan.total_cost : null,
      feasible: result.optimal_plan.feasible,
      expired_lever: lost.length ? lost.join("; ") : "none — every lever still open",
    };
  });
}

// -------------------------------------------------- deterministic fallback mirror

/** mulberry32: tiny, seedable, and identical across Node and the browser. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(next: () => number): number {
  // Box-Muller; u is nudged off zero so log() stays finite.
  const u = Math.max(next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

/** numpy.percentile's default linear interpolation, so both engines agree. */
function percentile(sorted: number[], q: number): number {
  const pos = (q / 100) * (sorted.length - 1);
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Distribution-free 95% CI on a sample quantile, from the order statistics.
 *
 * The rank of the q-quantile is Binomial(n, q); its normal approximation gives
 * the two order statistics that bracket it. No bootstrap, so the interval is
 * exactly reproducible and costs one sort — and it is the same arithmetic as
 * `quantile_ci_95` in `forecaster.py`.
 */
export function quantileCi95(column: number[], q = 0.1): [number, number] {
  const n = column.length;
  const sorted = [...column].sort((a, b) => a - b);
  const halfWidth = 1.96 * Math.sqrt(n * q * (1 - q));
  const clamp = (i: number) => Math.min(Math.max(i, 0), n - 1);
  return [
    round2(sorted[clamp(Math.floor(n * q - halfWidth))]),
    round2(sorted[clamp(Math.ceil(n * q + halfWidth))]),
  ];
}

/** 72h before the crunch: the payroll file locks, so the lever set starts closing. */
const DECISION_LEAD_DAYS = 3;

export function localForecast(state: SmeFinancialState): ForecastResult {
  const horizon = state.horizon_days ?? 30;
  const next = rng(SEED);

  // One systemic factor per trajectory: a bad month pushes the whole book late
  // together. Drawn from its own stream so the independent path (rho = 0)
  // consumes exactly the draws it always did and stays byte-identical.
  const rho = state.correlation_rho ?? 0;
  const systemic = rng(SEED + 1);
  const zSys = rho > 0 ? Array.from({ length: N_SIMULATIONS }, () => gaussian(systemic)) : null;

  // ponytail: delays are clamped at 0 rather than re-sampled like scipy's
  // truncnorm, so the fallback is close to, not bit-identical with, Python.
  const paymentDays: Record<string, number[]> = {};
  for (const inv of state.invoices_ar) {
    const stretch = 2 - inv.reliability_score;
    const loc = inv.expected_delay_days_mean * stretch;
    const scale = inv.expected_delay_days_std * stretch;
    const days: number[] = [];
    for (let s = 0; s < N_SIMULATIONS; s++) {
      const z = zSys
        ? Math.sqrt(rho) * zSys[s] + Math.sqrt(1 - rho) * gaussian(next)
        : gaussian(next);
      let delay = Math.max(0, loc + scale * z);
      if (next() < 1 - inv.reliability_score) {
        delay += Math.exp(Math.log(7) + 0.5 * gaussian(next));
      }
      days.push(Math.ceil(inv.due_day + delay));
    }
    paymentDays[inv.id] = days;
  }

  const outflow = new Array(horizon + 2).fill(0);
  for (const ap of state.payables_ap) outflow[ap.due_day] += ap.amount;

  const balances: number[][] = [];
  for (let s = 0; s < N_SIMULATIONS; s++) {
    const inflow = new Array(horizon + 2).fill(0);
    for (const inv of state.invoices_ar) {
      const day = Math.min(Math.max(paymentDays[inv.id][s], 1), horizon + 1);
      inflow[day] += inv.amount;
    }
    const row: number[] = [];
    let running = state.current_cash;
    for (let d = 1; d <= horizon; d++) {
      running += inflow[d] - outflow[d];
      row.push(running);
    }
    balances.push(row);
  }

  const p10: number[] = [];
  const p50: number[] = [];
  const p90: number[] = [];
  for (let d = 0; d < horizon; d++) {
    const column = balances.map((row) => row[d]).sort((a, b) => a - b);
    p10.push(round2(percentile(column, 10)));
    p50.push(round2(percentile(column, 50)));
    p90.push(round2(percentile(column, 90)));
  }

  const buffer = state.minimum_safe_buffer;
  const breachIndex = p10.findIndex((v) => v < buffer);
  const breached = balances.filter((row) => Math.min(...row) < buffer).length;

  const totalAr = state.invoices_ar.reduce((sum, i) => sum + i.amount, 0);
  const totalAp = state.payables_ap.reduce((sum, p) => sum + p.amount, 0);
  const dailyRevenue = state.monthly_revenue / 30;
  // DSO is receivables over daily sales; DPO is payables over daily *COGS*.
  // Dividing AP by revenue understates DPO by the whole gross margin.
  const dailyCogs = (state.monthly_revenue * (1 - (state.gross_margin ?? 0.35))) / 30;
  // Null, not Infinity/NaN, when revenue isn't recorded: not computable, not zero.
  const dso = dailyRevenue > 0 ? totalAr / dailyRevenue : null;
  const dpo = dailyCogs > 0 ? totalAp / dailyCogs : null;
  const negative = p50.findIndex((v) => v < 0);

  const invoiceP90: Record<string, number> = {};
  for (const inv of state.invoices_ar) {
    invoiceP90[inv.id] = percentile([...paymentDays[inv.id]].sort((a, b) => a - b), 90);
  }

  return {
    company_name: state.company_name ?? "SME",
    horizon_days: horizon,
    p10_trajectory: p10,
    p50_trajectory: p50,
    p90_trajectory: p90,
    shortfall_detected: breachIndex !== -1,
    first_shortfall_day: breachIndex === -1 ? null : breachIndex + 1,
    decision_day: breachIndex === -1 ? null : Math.max(1, breachIndex + 1 - DECISION_LEAD_DAYS),
    p10_ci_95: quantileCi95(balances.map((row) => row[breachIndex === -1 ? horizon - 1 : breachIndex])),
    p10_shortfall_amount: round2(Math.max(0, buffer - Math.min(...p10))),
    p50_shortfall_amount: round2(Math.max(0, buffer - Math.min(...p50))),
    shortfall_probability: Math.round((breached / N_SIMULATIONS) * 10000) / 10000,
    working_capital_metrics: {
      days_sales_outstanding: dso === null ? null : round2(dso),
      days_payable_outstanding: dpo === null ? null : round2(dpo),
      cash_conversion_gap_days: dso === null || dpo === null ? null : round2(dso - dpo),
      total_ar_outstanding: round2(totalAr),
      total_ap_due: round2(totalAp),
      average_daily_burn: round2(totalAp / horizon),
      runway_days_p50: negative === -1 ? horizon : negative + 1,
    },
    minimum_safe_buffer: buffer,
    n_simulations: N_SIMULATIONS,
    seed: SEED,
    invoice_p90_payment_day: invoiceP90,
    engine_source: "typescript-fallback",
  };
}

const effectiveCost = (option: FinancingOptionInput, amount: number) =>
  amount <= 0
    ? 0
    : (option.origination_fee_pct ?? 0) * amount + amount * option.apr * (BRIDGE_TERM_DAYS / 365);

const costPerDollar = (option: FinancingOptionInput) =>
  (option.origination_fee_pct ?? 0) + option.apr * (BRIDGE_TERM_DAYS / 365);

/** An invoice stuck in a GR/IR exception queue is not collateral a factor will advance against. */
const MATCH_EXCEPTIONS = new Set<string>(["QTY_VARIANCE", "PRICE_VARIANCE"]);

export const pledgeableAr = (state: SmeFinancialState): number =>
  state.invoices_ar
    .filter((i) => !MATCH_EXCEPTIONS.has(i.match_status ?? "MATCH_CLEAN") && (i.inflow_kind ?? "invoice") === "invoice")
    .reduce((sum, i) => sum + i.amount, 0);

export function rankFinancingOptions(
  state: SmeFinancialState,
  crunchDay: number | null,
): MatchedFinancingOption[] {
  const pledgeable = pledgeableAr(state);

  const matched = state.financing_options.map((option) => {
    let available = option.max_amount;
    let reason: string | null = null;

    if (state.credit_score < (option.min_credit_score ?? 0)) {
      available = 0;
      reason = `credit score ${state.credit_score} below minimum ${option.min_credit_score}`;
    } else if (crunchDay !== null && option.funding_days >= crunchDay) {
      available = 0;
      reason = `funds in ${option.funding_days}d, needed by day ${crunchDay}`;
    } else if (option.requires_ar_collateral) {
      available = Math.min(available, (option.ar_coverage_ratio ?? 0.8) * pledgeable);
      if (available <= 0) reason = "no AR available to pledge as collateral";
    }

    const basis = available || option.max_amount;
    return {
      id: option.id,
      provider: option.provider,
      product_type: option.product_type,
      eligible: reason === null,
      rejection_reason: reason,
      max_available: round2(available),
      effective_cost_30d: round2(effectiveCost(option, available)),
      effective_apr:
        Math.round((effectiveCost(option, basis) / basis) * (365 / BRIDGE_TERM_DAYS) * 10000) / 10000,
      funding_days: option.funding_days,
      rank: 0,
    };
  });

  // Cheapest usable capital first; rejected quotes sink to the bottom.
  matched.sort((a, b) =>
    a.eligible === b.eligible ? a.effective_apr - b.effective_apr : a.eligible ? -1 : 1,
  );
  matched.forEach((m, i) => (m.rank = i + 1));
  return matched;
}

interface Lever {
  action: PlanAction;
  gain: number;
  cost: number;
  risk: number;
}

/**
 * How far a bill can actually move.
 *
 * Trade-credit insurers withdraw cover once an account runs past their cap,
 * which converts the supplier to cash-in-advance and puts the SME on a bureau
 * delinquency file. That is not a fee to trade off, so the window is clamped
 * before the search sees it. Mirrors `deferral_days` in `optimizer.py`.
 */
export const deferralDays = (ap: ApPayableInput): number =>
  Math.min(ap.max_deferral_days ?? 0, ap.insurance_revocation_day_cap ?? 30);

/**
 * Goodwill is a stock, not a rate: a long-standing partner absorbs the first
 * schedule change at no cash surcharge, and prices the next one like anyone
 * else's. Mirrors `deferral_fee_pct` in `optimizer.py`.
 */
export const deferralFeePct = (ap: ApPayableInput): number =>
  (ap.deferral_fee_pct ?? 0) + ((ap.past_extension_count ?? 0) >= 1 ? ap.extension_surcharge_pct ?? 0 : 0);

export const ESCALATION_NOTE =
  "No combination of AR discounts, AP deferrals and eligible facilities closes the gap. " +
  "Escalate to a bank workout or an equity injection; drawing more debt into an unclosed " +
  "gap buys days and adds a creditor.";

export function localOptimize(
  state: SmeFinancialState,
  forecast: ForecastResult = localForecast(state),
): OptimizationResult {
  const matched = rankFinancingOptions(state, forecast.first_shortfall_day);
  const buffer = state.minimum_safe_buffer;

  if (!forecast.shortfall_detected || forecast.first_shortfall_day === null) {
    const p10 = forecast.p10_trajectory[forecast.p10_trajectory.length - 1];
    const idle = (name: string, notes: string): RecoveryPlanResult => ({
      name,
      actions: [{ kind: "none", target_id: "-", label: "No action required", cash_impact: 0, cost: 0, detail: "" }],
      cash_raised: 0,
      total_cost: 0,
      post_recovery_p10_balance: p10,
      meets_buffer: true,
      feasible: true,
      breaches_statutory_payroll: false,
      notes,
    });
    return {
      company_name: forecast.company_name,
      crunch_day: 0,
      required_cash: 0,
      optimal_plan: idle("Vantora optimal plan", "P10 cash stays above the safe buffer."),
      baseline_do_nothing_plan: idle("Baseline: do nothing", "Nothing to recover from."),
      naive_borrowing_plan: idle("Naive: borrow everything", "Borrowing would be pure cost."),
      matched_financing_options: matched,
      solver_status: "Optimal",
      mathematical_proof_summary: "No liquidity shortfall detected across 1,000 simulated trajectories.",
      savings_vs_naive: 0,
      savings_vs_do_nothing: 0,
      engine_source: "typescript-fallback",
    };
  }

  const crunchDay = forecast.first_shortfall_day;
  const p10AtCrunch = forecast.p10_trajectory[crunchDay - 1];
  const required = buffer - p10AtCrunch;
  const riskPrice = state.relationship_risk_price ?? 2000;
  const riskBudget = state.max_relationship_risk ?? 1;

  const levers: Lever[] = [];
  for (const inv of state.invoices_ar) {
    const settles = inv.early_payment_settles_in_days ?? 3;
    const discount = inv.early_payment_discount_pct ?? 0.02;
    if (!inv.early_payment_discount_eligible || settles > crunchDay) continue;
    if ((forecast.invoice_p90_payment_day[inv.id] ?? 0) <= crunchDay) continue;
    levers.push({
      gain: inv.amount * (1 - discount),
      cost: inv.amount * discount,
      risk: 0,
      action: {
        kind: "ar_early_discount",
        target_id: inv.id,
        label: `Offer ${(discount * 100).toFixed(1)}% early-pay discount to ${inv.customer_name}`,
        cash_impact: round2(inv.amount * (1 - discount)),
        cost: round2(inv.amount * discount),
        detail: `$${inv.amount.toLocaleString()} invoice settles in ${settles}d`,
      },
    });
  }
  for (const ap of state.payables_ap) {
    // Wages are never a lever, whatever the record says. Mirrors the guard in
    // `optimizer.py`: the feasibility boundary belongs to the engine, not to
    // whichever fixture happens to set is_flexible.
    if (ap.is_payroll) continue;
    if (!ap.is_flexible || ap.due_day > crunchDay) continue;
    const days = deferralDays(ap);
    if (ap.due_day + days <= crunchDay) continue;
    const fee = ap.amount * deferralFeePct(ap);
    const risk = ap.relationship_risk ?? 0;
    const goodwillSpent = (ap.past_extension_count ?? 0) >= 1 && (ap.extension_surcharge_pct ?? 0) > 0;
    levers.push({
      gain: ap.amount,
      cost: fee + risk * riskPrice,
      risk,
      action: {
        kind: "ap_deferral",
        target_id: ap.id,
        label: `Defer ${ap.supplier_name} by ${days}d`,
        cash_impact: round2(ap.amount),
        cost: round2(fee + risk * riskPrice),
        detail:
          `$${round2(fee).toLocaleString()} deferral fee + $${round2(risk * riskPrice).toLocaleString()} relationship risk` +
          (goodwillSpent
            ? `; includes a ${((ap.extension_surcharge_pct ?? 0) * 100).toFixed(1)}% step surcharge, goodwill already spent`
            : ""),
      },
    });
  }

  const facilities = matched
    .filter((m) => m.eligible && m.max_available > 0)
    .map((m) => ({ matched: m, option: state.financing_options.find((o) => o.id === m.id)! }))
    .sort((a, b) => costPerDollar(a.option) - costPerDollar(b.option));
  const financingRate = facilities.length ? costPerDollar(facilities[0].option) : Infinity;

  // ponytail: greedy cost-per-dollar surrogate for the Python MILP. A binary
  // lever is only taken when it beats financing the slice of the gap it covers,
  // which reproduces the MILP optimum on the seeded dataset. Python is
  // authoritative whenever the engine is reachable.
  const actions: PlanAction[] = [];
  let gap = required;
  let riskSpent = 0;
  let cashRaised = 0;
  let totalCost = 0;

  const takeLever = (lever: Lever) => {
    actions.push(lever.action);
    riskSpent += lever.risk;
    cashRaised += lever.gain;
    totalCost += lever.cost;
    gap -= lever.gain;
  };

  const byUnitCost = levers.sort((a, b) => a.cost / a.gain - b.cost / b.gain);
  const skipped: Lever[] = [];
  for (const lever of byUnitCost) {
    if (gap <= 0) break;
    if (riskSpent + lever.risk > riskBudget + 1e-9) continue;
    const slice = Math.min(gap, lever.gain);
    if (lever.cost >= slice * financingRate) {
      skipped.push(lever); // cheaper to borrow this slice -- unless borrowing runs out
      continue;
    }
    takeLever(lever);
  }

  for (const { matched: m, option } of facilities) {
    if (gap <= 1e-6) break;
    const draw = Math.min(gap, m.max_available);
    const cost = effectiveCost(option, draw);
    actions.push({
      kind: "bridge_draw",
      target_id: option.id,
      label: `Draw $${Math.round(draw).toLocaleString()} from ${option.provider}`,
      cash_impact: round2(draw),
      cost: round2(cost),
      detail: `${((option.origination_fee_pct ?? 0) * 100).toFixed(1)}% fee + ${(option.apr * 100).toFixed(
        1,
      )}% APR for ${BRIDGE_TERM_DAYS}d`,
    });
    cashRaised += draw;
    totalCost += cost;
    gap -= draw;
  }

  // Every facility is drawn to the ceiling and the gap is still open, so the
  // levers that lost to borrowing on price are now the only cash left.
  for (const lever of skipped) {
    if (gap <= 1e-6) break;
    if (riskSpent + lever.risk > riskBudget + 1e-9) continue;
    takeLever(lever);
  }

  const feasible = gap <= 1e-6;
  const optimal: RecoveryPlanResult = {
    name: "Vantora optimal plan",
    actions: feasible ? actions : [],
    cash_raised: feasible ? round2(cashRaised) : 0,
    total_cost: feasible ? round2(totalCost) : 0,
    post_recovery_p10_balance: round2(p10AtCrunch + (feasible ? cashRaised : 0)),
    meets_buffer: feasible,
    feasible,
    breaches_statutory_payroll: false,
    notes: feasible
      ? `Greedy cost-per-dollar mix closing a $${Math.round(required).toLocaleString()} gap on day ${crunchDay}.`
      : ESCALATION_NOTE,
  };

  // Do nothing: the money runs out on what is due from the crunch day onward.
  let unfunded = required;
  const missed: PlanAction[] = [];
  let doNothingCost = 0;
  let breachesPayroll = false;
  for (const ap of state.payables_ap
    .filter((p) => p.due_day >= crunchDay)
    .sort((a, b) => a.due_day - b.due_day)) {
    if (unfunded <= 0) break;
    const unpaid = Math.min(ap.amount, unfunded);
    unfunded -= unpaid;
    const penalty = (ap.late_fee_pct ?? 0) * unpaid + (ap.is_critical ? ap.default_penalty ?? 0 : 0);
    doNothingCost += penalty;
    if (ap.is_payroll) breachesPayroll = true;
    missed.push({
      kind: "missed_payable",
      target_id: ap.id,
      label: `Miss ${ap.supplier_name} ($${Math.round(unpaid).toLocaleString()} unpaid)`,
      cash_impact: 0,
      cost: round2(penalty),
      detail: `${ap.is_payroll ? "STATUTORY BREACH: wages unpaid on the due date. " : ""}${(
        (ap.late_fee_pct ?? 0) * 100
      ).toFixed(1)}% late fee${
        ap.is_critical ? ` + $${(ap.default_penalty ?? 0).toLocaleString()} default penalty` : ""
      }`,
    });
  }

  const doNothing: RecoveryPlanResult = {
    name: "Baseline: do nothing",
    actions: missed,
    cash_raised: 0,
    total_cost: round2(doNothingCost),
    post_recovery_p10_balance: round2(p10AtCrunch),
    meets_buffer: false,
    // Wages are not a line item to trade off against a late fee, so a baseline
    // that leaves payroll unpaid is not an option at any price.
    feasible: !breachesPayroll,
    breaches_statutory_payroll: breachesPayroll,
    notes:
      `$${Math.round(required).toLocaleString()} of obligations go unfunded on day ${crunchDay}.` +
      (breachesPayroll
        ? " Payroll goes unpaid, which is a statutory breach — not a priced trade-off."
        : ""),
  };

  const usable = matched.filter((m) => m.eligible && m.max_available > 0);
  const worst = usable.length
    ? usable.reduce((a, b) => (a.effective_apr >= b.effective_apr ? a : b))
    : null;
  let naive: RecoveryPlanResult;
  if (worst) {
    const option = state.financing_options.find((o) => o.id === worst.id)!;
    const draw = Math.min(required, worst.max_available);
    const cost = effectiveCost(option, draw);
    naive = {
      name: "Naive: borrow everything",
      actions: [
        {
          kind: "bridge_draw",
          target_id: option.id,
          label: `Draw $${Math.round(draw).toLocaleString()} from ${option.provider}`,
          cash_impact: round2(draw),
          cost: round2(cost),
          detail: `${(worst.effective_apr * 100).toFixed(1)}% effective APR`,
        },
      ],
      cash_raised: round2(draw),
      total_cost: round2(cost),
      post_recovery_p10_balance: round2(p10AtCrunch + draw),
      meets_buffer: p10AtCrunch + draw >= buffer - 1e-6,
      feasible: p10AtCrunch + draw >= buffer - 1e-6,
      breaches_statutory_payroll: false,
      notes: "Covers the gap but ignores free working-capital levers.",
    };
  } else {
    naive = { ...doNothing, name: "Naive: borrow everything" };
  }

  const headroom = usable.reduce((sum, m) => sum + m.max_available, 0);
  return {
    company_name: forecast.company_name,
    crunch_day: crunchDay,
    required_cash: round2(required),
    optimal_plan: optimal,
    baseline_do_nothing_plan: doNothing,
    naive_borrowing_plan: naive,
    matched_financing_options: matched,
    solver_status: feasible ? "Optimal" : "INFEASIBLE",
    mathematical_proof_summary: (feasible
      ? [
          `Crunch day ${crunchDay}: P10 cash $${Math.round(p10AtCrunch).toLocaleString()} vs safe buffer $${buffer.toLocaleString()} -> gap $${Math.round(required).toLocaleString()}.`,
          `Fallback mirror status: Optimal (greedy cost-per-dollar over ${levers.length} working-capital levers + ${usable.length} eligible facilities).`,
          `Optimal plan raises $${Math.round(cashRaised).toLocaleString()} for $${round2(totalCost).toLocaleString()} -> post-recovery P10 $${Math.round(p10AtCrunch + cashRaised).toLocaleString()}.`,
          `Naive borrowing costs $${naive.total_cost.toLocaleString()}; doing nothing costs $${doNothing.total_cost.toLocaleString()}.`,
        ]
      : [
          `Crunch day ${crunchDay}: P10 cash $${Math.round(p10AtCrunch).toLocaleString()} vs safe buffer $${buffer.toLocaleString()} -> gap $${Math.round(required).toLocaleString()}.`,
          `Fallback mirror status: INFEASIBLE over ${levers.length} working-capital levers + ${usable.length} eligible facilities.`,
          `Total eligible facility headroom is $${Math.round(headroom).toLocaleString()} against a $${Math.round(required).toLocaleString()} gap.`,
          ESCALATION_NOTE,
        ]
    ).join("\n"),
    savings_vs_naive: feasible ? round2(naive.total_cost - totalCost) : 0,
    savings_vs_do_nothing: feasible ? round2(doNothing.total_cost - totalCost) : 0,
    engine_source: "typescript-fallback",
  };
}
