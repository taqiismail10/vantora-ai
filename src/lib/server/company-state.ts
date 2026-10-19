/**
 * Turns a company's persisted records into the engine's input contract, and
 * says plainly what the resulting forecast does and does not rest on.
 *
 * `SmeFinancialState` is what the forecaster, the MILP optimizer, the
 * financing ranker and the copilot all consume. Building it here is what lets
 * a real company use the existing engine unchanged.
 *
 * Two honesty rules are enforced in this file, because this is the last place
 * that knows what the owner actually entered:
 *
 *   1. **Nothing is silently dropped.** The engine window is a fixed number of
 *      days, so an overdue bill and a bill falling after the window are each
 *      handled explicitly and reported — never quietly omitted.
 *   2. **An absent figure is never a convenient one.** Unstated deferral terms
 *      make a bill fixed, not free to move; an unstated credit score screens a
 *      facility out rather than qualifying for it. Every such substitution
 *      appears in the coverage report.
 */

import type { ApPayableInput, ArInvoiceInput, FinancingOptionInput, SmeFinancialState } from "../quant-client";
import { sha256 } from "../sandbox/execution-logger";
import { getPolicies, type Company } from "./companies";
import { companyRecords } from "./records";
import { formatCents, fromCents } from "./money";

/** The engine validates `due_day` as 1..30; see quant_engine/schemas.py. */
export const ENGINE_HORIZON_DAYS = 30;

export type CoverageLevel = "blocking" | "warning" | "info";

export interface CoverageNote {
  level: CoverageLevel;
  code: string;
  message: string;
}

export interface CompanyDataset {
  company: Company;
  /** Null when `coverage` holds a blocking note: there is nothing to forecast. */
  state: SmeFinancialState | null;
  coverage: CoverageNote[];
  asOf: string;
  horizonDays: number;
  /**
   * Fingerprint of everything the forecast was computed from, including the
   * as-of date. It stands in for `DATASET_VERSION` in the plan version, so
   * editing one company's records invalidates that company's outstanding
   * approvals and leaves every other company's alone.
   */
  dataVersion: string;
  counts: {
    accounts: number;
    receivables: number;
    payables: number;
    facilities: number;
    overdue: number;
    beyondHorizon: number;
  };
}

const today = (): string => new Date().toISOString().slice(0, 10);

