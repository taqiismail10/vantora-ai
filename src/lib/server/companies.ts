/**
 * Companies: the tenancy root.
 *
 * A company id IS a business id. The same value scopes `membership`,
 * `approval`, `action_execution`, `cash_movement`, the audit chain and every
 * financial record, so nothing here invents a second tenancy concept.
 *
 * Creating a company and granting its first OWNER happen in one transaction:
 * there is no window in which a company exists with nobody authorised for it,
 * and no path on which a caller chooses their own role. The role is written by
 * this module, never read from a request.
 */

import { randomUUID } from "node:crypto";

import { db, transaction } from "./db";
import { AccessError, type HumanRole } from "./identity";
import { isCurrencyCode, type CurrencyCode } from "./money";

export type CompanyStatus = "draft" | "active";

/** Onboarding is resumable: this is where the owner left off. */
export const ONBOARDING_STEPS = ["profile", "accounts", "records", "policy", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface Company {
  id: string;
  name: string;
  industry: string;
  country: string;
  businessType: string;
  timezone: string;
  currency: CurrencyCode;
  locations: string[];
  status: CompanyStatus;
  isDemo: boolean;
  onboardingStep: OnboardingStep;
  createdAt: number;
  createdBy: string;
}

interface CompanyRow {
  id: string;
  name: string;
  industry: string;
  country: string;
  business_type: string;
  timezone: string;
  currency: string;
  locations_json: string;
  status: CompanyStatus;
  is_demo: number;
  onboarding_step: string;
  created_at: number;
  created_by: string;
}

function hydrate(row: CompanyRow): Company {
  let locations: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.locations_json);
    if (Array.isArray(parsed)) locations = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // A corrupt list is not worth failing a page render over; it reads as empty.
  }
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    country: row.country,
    businessType: row.business_type,
    timezone: row.timezone,
    currency: isCurrencyCode(row.currency) ? row.currency : "USD",
    locations,
    status: row.status,
    isDemo: row.is_demo === 1,
    onboardingStep: (ONBOARDING_STEPS as readonly string[]).includes(row.onboarding_step)
      ? (row.onboarding_step as OnboardingStep)
      : "profile",
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/** Readable in an audit line, unique without a lookup. */
function companyId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `${slug || "company"}-${randomUUID().slice(0, 8)}`;
}

const MAX_NAME = 120;

export function validateCompanyName(value: unknown): { ok: true; name: string } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: "company name is required" };
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2) return { ok: false, reason: "company name must be at least 2 characters" };
  if (name.length > MAX_NAME) return { ok: false, reason: `company name must be ${MAX_NAME} characters or fewer` };
  // Unicode names are expected (中文, বাংলা); only control characters are refused.
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return { ok: false, reason: "company name contains control characters" };
  return { ok: true, name };
}

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, max) : "";

export interface CompanyProfileInput {
  /** Required on create; omitted on update means "leave the name alone". */
  name?: unknown;
  industry?: unknown;
  country?: unknown;
  businessType?: unknown;
  timezone?: unknown;
  currency?: unknown;
  locations?: unknown;
}

/**
 * Create a company and make `userId` its OWNER, atomically.
 *
 * The caller never supplies the role or the id. A user may own several
 * companies; nothing here grants membership in an existing one.
 */
export function createCompany(input: CompanyProfileInput, userId: string): Company {
  const name = validateCompanyName(input.name);
  if (!name.ok) throw new AccessError(422, name.reason);
  if (input.currency !== undefined && !isCurrencyCode(input.currency)) {
    throw new AccessError(422, "currency must be one of USD, BDT, CNY");
  }
  const locations = Array.isArray(input.locations)
    ? input.locations.map((v) => text(v, 80)).filter(Boolean).slice(0, 20)
    : [];

  const id = companyId(name.name);
  const now = Date.now();
  return transaction((database) => {
    database
      .prepare(
        `INSERT INTO company (id, name, industry, country, business_type, timezone, currency,
                              locations_json, status, is_demo, onboarding_step, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, 'accounts', ?, ?)`,
      )
      .run(
        id,
        name.name,
        text(input.industry, 60),
        text(input.country, 60),
        text(input.businessType, 60),
        text(input.timezone, 60) || "UTC",
        isCurrencyCode(input.currency) ? input.currency : "USD",
        JSON.stringify(locations),
        now,
        userId,
      );
    // The role is written here, never taken from the request.
    database
      .prepare("INSERT INTO membership (user_id, business_id, role, created_at, created_by) VALUES (?, ?, 'OWNER', ?, ?)")
      .run(userId, id, now, userId);
    const row = database.prepare("SELECT * FROM company WHERE id = ?").get(id) as unknown as CompanyRow;
    return hydrate(row);
  });
}

export function getCompany(companyId: string): Company | null {
  const row = db().prepare("SELECT * FROM company WHERE id = ?").get(companyId) as unknown as CompanyRow | undefined;
  return row ? hydrate(row) : null;
}

/** Every company this user holds a membership in, with the role they hold. */
export function companiesForUser(userId: string): (Company & { role: HumanRole })[] {
  const rows = db()
    .prepare(
      `SELECT c.*, m.role AS member_role FROM company c
       JOIN membership m ON m.business_id = c.id
       WHERE m.user_id = ? ORDER BY c.created_at`,
    )
    .all(userId) as unknown as (CompanyRow & { member_role: HumanRole })[];
  return rows.map((row) => ({ ...hydrate(row), role: row.member_role }));
}

