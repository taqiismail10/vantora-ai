/**
 * A company's own financial records: accounts, counterparties, receivables,
 * payables and financing facilities.
 *
 * Two rules shape everything here:
 *
 *   1. **Every read and write is scoped by `companyId`.** No function takes a
 *      record id without also taking the company it must belong to, so a stray
 *      id from another tenant selects nothing rather than someone else's row.
 *   2. **An unspecified constraint is never a permissive one.** A payable whose
 *      flexibility the owner never stated is treated as not deferrable, not as
 *      freely deferrable. What was assumed is reported in the coverage
 *      statement rather than hidden (`company-state.ts`).
 *
 * Terms are stored as a JSON snapshot on each record. A counterparty's defaults
 * seed that snapshot at creation and never rewrite it afterwards, so changing a
 * default cannot retroactively alter a posted invoice.
 */

import { randomUUID } from "node:crypto";

import { db } from "./db";
import { AccessError } from "./identity";
import { MAX_CENTS, parseCents, type CurrencyCode } from "./money";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_DATE.test(value.trim())) {
    throw new AccessError(422, `${field} must be a date in YYYY-MM-DD form`);
  }
  const date = value.trim();
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new AccessError(422, `${field} is not a real calendar date`);
  }
  return date;
}

function amountCents(value: unknown, currency: CurrencyCode, field: string): number {
  const parsed = parseCents(value, currency);
  if (!parsed.ok) throw new AccessError(422, `${field}: ${parsed.reason}`);
  return parsed.cents;
}

const label = (value: unknown, field: string, max = 120): string => {
  if (typeof value !== "string") throw new AccessError(422, `${field} is required`);
  const clean = value.trim().replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ");
  if (!clean) throw new AccessError(422, `${field} is required`);
  return clean.slice(0, max);
};

const optionalText = (value: unknown, max = 120): string =>
  typeof value === "string" ? value.trim().replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, max) : "";

const num = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

const clamp = (value: number | undefined, lo: number, hi: number): number | undefined =>
  value === undefined ? undefined : Math.min(hi, Math.max(lo, value));

const bool = (value: unknown): boolean => value === true || value === "true" || value === 1 || value === "1";

function json(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// --- Accounts -------------------------------------------------------------

export interface CompanyAccount {
  id: string;
  name: string;
  openingCents: number;
  asOfDate: string;
  isRestricted: boolean;
}

export function listAccounts(companyId: string): CompanyAccount[] {
  const rows = db()
    .prepare("SELECT id, name, opening_cents, as_of_date, is_restricted FROM company_account WHERE company_id = ? ORDER BY created_at")
    .all(companyId) as { id: string; name: string; opening_cents: number; as_of_date: string; is_restricted: number }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    openingCents: r.opening_cents,
    asOfDate: r.as_of_date,
    isRestricted: r.is_restricted === 1,
  }));
}