const dayNumber = (asOf: string, date: string): number => {
  const ms = Date.parse(`${date}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1; // due today is day 1
};

const numberOr = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return raw !== undefined && Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Build the engine input for one company.
 *
 * `asOf` defaults to today. Day offsets are computed from it, so a forecast is
 * only valid as of the moment it was computed — which is why the as-of date
 * travels with the result.
 */
export function companyDataset(company: Company, asOf = today()): CompanyDataset {
  const { accounts, receivables, payables, facilities } = companyRecords(company.id);
  const policies = getPolicies(company.id);
  const coverage: CoverageNote[] = [];

  let overdue = 0;
  let beyondHorizon = 0;
  let beyondHorizonCents = 0;

  // --- Cash -------------------------------------------------------------
  const open = accounts.filter((a) => !a.isRestricted);
  const restricted = accounts.filter((a) => a.isRestricted);
  const currentCents = open.reduce((sum, a) => sum + a.openingCents, 0);

  if (accounts.length === 0) {
    coverage.push({
      level: "blocking",
      code: "no_accounts",
      message: "Add at least one account with its balance and the date that balance was true, so the forecast has a starting point.",
    });
  } else {
    coverage.push({
      level: "info",
      code: "balances_not_reconciled",
      message:
        "Balances are as you entered them. Vantora has not connected to a bank, so nothing here is reconciled against a bank statement.",
    });
    const oldest = accounts.reduce((min, a) => (a.asOfDate < min ? a.asOfDate : min), accounts[0].asOfDate);
    const staleDays = dayNumber(oldest, asOf) - 1;
    if (staleDays > 7) {
      coverage.push({
        level: "warning",
        code: "stale_balance",
        message: `The oldest opening balance is dated ${oldest}, ${staleDays} days ago. Anything that has moved since then is not reflected unless you entered it.`,
      });
    }
    if (restricted.length) {
      coverage.push({
        level: "info",
        code: "restricted_cash",
        message: `${restricted.length} account${restricted.length === 1 ? " is" : "s are"} marked restricted and excluded from available cash.`,
      });
    }
  }

  // --- Receivables ------------------------------------------------------
  const invoices: ArInvoiceInput[] = [];
  let assumedReliability = 0;
  for (const receivable of receivables) {
    if (receivable.status === "cancelled") continue;
    const day = dayNumber(asOf, receivable.dueDate);
    if (day > ENGINE_HORIZON_DAYS) {
      beyondHorizon += 1;
      beyondHorizonCents += receivable.amountCents;
      continue;
    }
    if (day < 1) overdue += 1;
    const terms = receivable.terms;
    const reliability = typeof terms.reliability_score === "number" ? terms.reliability_score : undefined;
    if (reliability === undefined) assumedReliability += 1;
    // A disputed invoice is not expected cash: it stays on the books but is
    // not offered to the optimizer as collectable.
    if (receivable.status === "disputed") continue;
    invoices.push({
      id: receivable.id,
      customer_name: receivable.counterpartyName,
      amount: fromCents(receivable.amountCents),
      due_day: Math.max(1, Math.min(ENGINE_HORIZON_DAYS, day)),
      expected_delay_days_mean: typeof terms.expected_delay_days_mean === "number" ? terms.expected_delay_days_mean : 0,
      expected_delay_days_std: typeof terms.expected_delay_days_std === "number" ? terms.expected_delay_days_std : 1,
      reliability_score: reliability ?? 0.8,
      ...(typeof terms.early_payment_discount_eligible === "boolean"
        ? { early_payment_discount_eligible: terms.early_payment_discount_eligible }
        : {}),
      ...(typeof terms.early_payment_discount_pct === "number"
        ? { early_payment_discount_pct: terms.early_payment_discount_pct }
        : {}),
      ...(typeof terms.early_payment_settles_in_days === "number"
        ? { early_payment_settles_in_days: terms.early_payment_settles_in_days }
        : {}),
      ...(typeof terms.revenue_concentration_pct === "number"
        ? { revenue_concentration_pct: terms.revenue_concentration_pct }
        : {}),
    });
  }

  const disputed = receivables.filter((r) => r.status === "disputed").length;
  if (disputed) {
    coverage.push({
      level: "warning",
      code: "disputed_receivables",
      message: `${disputed} invoice${disputed === 1 ? " is" : "s are"} marked disputed and excluded from expected cash in.`,
    });
  }
  if (assumedReliability) {
    coverage.push({
      level: "warning",
      code: "assumed_reliability",
      message: `${assumedReliability} invoice${assumedReliability === 1 ? "" : "s"} have no collection expectation recorded, so a neutral one is assumed. This is an assumption, not a measurement from payment history.`,
    });
  }

  // --- Payables ---------------------------------------------------------
  const bills: ApPayableInput[] = [];
  let unstatedTerms = 0;
  for (const payable of payables) {
    if (payable.status === "cancelled") continue;
    const day = dayNumber(asOf, payable.dueDate);
    if (day > ENGINE_HORIZON_DAYS) {
      beyondHorizon += 1;
      beyondHorizonCents += payable.amountCents;
      continue;
    }
    if (day < 1) overdue += 1;
    const terms = payable.terms;
    // Not stated means not movable. The optimizer never learns of flexibility
    // nobody claimed.
    const flexible = terms.is_flexible === true;
    if (terms.is_flexible === undefined) unstatedTerms += 1;
    const lockDay = payable.payrollLockDate
      ? Math.max(1, Math.min(ENGINE_HORIZON_DAYS, dayNumber(asOf, payable.payrollLockDate)))
      : null;
    bills.push({
      id: payable.id,
      supplier_name: payable.counterpartyName,
      amount: fromCents(payable.amountCents),
      due_day: Math.max(1, Math.min(ENGINE_HORIZON_DAYS, day)),
      is_flexible: flexible,
      ...(flexible && typeof terms.max_deferral_days === "number"
        ? { max_deferral_days: terms.max_deferral_days }
        : { max_deferral_days: 0 }),
      ...(typeof terms.deferral_fee_pct === "number" ? { deferral_fee_pct: terms.deferral_fee_pct } : {}),
      ...(typeof terms.relationship_risk === "number" ? { relationship_risk: terms.relationship_risk } : {}),
      ...(typeof terms.late_fee_pct === "number" ? { late_fee_pct: terms.late_fee_pct } : {}),
      ...(typeof terms.is_critical === "boolean" ? { is_critical: terms.is_critical } : {}),
      ...(typeof terms.archetype === "string"
        ? { supplier_archetype: terms.archetype as ApPayableInput["supplier_archetype"] }
        : {}),
      ...(typeof terms.line_stop_risk === "string" ? { line_stop_risk: terms.line_stop_risk } : {}),
      is_payroll: payable.isPayroll,
      ...(lockDay !== null ? { payroll_lock_day: lockDay } : {}),
    });
  }

  if (unstatedTerms) {
    coverage.push({
      level: "warning",
      code: "unstated_deferral_terms",
      message: `${unstatedTerms} bill${unstatedTerms === 1 ? " has" : "s have"} no deferral terms recorded, so ${unstatedTerms === 1 ? "it is" : "they are"} treated as fixed. Recording real terms may reveal cheaper options.`,
    });
  }

  // Payroll: never entered is not the same as none.
  const payrollStatus = policies.payroll_status?.value;
  const hasPayroll = payables.some((p) => p.isPayroll && p.status !== "cancelled");
  if (!hasPayroll && payrollStatus !== "none") {
    coverage.push({
      level: "warning",
      code: "payroll_not_entered",
      message:
        "No payroll obligation has been entered. Payroll is the obligation most likely to make a forecast wrong, so this projection may overstate the cash you can use.",
    });
  } else if (!hasPayroll && payrollStatus === "none") {
    coverage.push({
      level: "info",
      code: "payroll_none",
      message: "You have recorded that this company has no payroll obligation.",
    });
  }

  // --- Financing --------------------------------------------------------
  const options: FinancingOptionInput[] = facilities.map((facility) => ({
    id: facility.id,
    provider: facility.provider,
    product_type: facility.productType as FinancingOptionInput["product_type"],
    max_amount: fromCents(facility.maxAmountCents),
    apr: facility.apr,
    funding_days: typeof facility.terms.funding_days === "number" ? facility.terms.funding_days : 30,
    ...(typeof facility.terms.origination_fee_pct === "number"
      ? { origination_fee_pct: facility.terms.origination_fee_pct }
      : {}),
    ...(typeof facility.terms.min_credit_score === "number" ? { min_credit_score: facility.terms.min_credit_score } : {}),
    ...(typeof facility.terms.requires_ar_collateral === "boolean"
      ? { requires_ar_collateral: facility.terms.requires_ar_collateral }
      : {}),
    ...(typeof facility.terms.ar_coverage_ratio === "number" ? { ar_coverage_ratio: facility.terms.ar_coverage_ratio } : {}),
    ...(typeof facility.terms.is_existing_facility === "boolean"
      ? { is_existing_facility: facility.terms.is_existing_facility }
      : {}),
  }));

  if (options.length === 0) {
    coverage.push({
      level: "info",
      code: "no_facilities",
      message:
        "No financing facilities are recorded, so only internal options (collecting earlier, paying later) are compared. No borrowing option is invented.",
    });
  }

  // --- Policy -----------------------------------------------------------
  const bufferCents = numberOr(policies.minimum_safe_buffer_cents?.value, 0);
  if (policies.minimum_safe_buffer_cents === undefined) {
    coverage.push({
      level: "warning",
      code: "no_buffer",
      message:
        "No minimum cash buffer is set, so a shortage is only flagged when cash would fall below zero. Set the balance you never want to drop under.",
    });
  }
  const creditScore = numberOr(policies.credit_score?.value, 0);
  if (policies.credit_score === undefined && options.some((o) => o.min_credit_score !== undefined)) {
    coverage.push({
      level: "warning",
      code: "no_credit_score",
      message:
        "No credit score is recorded, so facilities that require one are screened out rather than assumed to qualify.",
    });
  }
  const monthlyRevenueCents = numberOr(policies.monthly_revenue_cents?.value, 0);
  if (policies.monthly_revenue_cents === undefined) {
    coverage.push({
      level: "info",
      code: "no_revenue",
      message: "Monthly revenue is not recorded, so working-capital ratios (DSO, DPO) are not shown.",
    });
  }

  // --- Window edges -----------------------------------------------------
  if (overdue) {
    coverage.push({
      level: "warning",
      code: "overdue",
      message: `${overdue} record${overdue === 1 ? " is" : "s are"} already past due and treated as payable or collectable immediately (day 1).`,
    });
  }
  if (beyondHorizon) {
    coverage.push({
      level: "info",
      code: "beyond_horizon",
      message: `${beyondHorizon} record${beyondHorizon === 1 ? "" : "s"} totalling ${formatCents(
        beyondHorizonCents,
        company.currency,
      )} fall after the ${ENGINE_HORIZON_DAYS}-day forecast window and are not included in it. They are kept on file, not discarded.`,
    });
  }

  const dataVersion = sha256(
    JSON.stringify({
      asOf,
      currency: company.currency,
      accounts: accounts.map((a) => [a.id, a.openingCents, a.asOfDate, a.isRestricted]),
      receivables: receivables.map((r) => [r.id, r.amountCents, r.dueDate, r.status, r.terms]),
      payables: payables.map((p) => [p.id, p.amountCents, p.dueDate, p.status, p.isPayroll, p.payrollLockDate, p.terms]),
      facilities: facilities.map((f) => [f.id, f.maxAmountCents, f.apr, f.terms]),
      policies: Object.entries(policies).map(([k, v]) => [k, v?.value]),
    }),
  ).slice(0, 12);

  const counts = {
    accounts: accounts.length,
    receivables: receivables.length,
    payables: payables.length,
    facilities: facilities.length,
    overdue,
    beyondHorizon,
  };

  if (coverage.some((note) => note.level === "blocking")) {
    return { company, state: null, coverage, asOf, horizonDays: ENGINE_HORIZON_DAYS, counts, dataVersion };
  }

  if (invoices.length === 0 && bills.length === 0) {
    coverage.push({
      level: "warning",
      code: "balance_only",
      message:
        "No invoices or bills fall inside the forecast window, so this projects your current balance forward with nothing moving. Add what you expect to receive and pay.",
    });
  }

  const state: SmeFinancialState = {
    current_cash: fromCents(currentCents),
    minimum_safe_buffer: fromCents(bufferCents),
    credit_score: creditScore,
    monthly_revenue: fromCents(monthlyRevenueCents),
    invoices_ar: invoices,
    payables_ap: bills,
    financing_options: options,
    company_name: company.name,
    horizon_days: ENGINE_HORIZON_DAYS,
    ...(policies.gross_margin ? { gross_margin: numberOr(policies.gross_margin.value, 0.3) } : {}),
  };

  return { company, state, coverage, asOf, horizonDays: ENGINE_HORIZON_DAYS, counts, dataVersion };
}

/** The one-line headline a dashboard shows above a sparse forecast. */
export function coverageHeadline(coverage: CoverageNote[]): string | null {
  const blocking = coverage.find((n) => n.level === "blocking");
  if (blocking) return blocking.message;
  const warnings = coverage.filter((n) => n.level === "warning");
  if (warnings.length === 0) return null;
  return warnings.length === 1
    ? warnings[0].message
    : `${warnings.length} things could make this forecast wrong. Review the coverage notes before relying on it.`;
}
