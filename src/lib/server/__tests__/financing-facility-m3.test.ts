/**
 * M3.2: editing an existing financing facility, connected to planning.
 *
 * What this pins:
 *   a limit reduction lowers what a recommendation can draw;
 *   a rate/fee edit changes the calculated cost;
 *   a funding-delay edit changes eligibility when timing matters;
 *   cross-company and unauthorized edits are rejected;
 *   a material edit invalidates only the editing company's plan.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

import { POST as companyPost } from "../../../app/api/company/route";
import { getAuth } from "../auth";
import { db } from "../db";
import { loadPlanContext, BASELINE_SCENARIO } from "../plan";
import { rankFinancingOptions } from "../../quant-client";
import { BASE } from "./helpers";

const PASSWORD = "correct-horse-battery-staple-42";
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function signUp(email: string): Promise<string> {
  const auth = (await getAuth())!;
  await auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: PASSWORD, name: email.split("@")[0] }),
    }),
  );
  const signIn = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  return signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function post(body: Record<string, unknown>, cookie: string, company?: string) {
  const response = await companyPost(
    new Request(`${BASE}/api/company`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie,
        ...(company ? { "x-vantora-company": company } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function newCompany(email: string, name: string): Promise<{ cookie: string; id: string }> {
  const cookie = await signUp(email);
  const created = await post({ action: "create_company", name }, cookie);
  const id = (created.body as { company: { id: string } }).company.id;
  await post({ action: "add_account", name: "Main", openingBalance: "100000", asOfDate: day(-1) }, cookie, id);
  return { cookie, id };
}

describe("editing a facility's limit", () => {
  it("lowers what the next ranking says is available to draw", async () => {
    const co = await newCompany("m3f-limit@example.com", "Facility Limit Co");
    const created = await post(
      { action: "add_facility", provider: "Bridge Bank", productType: "bridge_loan", maxAmount: "50000", apr: "0.18" },
      co.cookie,
      co.id,
    );
    const facilityId = (created.body as { facility: { id: string } }).facility.id;

    const before = (await loadPlanContext(co.id, BASELINE_SCENARIO)).ctx.state;
    const beforeMatch = rankFinancingOptions(before, null).find((m) => m.id === facilityId)!;
    expect(beforeMatch.max_available).toBe(50000);

    const updated = await post({ action: "update_facility", id: facilityId, maxAmount: "10000" }, co.cookie, co.id);
    expect(updated.status).toBe(200);
    expect((updated.body as { facility: { maxAmountCents: number } }).facility.maxAmountCents).toBe(1_000_000);

    const after = (await loadPlanContext(co.id, BASELINE_SCENARIO)).ctx.state;
    const afterMatch = rankFinancingOptions(after, null).find((m) => m.id === facilityId)!;
    expect(afterMatch.max_available).toBe(10000);
  });
});

describe("editing rate and fees", () => {
  it("changes the calculated effective cost", async () => {
    const co = await newCompany("m3f-cost@example.com", "Facility Cost Co");
    const created = await post(
      { action: "add_facility", provider: "Cheap Lender", productType: "bridge_loan", maxAmount: "50000", apr: "0.10" },
      co.cookie,
      co.id,
    );
    const facilityId = (created.body as { facility: { id: string } }).facility.id;

    const before = (await loadPlanContext(co.id, BASELINE_SCENARIO)).ctx.state;
    const beforeCost = rankFinancingOptions(before, null).find((m) => m.id === facilityId)!.effective_cost_30d;

    await post({ action: "update_facility", id: facilityId, apr: "0.40", originationFeePct: "0.05" }, co.cookie, co.id);

    const after = (await loadPlanContext(co.id, BASELINE_SCENARIO)).ctx.state;
    const afterCost = rankFinancingOptions(after, null).find((m) => m.id === facilityId)!.effective_cost_30d;
    expect(afterCost).toBeGreaterThan(beforeCost);
  });
});

describe("editing funding delay", () => {
  it("makes a facility ineligible once it can no longer reach the crunch day in time", async () => {
    const co = await newCompany("m3f-timing@example.com", "Facility Timing Co");
    // A buffer above day-3 cash forces a real crunch day, so a facility's
    // funding speed actually determines whether it is eligible to reach it.
    await post({ action: "set_policy", key: "minimum_safe_buffer_cents", value: "20000" }, co.cookie, co.id);
    const supplier = await post({ action: "add_counterparty", name: "Due Soon Supplier", isSupplier: true }, co.cookie, co.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    await post({ action: "add_payable", counterpartyId: supplierId, amount: "95000", dueDate: day(3) }, co.cookie, co.id);

    const created = await post(
      { action: "add_facility", provider: "Fast Lender", productType: "bridge_loan", maxAmount: "50000", apr: "0.18", fundingDays: 1 },
      co.cookie,
      co.id,
    );
    const facilityId = (created.body as { facility: { id: string } }).facility.id;

    const before = await loadPlanContext(co.id, BASELINE_SCENARIO);
    expect(before.ctx.optimization.crunch_day).toBeTruthy();
    const beforeMatch = before.ctx.optimization.matched_financing_options.find((m) => m.id === facilityId)!;
    expect(beforeMatch.eligible, beforeMatch.rejection_reason ?? "").toBe(true);

    await post({ action: "update_facility", id: facilityId, fundingDays: 90 }, co.cookie, co.id);

    const after = await loadPlanContext(co.id, BASELINE_SCENARIO);
    const afterMatch = after.ctx.optimization.matched_financing_options.find((m) => m.id === facilityId)!;
    expect(afterMatch.eligible).toBe(false);
    expect(afterMatch.rejection_reason).toMatch(/funds in/);
  });
});

describe("authorization and company scoping", () => {
  it("rejects a cross-company update_facility", async () => {
    const owner = await newCompany("m3f-cross-a@example.com", "Facility Cross A");
    const other = await newCompany("m3f-cross-b@example.com", "Facility Cross B");
    const created = await post(
      { action: "add_facility", provider: "A Lender", productType: "bridge_loan", maxAmount: "50000", apr: "0.18" },
      owner.cookie,
      owner.id,
    );
    const facilityId = (created.body as { facility: { id: string } }).facility.id;

    const forged = await post({ action: "update_facility", id: facilityId, apr: "0.99" }, other.cookie, owner.id);
    expect(forged.status).toBe(403);

    const wrongId = await post({ action: "update_facility", id: facilityId, apr: "0.99" }, other.cookie, other.id);
    expect(wrongId.status).toBe(404);
  });

  it("rejects a VIEWER updating facility terms", async () => {
    const owner = await newCompany("m3f-viewer-owner@example.com", "Facility Viewer Gate");
    const created = await post(
      { action: "add_facility", provider: "Gated Lender", productType: "bridge_loan", maxAmount: "50000", apr: "0.18" },
      owner.cookie,
      owner.id,
    );
    const facilityId = (created.body as { facility: { id: string } }).facility.id;

    const viewerCookie = await signUp("m3f-viewer@example.com");
    const userId = (db().prepare("SELECT id FROM user WHERE email = ?").get("m3f-viewer@example.com") as { id: string }).id;
    db()
      .prepare("INSERT INTO membership (user_id, business_id, role, created_at, created_by) VALUES (?, ?, 'VIEWER', ?, 'test')")
      .run(userId, owner.id, Date.now());

    const result = await post({ action: "update_facility", id: facilityId, apr: "0.99" }, viewerCookie, owner.id);
    expect(result.status).toBe(403);
  });
});

describe("material edits invalidate only the editing company's plan", () => {
  it("changes this company's plan version but not another's", async () => {
    const a = await newCompany("m3f-plan-a@example.com", "Facility Plan A");
    const b = await newCompany("m3f-plan-b@example.com", "Facility Plan B");
    const created = await post(
      { action: "add_facility", provider: "A Lender", productType: "bridge_loan", maxAmount: "50000", apr: "0.18" },
      a.cookie,
      a.id,
    );
    const facilityId = (created.body as { facility: { id: string } }).facility.id;

    const aBefore = (await loadPlanContext(a.id, BASELINE_SCENARIO)).planVersion;
    const bBefore = (await loadPlanContext(b.id, BASELINE_SCENARIO)).planVersion;

    await post({ action: "update_facility", id: facilityId, apr: "0.35" }, a.cookie, a.id);

    expect((await loadPlanContext(a.id, BASELINE_SCENARIO)).planVersion).not.toBe(aBefore);
    expect((await loadPlanContext(b.id, BASELINE_SCENARIO)).planVersion).toBe(bBefore);
  });
});

describe("preserving an already-recorded draw", () => {
  it("leaves a recorded draw's frozen apr/funding_days untouched when the facility's current terms change", async () => {
    const co = await newCompany("m3f-preserve@example.com", "Facility Preserve Co");
    const created = await post(
      { action: "add_facility", provider: "Stable Lender", productType: "bridge_loan", maxAmount: "50000", apr: "0.18" },
      co.cookie,
      co.id,
    );
    const facilityId = (created.body as { facility: { id: string } }).facility.id;

    // Simulates a draw already approved and executed against this facility —
    // its payload freezes the apr/funding_days that applied at that moment,
    // exactly as `plan.ts` builds it (`payload: { ..., apr: facility.apr,
    // funding_days: facility.funding_days }`) when a draw is approved.
    const frozenPayload = JSON.stringify({ principal_cents: 500_000, cost_cents: 9_000, apr: 0.18, funding_days: 30 });
    db()
      .prepare(
        `INSERT INTO action_execution (action_key, business_id, scenario_key, kind, target_id, ordinal, payload_json, status, approval_jti, submitted_by, created_at, updated_at)
         VALUES (?, ?, 'baseline', 'financing_draw', ?, 1, ?, 'SETTLED', 'test-jti', 'test', ?, ?)`,
      )
      .run(`${facilityId}-draw-1`, co.id, facilityId, frozenPayload, Date.now(), Date.now());

    // The facility's current, live terms change completely afterward.
    await post({ action: "update_facility", id: facilityId, apr: "0.60", maxAmount: "1" }, co.cookie, co.id);

    const row = db()
      .prepare("SELECT payload_json FROM action_execution WHERE business_id = ? AND action_key = ?")
      .get(co.id, `${facilityId}-draw-1`) as { payload_json: string };
    expect(row.payload_json).toBe(frozenPayload);
    expect(JSON.parse(row.payload_json).apr).toBe(0.18);
  });
});