export function addAccount(
  companyId: string,
  currency: CurrencyCode,
  input: { name: unknown; openingBalance: unknown; asOfDate: unknown; isRestricted?: unknown },
): CompanyAccount {
  const name = label(input.name, "account name", 80);
  // An opening balance of zero is meaningful (a new or drained account), so
  // this path accepts it where parseCents alone would not.
  const zero = input.openingBalance === 0 || input.openingBalance === "0";
  const openingCents = zero ? 0 : amountCents(input.openingBalance, currency, "opening balance");
  if (openingCents > MAX_CENTS) throw new AccessError(422, "opening balance exceeds the supported ceiling");
  const asOfDate = parseDate(input.asOfDate, "opening balance as-of date");
  if (asOfDate > new Date().toISOString().slice(0, 10)) {
    throw new AccessError(422, "the opening balance as-of date cannot be in the future");
  }
  const id = randomUUID();
  db()
    .prepare(
      "INSERT INTO company_account (id, company_id, name, opening_cents, as_of_date, is_restricted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, companyId, name, openingCents, asOfDate, bool(input.isRestricted) ? 1 : 0, Date.now());
  return { id, name, openingCents, asOfDate, isRestricted: bool(input.isRestricted) };
}

export function deleteAccount(companyId: string, id: string): void {
  db().prepare("DELETE FROM company_account WHERE company_id = ? AND id = ?").run(companyId, id);
}

// --- Counterparties -------------------------------------------------------

export type SupplierArchetype =
  | "MONOPOLY_STRICT"
  | "FLEXIBLE_PARTNER"
  | "COMMERCIAL_NEGOTIATOR"
  | "STATUTORY"
  | "OVERHEAD";

const ARCHETYPES: readonly string[] = [
  "MONOPOLY_STRICT",
  "FLEXIBLE_PARTNER",
  "COMMERCIAL_NEGOTIATOR",
  "STATUTORY",
  "OVERHEAD",
];

export interface Counterparty {
  id: string;
  name: string;
  isSupplier: boolean;
  isBuyer: boolean;
  country: string;
  /** Seeds a new record's terms snapshot; never rewrites an existing one. */
  defaultTerms: Record<string, unknown>;
  /** Supplier constraints the optimizer reads. Absent means "not stated". */
  profile: Record<string, unknown>;
}

function hydrateCounterparty(row: {
  id: string;
  name: string;
  is_supplier: number;
  is_buyer: number;
  country: string;
  default_terms_json: string;
  profile_json: string;
}): Counterparty {
  return {
    id: row.id,
    name: row.name,
    isSupplier: row.is_supplier === 1,
    isBuyer: row.is_buyer === 1,
    country: row.country,
    defaultTerms: json(row.default_terms_json),
    profile: json(row.profile_json),
  };
}

export function listCounterparties(companyId: string): Counterparty[] {
  const rows = db()
    .prepare("SELECT * FROM counterparty WHERE company_id = ? ORDER BY name")
    .all(companyId) as Parameters<typeof hydrateCounterparty>[0][];
  return rows.map(hydrateCounterparty);
}

export function getCounterparty(companyId: string, id: string): Counterparty | null {
  const row = db().prepare("SELECT * FROM counterparty WHERE company_id = ? AND id = ?").get(companyId, id) as
    | Parameters<typeof hydrateCounterparty>[0]
    | undefined;
  return row ? hydrateCounterparty(row) : null;
}

export interface CounterpartyInput {
  name: unknown;
  isSupplier?: unknown;
  isBuyer?: unknown;
  country?: unknown;
  /** Supplier constraints. Anything omitted stays unstated, not permissive. */
  archetype?: unknown;
  isCritical?: unknown;
  lineStopRisk?: unknown;
  relationshipRisk?: unknown;
  isFlexible?: unknown;
  maxDeferralDays?: unknown;
  deferralFeePct?: unknown;
}

function supplierProfile(input: CounterpartyInput): Record<string, unknown> {
  const profile: Record<string, unknown> = {};
  if (typeof input.archetype === "string" && ARCHETYPES.includes(input.archetype)) profile.archetype = input.archetype;
  if (input.isCritical !== undefined) profile.is_critical = bool(input.isCritical);
  const lineStop = optionalText(input.lineStopRisk, 200);
  if (lineStop) profile.line_stop_risk = lineStop;
  const risk = clamp(num(input.relationshipRisk), 0, 10);
  if (risk !== undefined) profile.relationship_risk = risk;
  if (input.isFlexible !== undefined) profile.is_flexible = bool(input.isFlexible);
  const maxDeferral = clamp(num(input.maxDeferralDays), 0, 180);
  if (maxDeferral !== undefined) profile.max_deferral_days = Math.round(maxDeferral);
  const fee = clamp(num(input.deferralFeePct), 0, 1);
  if (fee !== undefined) profile.deferral_fee_pct = fee;
  return profile;
}

export function addCounterparty(companyId: string, input: CounterpartyInput): Counterparty {
  const name = label(input.name, "counterparty name");
  const isSupplier = bool(input.isSupplier);
  const isBuyer = bool(input.isBuyer);
  if (!isSupplier && !isBuyer) throw new AccessError(422, "a counterparty must be a supplier, a buyer, or both");
  const id = randomUUID();
  const profile = supplierProfile(input);
  try {
    db()
      .prepare(
        `INSERT INTO counterparty (id, company_id, name, is_supplier, is_buyer, country, default_terms_json, profile_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(id, companyId, name, isSupplier ? 1 : 0, isBuyer ? 1 : 0, optionalText(input.country, 60), JSON.stringify(profile), Date.now());
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new AccessError(409, `"${name}" already exists for this company`);
    throw error;
  }
  return { id, name, isSupplier, isBuyer, country: optionalText(input.country, 60), defaultTerms: {}, profile };
}

/** Updating a profile affects future solves, never a posted record's own terms. */
export function updateCounterparty(companyId: string, id: string, input: CounterpartyInput): Counterparty {
  const existing = getCounterparty(companyId, id);
  if (!existing) throw new AccessError(404, "counterparty not found");
  const name = input.name === undefined ? existing.name : label(input.name, "counterparty name");
  const merged = { ...existing.profile, ...supplierProfile(input) };
  db()
    .prepare("UPDATE counterparty SET name = ?, is_supplier = ?, is_buyer = ?, country = ?, profile_json = ? WHERE company_id = ? AND id = ?")
    .run(
      name,
      input.isSupplier === undefined ? (existing.isSupplier ? 1 : 0) : bool(input.isSupplier) ? 1 : 0,
      input.isBuyer === undefined ? (existing.isBuyer ? 1 : 0) : bool(input.isBuyer) ? 1 : 0,
      input.country === undefined ? existing.country : optionalText(input.country, 60),
      JSON.stringify(merged),
      companyId,
      id,
    );
  return getCounterparty(companyId, id)!;
}

export function deleteCounterparty(companyId: string, id: string): void {
  const inUse = db()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM receivable WHERE company_id = ?1 AND counterparty_id = ?2)
            + (SELECT COUNT(*) FROM payable WHERE company_id = ?1 AND counterparty_id = ?2) AS n`,
    )
    .get(companyId, id) as { n: number };
  if (inUse.n > 0) throw new AccessError(409, "this counterparty still has invoices or bills; remove those first");
  db().prepare("DELETE FROM counterparty WHERE company_id = ? AND id = ?").run(companyId, id);
}

// --- Receivables ----------------------------------------------------------

export interface Receivable {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  externalId: string | null;
  amountCents: number;
  issueDate: string | null;
  dueDate: string;
  terms: Record<string, unknown>;
  status: "open" | "disputed" | "cancelled";
  source: string;
}

export function listReceivables(companyId: string): Receivable[] {
  const rows = db()
    .prepare(
      `SELECT r.*, c.name AS counterparty_name FROM receivable r
       JOIN counterparty c ON c.id = r.counterparty_id AND c.company_id = r.company_id
       WHERE r.company_id = ? ORDER BY r.due_date, r.created_at`,
    )
    .all(companyId) as {
    id: string;
    counterparty_id: string;
    counterparty_name: string;
    external_id: string | null;
    amount_cents: number;
    issue_date: string | null;
    due_date: string;
    terms_json: string;
    status: "open" | "disputed" | "cancelled";
    source: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    counterpartyId: r.counterparty_id,
    counterpartyName: r.counterparty_name,
    externalId: r.external_id,
    amountCents: r.amount_cents,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    terms: json(r.terms_json),
    status: r.status,
    source: r.source,
  }));
}