export function updateCompanyProfile(companyId: string, input: CompanyProfileInput): Company {
  const existing = getCompany(companyId);
  if (!existing) throw new AccessError(404, "company not found");
  const name = validateCompanyName(input.name ?? existing.name);
  if (!name.ok) throw new AccessError(422, name.reason);
  if (input.currency !== undefined && !isCurrencyCode(input.currency)) {
    throw new AccessError(422, "currency must be one of USD, BDT, CNY");
  }
  // Changing the base currency after amounts exist would silently re-denominate
  // every stored figure, so it is refused rather than converted.
  if (input.currency !== undefined && input.currency !== existing.currency && companyHasAmounts(companyId)) {
    throw new AccessError(
      409,
      "the base currency cannot be changed once amounts have been entered; create a new company instead",
    );
  }
  const locations = Array.isArray(input.locations)
    ? input.locations.map((v) => text(v, 80)).filter(Boolean).slice(0, 20)
    : existing.locations;

  db()
    .prepare(
      `UPDATE company SET name = ?, industry = ?, country = ?, business_type = ?,
                          timezone = ?, currency = ?, locations_json = ? WHERE id = ?`,
    )
    .run(
      name.name,
      input.industry === undefined ? existing.industry : text(input.industry, 60),
      input.country === undefined ? existing.country : text(input.country, 60),
      input.businessType === undefined ? existing.businessType : text(input.businessType, 60),
      input.timezone === undefined ? existing.timezone : text(input.timezone, 60) || "UTC",
      isCurrencyCode(input.currency) ? input.currency : existing.currency,
      JSON.stringify(locations),
      companyId,
    );
  return getCompany(companyId)!;
}

function companyHasAmounts(companyId: string): boolean {
  const row = db()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM company_account WHERE company_id = ?1)
            + (SELECT COUNT(*) FROM receivable WHERE company_id = ?1)
            + (SELECT COUNT(*) FROM payable WHERE company_id = ?1) AS n`,
    )
    .get(companyId) as { n: number };
  return row.n > 0;
}

export function setOnboardingStep(companyId: string, step: OnboardingStep): void {
  db().prepare("UPDATE company SET onboarding_step = ? WHERE id = ?").run(step, companyId);
}

/** A company becomes active once it holds enough to forecast: one account. */
export function activateCompany(companyId: string): void {
  db().prepare("UPDATE company SET status = 'active', onboarding_step = 'done' WHERE id = ?").run(companyId);
}

// --- Company policy -------------------------------------------------------
//
// Only the few values an owner genuinely sets. Tier classification and other
// platform rules are deliberately NOT here: a tenant must never be able to
// change what is prohibited.

export const POLICY_KEYS = [
  "minimum_safe_buffer_cents",
  "credit_score",
  "monthly_revenue_cents",
  "gross_margin",
  /** "entered" | "none" — lets the owner say they have no payroll, which is
   *  not the same as never having told us. The coverage report distinguishes
   *  the two rather than assuming a silent zero. */
  "payroll_status",
] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];

export interface PolicyValue {
  value: string;
  effectiveFrom: string;
  setBy: string;
  setAt: number;
}

export function getPolicies(companyId: string): Partial<Record<PolicyKey, PolicyValue>> {
  const rows = db()
    .prepare("SELECT key, value, effective_from, set_by, set_at FROM company_policy WHERE company_id = ?")
    .all(companyId) as { key: string; value: string; effective_from: string; set_by: string; set_at: number }[];
  const out: Partial<Record<PolicyKey, PolicyValue>> = {};
  for (const row of rows) {
    if ((POLICY_KEYS as readonly string[]).includes(row.key)) {
      out[row.key as PolicyKey] = {
        value: row.value,
        effectiveFrom: row.effective_from,
        setBy: row.set_by,
        setAt: row.set_at,
      };
    }
  }
  return out;
}

/**
 * The slice of the audit chain a company may see.
 *
 * The chain is one hash-linked file and must stay that way: its integrity is a
 * property of the whole sequence, so nothing here reorders, rewrites or
 * re-hashes anything. `smeProfileId` sits outside the hashed fields
 * (`computeEntryHash` covers seq, timestamp, actor, operation, tier, decision,
 * reason, payload digest and the previous hash), so filtering on it is purely
 * a view and every historical entry keeps its exact bytes and hash.
 *
 * A real company sees only entries carrying its own id. The demonstration
 * company sees the historical chain minus anything belonging to a real
 * company, which keeps the recorded evidence from before companies existed
 * visible and verifiable.
 */
export function visibleChainFor<T extends { smeProfileId?: string }>(businessId: string, entries: T[]): T[] {
  const company = getCompany(businessId);
  if (company && !company.isDemo) return entries.filter((entry) => entry.smeProfileId === businessId);
  const real = new Set(
    (db().prepare("SELECT id FROM company WHERE is_demo = 0").all() as unknown as { id: string }[]).map((row) => row.id),
  );
  return entries.filter((entry) => !entry.smeProfileId || !real.has(entry.smeProfileId));
}

export function setPolicy(companyId: string, key: PolicyKey, value: string, setBy: string, effectiveFrom: string): void {
  db()
    .prepare(
      `INSERT INTO company_policy (company_id, key, value, effective_from, set_by, set_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (company_id, key) DO UPDATE SET
         value = excluded.value, effective_from = excluded.effective_from,
         set_by = excluded.set_by, set_at = excluded.set_at`,
    )
    .run(companyId, key, value, effectiveFrom, setBy, Date.now());
}
