/** Fetch helpers for `/api/company`. One place that knows the route shape. */

import { SessionExpiredError } from "./client-api";
export { formatMinor } from "./currency";

export interface CompanySummary {
  id: string;
  name: string;
  role: "OWNER" | "ANALYST" | "VIEWER";
  status: string;
  isDemo: boolean;
}

export interface Company {
  id: string;
  name: string;
  industry: string;
  country: string;
  businessType: string;
  timezone: string;
  currency: "USD" | "BDT" | "CNY";
  locations: string[];
  status: "draft" | "active";
  isDemo: boolean;
  onboardingStep: "profile" | "accounts" | "records" | "policy" | "done";
}

export interface AccountRow {
  id: string;
  name: string;
  openingCents: number;
  asOfDate: string;
  isRestricted: boolean;
}

export interface CounterpartyRow {
  id: string;
  name: string;
  isSupplier: boolean;
  isBuyer: boolean;
  country: string;
  profile: Record<string, unknown>;
}

export interface ReceivableRow {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  externalId: string | null;
  amountCents: number;
  dueDate: string;
  status: "open" | "disputed" | "cancelled";
  terms: Record<string, unknown>;
  source: string;
}

export interface PayableRow {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  externalId: string | null;
  amountCents: number;
  dueDate: string;
  isPayroll: boolean;
  payrollLockDate: string | null;
  status: "open" | "disputed" | "cancelled";
  terms: Record<string, unknown>;
  source: string;
}

export interface FacilityRow {
  id: string;
  provider: string;
  productType: string;
  maxAmountCents: number;
  apr: number;
  terms: Record<string, unknown>;
}

export interface CoverageNote {
  level: "blocking" | "warning" | "info";
  code: string;
  message: string;
}

export interface PaymentRow {
  id: string;
  direction: "receipt" | "disbursement";
  counterpartyId: string | null;
  counterpartyName: string | null;
  amountCents: number;
  currency: string;
  effectiveDate: string;
  /** False when the money was already inside an opening balance. */
  affectsCash: boolean;
  method: string;
  reference: string | null;
  allocatedCents: number;
  unallocatedCents: number;
  reversedAt: number | null;
  reversalReason: string | null;
  recordedAt: number;
  createdBy: string;
}

export interface AdjustmentRow {
  id: string;
  kind: "credit_note" | "debit_note";
  targetKind: "receivable" | "payable";
  counterpartyId: string | null;
  amountCents: number;
  effectiveDate: string;
  reason: string;
  allocatedCents: number;
  unallocatedCents: number;
  reversedAt: number | null;
  reversalReason: string | null;
  recordedAt: number;
  createdBy: string;
}

export interface AllocationRow {
  id: string;
  sourceKind: "payment" | "adjustment";
  sourceId: string;
  targetKind: "receivable" | "payable";
  targetId: string;
  amountCents: number;
  reversedAt: number | null;
  recordedAt: number;
  createdBy: string;
}

export interface BalanceRow {
  id: string;
  kind: "receivable" | "payable";
  originalCents: number;
  adjustedCents: number;
  paidCents: number;
  remainingCents: number;
  settled: boolean;
}

export interface Settlement {
  payments: PaymentRow[];
  adjustments: AdjustmentRow[];
  allocations: AllocationRow[];
  balances: BalanceRow[];
  /** Payments dated on or before this are already inside an opening balance. */
  openingCutoff: string | null;
  netCashCents: number;
  futureCashCents: number;
}

export interface RecurringRow {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  category: "payroll" | "rent" | "utilities" | "other";
  amountCents: number;
  schedule: "weekly" | "monthly";
  scheduleDay: number;
  startDate: string;
  endDate: string | null;
  isPayroll: boolean;
  payrollLockOffsetDays: number | null;
  status: "active" | "paused" | "ended";
}

export interface OccurrenceRow {
  dueDate: string;
  occurrenceId: string;
  resolved: boolean;
  payableId: string | null;
  origin: "generated" | "linked" | null;
}

export interface MemberRow {
  userId: string;
  email: string;
  name: string;
  role: "OWNER" | "ANALYST" | "VIEWER";
}

export interface InvitationRow {
  id: string;
  email: string;
  role: "OWNER" | "ANALYST" | "VIEWER";
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
  status: "pending" | "accepted" | "revoked" | "expired";
}

export interface CompanyWorkspace {
  account: { userId: string; email: string; name: string };
  companies: CompanySummary[];
  active: {
    company: Company;
    role: "OWNER" | "ANALYST" | "VIEWER";
    records: {
      accounts: AccountRow[];
      counterparties: CounterpartyRow[];
      receivables: ReceivableRow[];
      payables: PayableRow[];
      facilities: FacilityRow[];
    };
    recurring: RecurringRow[];
    members: MemberRow[];
    invitations: InvitationRow[];
    settlement: Settlement;
    policies: Record<string, { value: string; effectiveFrom: string; setBy: string } | undefined>;
    coverage: CoverageNote[];
    counts: Record<string, number>;
    asOf: string;
    horizonDays: number;
    forecastable: boolean;
  } | null;
}

export async function fetchWorkspace(): Promise<CompanyWorkspace> {
  const response = await fetch("/api/company", { cache: "no-store" });
  if (response.status === 401) throw new SessionExpiredError();
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error ?? `/api/company failed with ${response.status}`);
  return payload as CompanyWorkspace;
}

/**
 * One company action. The server's `error` text is written for the person
 * reading it, so it is thrown through verbatim rather than reworded here.
 */
export async function companyAction<T = Record<string, unknown>>(
  action: string,
  fields: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch("/api/company", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...fields }),
    cache: "no-store",
  });
  if (response.status === 401) throw new SessionExpiredError();
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error ?? `That could not be saved (${response.status}).`);
  return payload as T;
}

export const CURRENCIES = [
  { code: "USD", label: "USD — US dollar" },
  { code: "BDT", label: "BDT — Bangladeshi taka" },
  { code: "CNY", label: "CNY — Chinese yuan" },
] as const;

/** Switching company is a cookie plus a full reload: no stale payload survives. */
export function switchCompany(id: string) {
  document.cookie = `vantora_company=${encodeURIComponent(id)}; path=/; SameSite=Lax; max-age=${60 * 60 * 24 * 365}`;
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload so no other company's payload survives in the router cache
  window.location.assign("/");
}