export interface ReceivableInput {
  counterpartyId: unknown;
  amount: unknown;
  dueDate: unknown;
  issueDate?: unknown;
  externalId?: unknown;
  /** Collection expectation — owner-entered, not derived from history. */
  expectedDelayDays?: unknown;
  reliabilityScore?: unknown;
  discountEligible?: unknown;
  discountPct?: unknown;
  discountSettlesInDays?: unknown;
  revenueConcentrationPct?: unknown;
  status?: unknown;
}

function receivableTerms(input: ReceivableInput, defaults: Record<string, unknown>): Record<string, unknown> {
  const terms: Record<string, unknown> = { ...defaults };
  const delay = clamp(num(input.expectedDelayDays), 0, 365);
  if (delay !== undefined) {
    terms.expected_delay_days_mean = delay;
    // Spread scales with the delay: a buyer expected to be late is also less
    // predictable. Owner-entered means, never a derived history.
    terms.expected_delay_days_std = Math.max(1, Math.round(delay * 0.4));
  }
  const reliability = clamp(num(input.reliabilityScore), 0, 1);
  if (reliability !== undefined) terms.reliability_score = reliability;
  if (input.discountEligible !== undefined) terms.early_payment_discount_eligible = bool(input.discountEligible);
  const pct = clamp(num(input.discountPct), 0, 1);
  if (pct !== undefined) terms.early_payment_discount_pct = pct;
  const settles = clamp(num(input.discountSettlesInDays), 0, 180);
  if (settles !== undefined) terms.early_payment_settles_in_days = Math.round(settles);
  const concentration = clamp(num(input.revenueConcentrationPct), 0, 1);
  if (concentration !== undefined) terms.revenue_concentration_pct = concentration;
  return terms;
}

