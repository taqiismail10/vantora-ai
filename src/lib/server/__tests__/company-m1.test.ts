/**
 * M1: a new company's own records produce its own forecast.
 *
 * Every assertion here is on a database row, an HTTP status or a built engine
 * input — not on a component. The three things most worth proving are that a
 * company's forecast contains only its own figures, that a caller cannot reach
 * another company by naming it, and that what the owner did not enter is
 * disclosed rather than assumed.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

import { GET as companyGet, POST as companyPost } from "../../../app/api/company/route";
import { GET as stateGet } from "../../../app/api/state/route";
import { getAuth } from "../auth";
import { companiesForUser, getCompany, setPolicy } from "../companies";
import { companyDataset } from "../company-state";
import { db } from "../db";
import { BASE, jsonRequest } from "./helpers";

const PASSWORD = "correct-horse-battery-staple-42";

/** A brand-new self-service account: signed up, belonging to no company. */
async function signUp(email: string): Promise<string> {
  const auth = (await getAuth())!;
  const response = await auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: PASSWORD, name: email.split("@")[0] }),
    }),
  );
  if (!response.ok) throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
  const signIn = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  return signIn.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function post(body: Record<string, unknown>, cookie?: string, company?: string) {
  const request = jsonRequest("/api/company", body, cookie);
  const headers = new Headers(request.headers);
  if (company) headers.set("x-vantora-company", company);
  const response = await companyPost(new Request(request.url, { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function withCompany(path: string, cookie: string, company: string): Request {
  return new Request(`${BASE}${path}`, { headers: { cookie, "x-vantora-company": company } });
}

/** A company with one account, one buyer invoice and one payroll bill. */
async function populate(
  cookie: string,
  companyId: string,
  opts: { amount?: string; buyer?: string; currency?: string } = {},
) {
  const account = await post(
    { action: "add_account", name: "Operating", openingBalance: "50000", asOfDate: "2026-10-01" },
    cookie,
    companyId,
  );
  expect(account.status).toBe(200);
  const buyer = await post(
    { action: "add_counterparty", name: opts.buyer ?? "Buyer One", isBuyer: true },
    cookie,
    companyId,
  );
  expect(buyer.status).toBe(200);
  const supplier = await post({ action: "add_counterparty", name: "Payroll", isSupplier: true }, cookie, companyId);
  expect(supplier.status).toBe(200);
  const due = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const invoice = await post(
    {
      action: "add_receivable",
      counterpartyId: (buyer.body as { counterparty: { id: string } }).counterparty.id,
      amount: opts.amount ?? "20000",
      dueDate: due,
    },
    cookie,
    companyId,
  );
  expect(invoice.status).toBe(200);
  const payroll = await post(
    {
      action: "add_payable",
      counterpartyId: (supplier.body as { counterparty: { id: string } }).counterparty.id,
      amount: "12000",
      dueDate: due,
      isPayroll: true,
    },
    cookie,
    companyId,
  );
  expect(payroll.status).toBe(200);
}

let alice: string;
let aliceCo: string;
let bob: string;
let bobCo: string;

beforeAll(async () => {
  alice = await signUp("alice@north.example");
  const a = await post({ action: "create_company", name: "North Textiles", currency: "USD", country: "BD" }, alice);
  expect(a.status).toBe(200);
  aliceCo = (a.body as { company: { id: string } }).company.id;

  bob = await signUp("bob@south.example");
  const b = await post({ action: "create_company", name: "South Trading", currency: "USD" }, bob);
  expect(b.status).toBe(200);
  bobCo = (b.body as { company: { id: string } }).company.id;
});

describe("account and company lifecycle", () => {
  it("makes the creator OWNER of their own company and a member of nothing else", () => {
    const memberships = db()
      .prepare("SELECT business_id, role FROM membership WHERE user_id = (SELECT id FROM user WHERE email = ?)")
      .all("alice@north.example") as { business_id: string; role: string }[];
    expect(memberships).toEqual([{ business_id: aliceCo, role: "OWNER" }]);
    // Signing up does not join the demonstration company.
    expect(memberships.some((m) => m.business_id === "smart-jeans-mfg")).toBe(false);
  });

  it("refuses a caller-supplied role or business in the body", async () => {
    for (const forged of [{ role: "OWNER" }, { businessId: "smart-jeans-mfg" }, { userId: "x" }]) {
      const result = await post({ action: "create_company", name: "Forged Co", ...forged }, alice);
      expect(result.status).toBe(400);
    }
  });

  it("starts a new company empty, not populated with demonstration data", () => {
    const dataset = companyDataset(getCompany(bobCo)!);
    expect(dataset.counts).toMatchObject({ accounts: 0, receivables: 0, payables: 0 });
    expect(dataset.state).toBeNull();
    expect(dataset.coverage.find((n) => n.level === "blocking")?.code).toBe("no_accounts");
  });

  it("rejects an unknown currency and a currency change after amounts exist", async () => {
    expect((await post({ action: "create_company", name: "Bad Money", currency: "XYZ" }, alice)).status).toBe(422);
    await populate(alice, aliceCo);
    const changed = await post({ action: "update_company", currency: "CNY" }, alice, aliceCo);
    expect(changed.status).toBe(409);
  });
});

describe("company isolation", () => {
  it("refuses a company the caller is not a member of", async () => {
    const response = await companyGet(withCompany("/api/company", alice, bobCo));
    expect(response.status).toBe(403);
    const state = await stateGet(withCompany("/api/state", alice, bobCo));
    expect(state.status).toBe(403);
  });

  it("refuses a write aimed at another company", async () => {
    const result = await post(
      { action: "add_account", name: "Theirs", openingBalance: "1", asOfDate: "2026-10-01" },
      alice,
      bobCo,
    );
    expect(result.status).toBe(403);
    expect(db().prepare("SELECT COUNT(*) AS n FROM company_account WHERE company_id = ?").get(bobCo)).toEqual({ n: 0 });
  });

  it("refuses an id belonging to nobody rather than falling back to the caller's own", async () => {
    expect((await companyGet(withCompany("/api/company", alice, "does-not-exist"))).status).toBe(403);
  });

  it("will not let one company's records reach another's forecast", () => {
    const mine = companyDataset(getCompany(aliceCo)!);
    const theirs = companyDataset(getCompany(bobCo)!);
    expect(mine.state?.invoices_ar.map((i) => i.customer_name)).toEqual(["Buyer One"]);
    expect(theirs.state).toBeNull();
    expect(mine.dataVersion).not.toBe(theirs.dataVersion);
  });

  it("keeps the demonstration company read-only for data entry", async () => {
    db()
      .prepare("INSERT OR IGNORE INTO membership (user_id, business_id, role, created_at, created_by) VALUES ((SELECT id FROM user WHERE email = ?), 'smart-jeans-mfg', 'OWNER', ?, 'test')")
      .run("alice@north.example", Date.now());
    const result = await post(
      { action: "add_account", name: "Demo", openingBalance: "1", asOfDate: "2026-10-01" },
      alice,
      "smart-jeans-mfg",
    );
    expect(result.status).toBe(403);
    db().prepare("DELETE FROM membership WHERE business_id = 'smart-jeans-mfg' AND user_id = (SELECT id FROM user WHERE email = ?)").run("alice@north.example");
  });
});

describe("the forecast rests only on what was entered", () => {
  it("builds engine input from the company's own records", () => {
    const dataset = companyDataset(getCompany(aliceCo)!);
    expect(dataset.state).not.toBeNull();
    expect(dataset.state!.company_name).toBe("North Textiles");
    expect(dataset.state!.current_cash).toBe(50_000);
    expect(dataset.state!.invoices_ar).toHaveLength(1);
    expect(dataset.state!.payables_ap).toHaveLength(1);
    expect(dataset.state!.payables_ap[0].is_payroll).toBe(true);
    // Nothing from the seeded demonstration dataset leaks in.
    expect(JSON.stringify(dataset.state)).not.toMatch(/Smart Jeans|Kenneth Cole|Zara/i);
  });

  it("treats an unstated deferral term as fixed, not as freely movable", () => {
    const dataset = companyDataset(getCompany(aliceCo)!);
    expect(dataset.state!.payables_ap[0].is_flexible).toBe(false);
    expect(dataset.state!.payables_ap[0].max_deferral_days).toBe(0);
    expect(dataset.coverage.map((n) => n.code)).toContain("unstated_deferral_terms");
  });

  it("invents no financing option when none was recorded", () => {
    const dataset = companyDataset(getCompany(aliceCo)!);
    expect(dataset.state!.financing_options).toEqual([]);
    expect(dataset.coverage.map((n) => n.code)).toContain("no_facilities");
  });

  it("changes the data version when a record changes, leaving other companies alone", async () => {
    const before = companyDataset(getCompany(aliceCo)!).dataVersion;
    const bobBefore = companyDataset(getCompany(bobCo)!).dataVersion;
    const added = await post(
      { action: "add_account", name: "Second", openingBalance: "1000", asOfDate: "2026-10-02" },
      alice,
      aliceCo,
    );
    expect(added.status).toBe(200);
    expect(companyDataset(getCompany(aliceCo)!).dataVersion).not.toBe(before);
    expect(companyDataset(getCompany(bobCo)!).dataVersion).toBe(bobBefore);
  });
});

describe("coverage is honest about what is missing", () => {
  it("distinguishes payroll not entered from no payroll at all", async () => {
    const cookie = await signUp("carol@east.example");
    const created = await post({ action: "create_company", name: "East Works" }, cookie);
    const id = (created.body as { company: { id: string } }).company.id;
    await post({ action: "add_account", name: "Main", openingBalance: "5000", asOfDate: "2026-10-01" }, cookie, id);

    const silent = companyDataset(getCompany(id)!);
    expect(silent.coverage.map((n) => n.code)).toContain("payroll_not_entered");

    const declared = await post({ action: "set_payroll_status", status: "none" }, cookie, id);
    expect(declared.status).toBe(200);
    const after = companyDataset(getCompany(id)!);
    expect(after.coverage.map((n) => n.code)).toContain("payroll_none");
    expect(after.coverage.map((n) => n.code)).not.toContain("payroll_not_entered");
  });

  it("always says the balances are not bank-reconciled", () => {
    expect(companyDataset(getCompany(aliceCo)!).coverage.map((n) => n.code)).toContain("balances_not_reconciled");
  });

  it("warns when no minimum cash buffer is set, and accepts a buffer above current cash", async () => {
    expect(companyDataset(getCompany(aliceCo)!).coverage.map((n) => n.code)).toContain("no_buffer");
    // A buffer larger than today's cash is exactly the shortage the product
    // exists to surface, so it must be accepted rather than rejected.
    const set = await post(
      { action: "set_policy", key: "minimum_safe_buffer_cents", value: "900000" },
      alice,
      aliceCo,
    );
    expect(set.status).toBe(200);
    const dataset = companyDataset(getCompany(aliceCo)!);
    expect(dataset.state!.minimum_safe_buffer).toBe(900_000);
    expect(dataset.coverage.map((n) => n.code)).not.toContain("no_buffer");
  });
});

describe("real dates at the edges of the forecast window", () => {
  let cookie: string;
  let id: string;
  let buyerId: string;

  beforeAll(async () => {
    cookie = await signUp("dave@edges.example");
    const created = await post({ action: "create_company", name: "Edge Case Ltd" }, cookie);
    id = (created.body as { company: { id: string } }).company.id;
    await post({ action: "add_account", name: "Main", openingBalance: "10000", asOfDate: "2026-10-01" }, cookie, id);
    const buyer = await post({ action: "add_counterparty", name: "Late Payer", isBuyer: true }, cookie, id);
    buyerId = (buyer.body as { counterparty: { id: string } }).counterparty.id;
  });

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  it("pulls an overdue invoice to day 1 and says so, instead of dropping it", async () => {
    expect((await post({ action: "add_receivable", counterpartyId: buyerId, amount: "4000", dueDate: day(-9) }, cookie, id)).status).toBe(200);
    const dataset = companyDataset(getCompany(id)!);
    expect(dataset.state!.invoices_ar.find((i) => i.amount === 4000)!.due_day).toBe(1);
    expect(dataset.counts.overdue).toBe(1);
    expect(dataset.coverage.map((n) => n.code)).toContain("overdue");
  });

  it("keeps a beyond-horizon obligation on file and reports it as outside the window", async () => {
    expect((await post({ action: "add_receivable", counterpartyId: buyerId, amount: "7777", dueDate: day(120) }, cookie, id)).status).toBe(200);
    const dataset = companyDataset(getCompany(id)!);
    expect(dataset.state!.invoices_ar.some((i) => i.amount === 7777)).toBe(false);
    expect(dataset.counts.beyondHorizon).toBe(1);
    expect(dataset.coverage.map((n) => n.code)).toContain("beyond_horizon");
    // Kept, not discarded: still one of the company's records.
    expect(dataset.counts.receivables).toBe(2);
  });

  it("excludes a disputed invoice from expected cash while keeping the record", async () => {
    const added = await post({ action: "add_receivable", counterpartyId: buyerId, amount: "3100", dueDate: day(5) }, cookie, id);
    const receivableId = (added.body as { receivable: { id: string } }).receivable.id;
    expect((await post({ action: "set_receivable_status", id: receivableId, status: "disputed" }, cookie, id)).status).toBe(200);
    const dataset = companyDataset(getCompany(id)!);
    expect(dataset.state!.invoices_ar.some((i) => i.amount === 3100)).toBe(false);
    expect(dataset.coverage.map((n) => n.code)).toContain("disputed_receivables");
  });

  it("refuses a future opening-balance date and a malformed one", async () => {
    expect((await post({ action: "add_account", name: "X", openingBalance: "1", asOfDate: day(5) }, cookie, id)).status).toBe(422);
    expect((await post({ action: "add_account", name: "X", openingBalance: "1", asOfDate: "2026-02-30" }, cookie, id)).status).toBe(422);
  });
});

describe("currencies other than USD", () => {
  it("keeps a company's own currency and never mixes two", async () => {
    const cookie = await signUp("erin@dhaka.example");
    const created = await post({ action: "create_company", name: "ঢাকা গার্মেন্টস", currency: "BDT", country: "BD" }, cookie);
    expect(created.status).toBe(200);
    const id = (created.body as { company: { id: string } }).company.id;
    expect(getCompany(id)!.currency).toBe("BDT");
    expect(getCompany(id)!.name).toBe("ঢাকা গার্মেন্টস");
    await post({ action: "add_account", name: "চলতি হিসাব", openingBalance: "250000", asOfDate: "2026-10-01" }, cookie, id);
    const dataset = companyDataset(getCompany(id)!);
    expect(dataset.state!.current_cash).toBe(250_000);
    // One currency per company: nothing here can be summed with a USD company.
    expect(companiesForUser((db().prepare("SELECT id FROM user WHERE email = ?").get("erin@dhaka.example") as { id: string }).id)
      .every((c) => c.currency === "BDT")).toBe(true);
  });

  it("accepts a CNY company and reports its own figures", async () => {
    const cookie = await signUp("frank@sz.example");
    const created = await post({ action: "create_company", name: "深圳制衣有限公司", currency: "CNY" }, cookie);
    const id = (created.body as { company: { id: string } }).company.id;
    await post({ action: "add_account", name: "基本户", openingBalance: "88000", asOfDate: "2026-10-01" }, cookie, id);
    const dataset = companyDataset(getCompany(id)!);
    expect(dataset.company.currency).toBe("CNY");
    expect(dataset.state!.current_cash).toBe(88_000);
  });
});

describe("restricted cash and stale balances", () => {
  it("excludes restricted cash from available cash and discloses it", async () => {
    const cookie = await signUp("gail@restricted.example");
    const created = await post({ action: "create_company", name: "Restricted Co" }, cookie);
    const id = (created.body as { company: { id: string } }).company.id;
    const todayIso = new Date().toISOString().slice(0, 10);
    await post({ action: "add_account", name: "Operating", openingBalance: "30000", asOfDate: todayIso }, cookie, id);
    await post(
      { action: "add_account", name: "Escrow", openingBalance: "20000", asOfDate: todayIso, isRestricted: true },
      cookie,
      id,
    );
    const dataset = companyDataset(getCompany(id)!);
    expect(dataset.state!.current_cash).toBe(30_000);
    expect(dataset.coverage.map((n) => n.code)).toContain("restricted_cash");
    expect(dataset.coverage.map((n) => n.code)).not.toContain("stale_balance");
  });

  it("warns when the opening balance is weeks old", () => {
    const dataset = companyDataset(getCompany(aliceCo)!);
    expect(dataset.coverage.map((n) => n.code)).toContain("stale_balance");
  });
});

describe("policy values a tenant may and may not set", () => {
  it("refuses an unknown policy key", async () => {
    expect((await post({ action: "set_policy", key: "operation_tiers", value: "0" }, alice, aliceCo)).status).toBe(422);
  });

  it("refuses a gross margin above 1 and a negative value", async () => {
    expect((await post({ action: "set_policy", key: "gross_margin", value: "45" }, alice, aliceCo)).status).toBe(422);
    expect((await post({ action: "set_policy", key: "credit_score", value: "-5" }, alice, aliceCo)).status).toBe(422);
  });

  it("records who set a policy and when it takes effect", () => {
    setPolicy(aliceCo, "credit_score", "700", "alice@north.example", "2026-10-19");
    const row = db()
      .prepare("SELECT set_by, effective_from FROM company_policy WHERE company_id = ? AND key = 'credit_score'")
      .get(aliceCo) as { set_by: string; effective_from: string };
    expect(row).toEqual({ set_by: "alice@north.example", effective_from: "2026-10-19" });
  });
});

describe("entry validation", () => {
  it("refuses an invoice against a counterparty from another company", async () => {
    const theirs = db().prepare("SELECT id FROM counterparty WHERE company_id = ?").get(bobCo) as { id: string } | undefined;
    const mine = db().prepare("SELECT id FROM counterparty WHERE company_id = ? LIMIT 1").get(aliceCo) as { id: string };
    expect(mine).toBeTruthy();
    if (theirs) {
      const result = await post(
        { action: "add_receivable", counterpartyId: theirs.id, amount: "100", dueDate: "2026-11-01" },
        alice,
        aliceCo,
      );
      expect(result.status).toBe(404);
    }
  });

  it("refuses a bill against a counterparty that is not a supplier", async () => {
    const buyer = db()
      .prepare("SELECT id FROM counterparty WHERE company_id = ? AND is_buyer = 1 AND is_supplier = 0 LIMIT 1")
      .get(aliceCo) as { id: string };
    const result = await post(
      { action: "add_payable", counterpartyId: buyer.id, amount: "100", dueDate: "2026-11-01" },
      alice,
      aliceCo,
    );
    expect(result.status).toBe(422);
  });

  it("refuses a duplicate invoice reference and a counterparty name twice", async () => {
    const buyer = db()
      .prepare("SELECT id FROM counterparty WHERE company_id = ? AND is_buyer = 1 LIMIT 1")
      .get(aliceCo) as { id: string };
    const first = await post(
      { action: "add_receivable", counterpartyId: buyer.id, amount: "500", dueDate: "2026-11-05", externalId: "INV-1" },
      alice,
      aliceCo,
    );
    expect(first.status).toBe(200);
    const again = await post(
      { action: "add_receivable", counterpartyId: buyer.id, amount: "500", dueDate: "2026-11-05", externalId: "INV-1" },
      alice,
      aliceCo,
    );
    expect(again.status).toBe(409);
    expect((await post({ action: "add_counterparty", name: "Buyer One", isBuyer: true }, alice, aliceCo)).status).toBe(409);
  });

  it("refuses a payroll lock date after the due date", async () => {
    const supplier = db()
      .prepare("SELECT id FROM counterparty WHERE company_id = ? AND is_supplier = 1 LIMIT 1")
      .get(aliceCo) as { id: string };
    const result = await post(
      {
        action: "add_payable",
        counterpartyId: supplier.id,
        amount: "100",
        dueDate: "2026-11-01",
        isPayroll: true,
        payrollLockDate: "2026-11-09",
      },
      alice,
      aliceCo,
    );
    expect(result.status).toBe(422);
  });
});

describe("audit history is scoped to the company", () => {
  it("shows a real company none of the demonstration company's audit entries", async () => {
    const { logOperation, readChain } = await import("../../sandbox/execution-logger");
    const { visibleChainFor } = await import("../companies");

    logOperation({
      actorId: "demo@example",
      operation: "read_sme_profile",
      tier: "TIER_0_AUTO_READ",
      decision: "ALLOWED",
      reason: "demo activity",
      smeProfileId: "smart-jeans-in-memory",
      recoveryPlanId: "smartjeans-crunch-d14",
    });
    logOperation({
      actorId: "alice@north.example",
      operation: "read_sme_profile",
      tier: "TIER_0_AUTO_READ",
      decision: "ALLOWED",
      reason: "her own activity",
      smeProfileId: aliceCo,
    });

    const full = readChain();
    const hers = visibleChainFor(aliceCo, full);
    expect(hers.length).toBeGreaterThan(0);
    expect(hers.every((e) => e.smeProfileId === aliceCo)).toBe(true);
    expect(JSON.stringify(hers)).not.toMatch(/smartjeans|smart-jeans/i);

    // Another company sees none of hers.
    expect(visibleChainFor(bobCo, full).some((e) => e.smeProfileId === aliceCo)).toBe(false);

    // The demonstration company keeps its historical evidence and sees no
    // real company's entries.
    const demo = visibleChainFor("smart-jeans-mfg", full);
    expect(demo.some((e) => e.recoveryPlanId === "smartjeans-crunch-d14")).toBe(true);
    expect(demo.some((e) => e.smeProfileId === aliceCo)).toBe(false);

    // Filtering is a view: the file itself is untouched and still verifies.
    const { verifyChain } = await import("../../sandbox/execution-logger");
    expect(verifyChain(full).valid).toBe(true);
    expect(readChain().length).toBe(full.length);
  });
});

describe("the dashboard payload for a real company", () => {
  it("reports the company's own name, currency and source, with no demo scenarios offered", async () => {
    const response = await stateGet(withCompany("/api/state", alice, aliceCo));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      company: { name: string; is_demo: boolean; currency: string };
      seed: { mode: string; source: string };
      profile: { available: unknown[] };
      coverage: { code: string }[];
      memos: unknown[];
      state: { company_name: string };
      plan_id: string;
    };
    expect(payload.company).toMatchObject({ name: "North Textiles", is_demo: false, currency: "USD" });
    expect(payload.seed.mode).toBe("company");
    expect(payload.seed.source).toBe("Your company's records");
    expect(payload.profile.available).toEqual([]);
    expect(payload.coverage.length).toBeGreaterThan(0);
    // No demonstration memo text, and no plan id carrying the demo's name.
    expect(payload.memos).toEqual([]);
    expect(payload.plan_id).not.toMatch(/smartjeans/);
    expect(payload.plan_id.startsWith(aliceCo)).toBe(true);
    expect(JSON.stringify(payload.state)).not.toMatch(/Smart Jeans|Kenneth Cole|Zara/i);
  });

  it("carries no other company's audit entries in the payload", async () => {
    const response = await stateGet(withCompany("/api/state", alice, aliceCo));
    const payload = (await response.json()) as { audit: { entries: { smeProfileId?: string }[]; verification: { valid: boolean; length: number } } };
    expect(payload.audit.entries.every((e) => e.smeProfileId === aliceCo)).toBe(true);
    expect(JSON.stringify(payload.audit.entries)).not.toMatch(/smartjeans|smart-jeans/i);
    // The reported length is this company's slice, not the whole file, so one
    // tenant cannot read another's activity volume from it.
    expect(payload.audit.verification.length).toBe(payload.audit.entries.length);
    expect(payload.audit.verification.valid).toBe(true);
  });

  it("sends a company with no account to onboarding rather than rendering a fallback", async () => {
    const response = await stateGet(withCompany("/api/state", bob, bobCo));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/at least one account/i);
  });
});
