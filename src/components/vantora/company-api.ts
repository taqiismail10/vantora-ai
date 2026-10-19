/** Fetch helpers for `/api/company`. One place that knows the route shape. */

import { SessionExpiredError } from "./client-api";

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

const SYMBOL: Record<string, string> = { USD: "$", BDT: "৳", CNY: "¥" };
const LOCALE: Record<string, string> = { USD: "en-US", BDT: "en-BD", CNY: "zh-CN" };

/** Display helper for the entry screens, which know their company's currency. */
export const formatMinor = (cents: number, currency: string) =>
  `${cents < 0 ? "-" : ""}${SYMBOL[currency] ?? "$"}${(Math.abs(cents) / 100).toLocaleString(LOCALE[currency] ?? "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** Switching company is a cookie plus a full reload: no stale payload survives. */
export function switchCompany(id: string) {
  document.cookie = `vantora_company=${encodeURIComponent(id)}; path=/; SameSite=Lax; max-age=${60 * 60 * 24 * 365}`;
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload so no other company's payload survives in the router cache
  window.location.assign("/");
}