export function addReceivable(companyId: string, currency: CurrencyCode, input: ReceivableInput): Receivable {
  const counterparty = getCounterparty(companyId, typeof input.counterpartyId === "string" ? input.counterpartyId : "");
  if (!counterparty) throw new AccessError(404, "select a buyer that belongs to this company");
  if (!counterparty.isBuyer) throw new AccessError(422, `${counterparty.name} is not marked as a buyer`);
  const amount = amountCents(input.amount, currency, "invoice amount");
  const dueDate = parseDate(input.dueDate, "due date");
  const issueDate = input.issueDate === undefined || input.issueDate === "" ? null : parseDate(input.issueDate, "issue date");
  if (issueDate && issueDate > dueDate) throw new AccessError(422, "the issue date cannot be after the due date");
  const externalId = optionalText(input.externalId, 64) || null;
  const terms = receivableTerms(input, counterparty.defaultTerms);
  const id = randomUUID();
  try {
    db()
      .prepare(
        `INSERT INTO receivable (id, company_id, counterparty_id, external_id, amount_cents, issue_date, due_date, terms_json, status, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
      )
      .run(id, companyId, counterparty.id, externalId, amount, issueDate, dueDate, JSON.stringify(terms), status(input.status), Date.now());
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new AccessError(409, `invoice reference "${externalId}" already exists`);
    throw error;
  }
  return {
    id,
    counterpartyId: counterparty.id,
    counterpartyName: counterparty.name,
    externalId,
    amountCents: amount,
    issueDate,
    dueDate,
    terms,
    status: status(input.status),
    source: "manual",
  };
}

const status = (value: unknown): "open" | "disputed" | "cancelled" =>
  value === "disputed" || value === "cancelled" ? value : "open";

export function setReceivableStatus(companyId: string, id: string, next: "open" | "disputed" | "cancelled"): void {
  const changed = db()
    .prepare("UPDATE receivable SET status = ? WHERE company_id = ? AND id = ?")
    .run(next, companyId, id);
  if (changed.changes === 0) throw new AccessError(404, "invoice not found");
}

export function deleteReceivable(companyId: string, id: string): void {
  db().prepare("DELETE FROM receivable WHERE company_id = ? AND id = ?").run(companyId, id);
}

// --- Payables -------------------------------------------------------------

export interface Payable {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  externalId: string | null;
  amountCents: number;
  dueDate: string;
  terms: Record<string, unknown>;
  isPayroll: boolean;
  payrollLockDate: string | null;
  status: "open" | "disputed" | "cancelled";
  source: string;
}

export function listPayables(companyId: string): Payable[] {
  const rows = db()
    .prepare(
      `SELECT p.*, c.name AS counterparty_name FROM payable p
       JOIN counterparty c ON c.id = p.counterparty_id AND c.company_id = p.company_id
       WHERE p.company_id = ? ORDER BY p.due_date, p.created_at`,
    )
    .all(companyId) as {
    id: string;
    counterparty_id: string;
    counterparty_name: string;
    external_id: string | null;
    amount_cents: number;
    due_date: string;
    terms_json: string;
    is_payroll: number;
    payroll_lock_date: string | null;
    status: "open" | "disputed" | "cancelled";
    source: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    counterpartyId: r.counterparty_id,
    counterpartyName: r.counterparty_name,
    externalId: r.external_id,
    amountCents: r.amount_cents,
    dueDate: r.due_date,
    terms: json(r.terms_json),
    isPayroll: r.is_payroll === 1,
    payrollLockDate: r.payroll_lock_date,
    status: r.status,
    source: r.source,
  }));
}

export interface PayableInput {
  counterpartyId: unknown;
  amount: unknown;
  dueDate: unknown;
  externalId?: unknown;
  isPayroll?: unknown;
  payrollLockDate?: unknown;
  /** Deferral constraints. Omitted stays unstated — the solve treats it as fixed. */
  isFlexible?: unknown;
  maxDeferralDays?: unknown;
  deferralFeePct?: unknown;
  lateFeePct?: unknown;
  relationshipRisk?: unknown;
  isCritical?: unknown;
  status?: unknown;
}

function payableTerms(input: PayableInput, profile: Record<string, unknown>): Record<string, unknown> {
  // The supplier profile seeds the snapshot; explicit per-bill values win.
  const terms: Record<string, unknown> = { ...profile };
  if (input.isFlexible !== undefined) terms.is_flexible = bool(input.isFlexible);
  const maxDeferral = clamp(num(input.maxDeferralDays), 0, 180);
  if (maxDeferral !== undefined) terms.max_deferral_days = Math.round(maxDeferral);
  const deferralFee = clamp(num(input.deferralFeePct), 0, 1);
  if (deferralFee !== undefined) terms.deferral_fee_pct = deferralFee;
  const lateFee = clamp(num(input.lateFeePct), 0, 1);
  if (lateFee !== undefined) terms.late_fee_pct = lateFee;
  const risk = clamp(num(input.relationshipRisk), 0, 10);
  if (risk !== undefined) terms.relationship_risk = risk;
  if (input.isCritical !== undefined) terms.is_critical = bool(input.isCritical);
  return terms;
}

export function addPayable(companyId: string, currency: CurrencyCode, input: PayableInput): Payable {
  const counterparty = getCounterparty(companyId, typeof input.counterpartyId === "string" ? input.counterpartyId : "");
  if (!counterparty) throw new AccessError(404, "select a supplier that belongs to this company");
  if (!counterparty.isSupplier) throw new AccessError(422, `${counterparty.name} is not marked as a supplier`);
  const amount = amountCents(input.amount, currency, "bill amount");
  const dueDate = parseDate(input.dueDate, "due date");
  const isPayroll = bool(input.isPayroll);
  let lockDate: string | null = null;
  if (input.payrollLockDate !== undefined && input.payrollLockDate !== "" && input.payrollLockDate !== null) {
    lockDate = parseDate(input.payrollLockDate, "payroll lock date");
    if (lockDate > dueDate) throw new AccessError(422, "the payroll lock date cannot be after the due date");
  }
  const externalId = optionalText(input.externalId, 64) || null;
  const terms = payableTerms(input, counterparty.profile);
  const id = randomUUID();
  try {
    db()
      .prepare(
        `INSERT INTO payable (id, company_id, counterparty_id, external_id, amount_cents, due_date, terms_json, is_payroll, payroll_lock_date, status, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
      )
      .run(
        id,
        companyId,
        counterparty.id,
        externalId,
        amount,
        dueDate,
        JSON.stringify(terms),
        isPayroll ? 1 : 0,
        lockDate,
        status(input.status),
        Date.now(),
      );
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new AccessError(409, `bill reference "${externalId}" already exists`);
    throw error;
  }
  return {
    id,
    counterpartyId: counterparty.id,
    counterpartyName: counterparty.name,
    externalId,
    amountCents: amount,
    dueDate,
    terms,
    isPayroll,
    payrollLockDate: lockDate,
    status: status(input.status),
    source: "manual",
  };
}

export function setPayableStatus(companyId: string, id: string, next: "open" | "disputed" | "cancelled"): void {
  const changed = db().prepare("UPDATE payable SET status = ? WHERE company_id = ? AND id = ?").run(next, companyId, id);
  if (changed.changes === 0) throw new AccessError(404, "bill not found");
}

export function deletePayable(companyId: string, id: string): void {
  db().prepare("DELETE FROM payable WHERE company_id = ? AND id = ?").run(companyId, id);
}

// --- Financing facilities -------------------------------------------------

const PRODUCT_TYPES: readonly string[] = ["invoice_factoring", "bridge_loan", "line_of_credit", "merchant_advance"];

export interface Facility {
  id: string;
  provider: string;
  productType: string;
  maxAmountCents: number;
  apr: number;
  terms: Record<string, unknown>;
}

export function listFacilities(companyId: string): Facility[] {
  const rows = db()
    .prepare("SELECT * FROM financing_facility WHERE company_id = ? ORDER BY created_at")
    .all(companyId) as {
    id: string;
    provider: string;
    product_type: string;
    max_amount_cents: number;
    apr: number;
    terms_json: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    productType: r.product_type,
    maxAmountCents: r.max_amount_cents,
    apr: r.apr,
    terms: json(r.terms_json),
  }));
}

export interface FacilityInput {
  provider: unknown;
  productType: unknown;
  maxAmount: unknown;
  apr: unknown;
  fundingDays?: unknown;
  originationFeePct?: unknown;
  requiresArCollateral?: unknown;
  arCoverageRatio?: unknown;
  isExistingFacility?: unknown;
  minCreditScore?: unknown;
}

export function addFacility(companyId: string, currency: CurrencyCode, input: FacilityInput): Facility {
  const provider = label(input.provider, "lender name", 80);
  if (typeof input.productType !== "string" || !PRODUCT_TYPES.includes(input.productType)) {
    throw new AccessError(422, `product type must be one of ${PRODUCT_TYPES.join(", ")}`);
  }
  const maxAmount = amountCents(input.maxAmount, currency, "facility limit");
  const apr = clamp(num(input.apr), 0, 5);
  if (apr === undefined) throw new AccessError(422, "APR is required, as a fraction (0.18 for 18%)");
  // Funding speed decides whether a facility can reach a dated obligation at
  // all, so an unstated value is treated as slow rather than instant.
  const fundingDays = clamp(num(input.fundingDays), 0, 180) ?? 30;
  const terms: Record<string, unknown> = {
    funding_days: Math.round(fundingDays),
    is_existing_facility: bool(input.isExistingFacility),
  };
  const fee = clamp(num(input.originationFeePct), 0, 1);
  if (fee !== undefined) terms.origination_fee_pct = fee;
  if (input.requiresArCollateral !== undefined) terms.requires_ar_collateral = bool(input.requiresArCollateral);
  const coverage = clamp(num(input.arCoverageRatio), 0, 10);
  if (coverage !== undefined) terms.ar_coverage_ratio = coverage;
  const minScore = clamp(num(input.minCreditScore), 0, 1000);
  if (minScore !== undefined) terms.min_credit_score = Math.round(minScore);

  const id = randomUUID();
  db()
    .prepare(
      "INSERT INTO financing_facility (id, company_id, provider, product_type, max_amount_cents, apr, terms_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, companyId, provider, input.productType, maxAmount, apr, JSON.stringify(terms), Date.now());
  return { id, provider, productType: input.productType, maxAmountCents: maxAmount, apr, terms };
}

export function deleteFacility(companyId: string, id: string): void {
  db().prepare("DELETE FROM financing_facility WHERE company_id = ? AND id = ?").run(companyId, id);
}

/** Everything a company owns, for the state builder and the coverage report. */
export function companyRecords(companyId: string) {
  return {
    accounts: listAccounts(companyId),
    counterparties: listCounterparties(companyId),
    receivables: listReceivables(companyId),
    payables: listPayables(companyId),
    facilities: listFacilities(companyId),
  };
}
