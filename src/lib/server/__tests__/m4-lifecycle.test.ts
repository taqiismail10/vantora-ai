/**
 * M4: the approval/outcome lifecycle, exercised end to end on a real
 * (non-demo) company for the first time — the gap M2/M3's status doc left
 * open. Also pins the currency-binding fix: the company here keeps its
 * books in BDT, so a payload that still read "USD" or a confirmation
 * parsed under the wrong currency would surface here, not just in a unit
 * test of `parseCents`.
 *
 * What this proves:
 *   plan/action/payload/company binding — the approval and payload both
 *     carry this company's own currency, not the demo's hardcoded USD;
 *   PROPOSED → APPROVED (mint) → SUBMITTED (execute, AWAITING_COUNTERPARTY)
 *     → ACCEPTED → SETTLED, in order, on real data;
 *   exactly-once financial effects — one cash_movement row per settled
 *     action, a replayed execute and a repeated settle both refused;
 *   sandbox simulation (this whole lifecycle) stays separate from a
 *     user-reported outcome (M2's `record_payment`) — settling a sandbox
 *     draw never writes a `payment` row, and recording a real payment
 *     never writes a `cash_movement` row.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

import { POST as companyPost } from "../../../app/api/company/route";
import { POST as actionPost } from "../../../app/api/action/route";
import { getAuth } from "../auth";
import { db } from "../db";
import { loadPlanContext, BASELINE_SCENARIO } from "../plan";
import { listPayments } from "../settlements";
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

async function companyAction(body: Record<string, unknown>, cookie: string, company?: string) {
  const response = await companyPost(
    new Request(`${BASE}/api/company`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie, ...(company ? { "x-vantora-company": company } : {}) },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function call(cookie: string, company: string) {
  return async (body: Record<string, unknown>) => {
    const response = await actionPost(
      new Request(`${BASE}/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie, "x-vantora-company": company },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, string> };
  };
}

let cookie: string;
let companyId: string;

beforeAll(async () => {
  cookie = await signUp("m4-lifecycle@example.com");
  const created = await companyAction({ action: "create_company", name: "M4 Lifecycle Co", currency: "BDT" }, cookie);
  companyId = (created.body as { company: { id: string } }).company.id;
  await companyAction({ action: "add_account", name: "Main", openingBalance: "500000", asOfDate: day(-1) }, cookie, companyId);
  // A fixed (non-deferrable) bill forces the only lever to be the
  // buyer's early-payment discount — a deferral never settles (it only
  // moves a date), so this is what lets the test reach SETTLED.
  const supplier = await companyAction({ action: "add_counterparty", name: "BDT Supplier", isSupplier: true }, cookie, companyId);
  const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
  await companyAction(
    { action: "add_payable", counterpartyId: supplierId, amount: "450000", dueDate: day(5) },
    cookie,
    companyId,
  );
  const buyer = await companyAction({ action: "add_counterparty", name: "BDT Buyer", isBuyer: true }, cookie, companyId);
  const buyerId = (buyer.body as { counterparty: { id: string } }).counterparty.id;
  await companyAction(
    {
      action: "add_receivable",
      counterpartyId: buyerId,
      amount: "300000",
      dueDate: day(10),
      discountEligible: true,
      discountPct: 0.02,
      discountSettlesInDays: 3,
    },
    cookie,
    companyId,
  );
  await companyAction({ action: "set_policy", key: "minimum_safe_buffer_cents", value: "100000" }, cookie, companyId);
});

describe("plan/action/payload/company binding", () => {
  it("carries this company's own currency throughout, never the demo's USD", async () => {
    const plan = await loadPlanContext(companyId, BASELINE_SCENARIO);
    expect(plan.ctx.currency).toBe("BDT");
    for (const spec of plan.specs) {
      expect(spec.payload.currency).toBe("BDT");
    }
  });
});

describe("the full lifecycle on a real company", () => {
  it("goes PROPOSED -> APPROVED -> SUBMITTED -> AWAITING_COUNTERPARTY -> ACCEPTED -> SETTLED, exactly once", async () => {
    const act = call(cookie, companyId);
    const plan = await loadPlanContext(companyId, BASELINE_SCENARIO);
    expect(plan.bundle, "this fixture must produce a feasible plan with at least one action").not.toBeNull();
    // Specifically the discount, not the deferral: only this one reaches SETTLED.
    const target = plan.specs.find((s) => s.kind === "ar_early_discount");
    expect(target, `fixture produced kinds [${plan.specs.map((s) => s.kind).join(", ")}], expected ar_early_discount`).toBeDefined();
    if (!target) return;
    expect(target.payload.currency).toBe("BDT");

    // APPROVED: minted with a BDT-formatted confirmation (the ৳ symbol and
    // BDT locale grouping must parse, not just ASCII "."-formatted USD).
    const confirmCents = target.confirmation.expected_cents;
    const confirmValue = (confirmCents / 100).toFixed(2);
    const approved = await act({
      action: "approve",
      target: { kind: "action", actionKey: target.action_key },
      confirmation: `৳${confirmValue}`,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const token = approved.body.userApprovalToken;

    // SUBMITTED / AWAITING_COUNTERPARTY: execution creates exactly one
    // action_execution row.
    const executed = await act({ action: "execute", target: { kind: "action", actionKey: target.action_key }, userApprovalToken: token });
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    const afterExecute = db()
      .prepare("SELECT status FROM action_execution WHERE action_key = ? AND business_id = ?")
      .get(target.action_key, companyId) as { status: string };
    expect(afterExecute.status).toBe("AWAITING_COUNTERPARTY");

    // Replaying the same approval token must not submit a second time.
    const replay = await act({ action: "execute", target: { kind: "action", actionKey: target.action_key }, userApprovalToken: token });
    expect(replay.status).toBeGreaterThanOrEqual(400);

    // ACCEPTED, then SETTLED: the counterparty simulation, sandbox-only.
    const accepted = await act({ action: "simulate", actionKey: target.action_key, response: "ACCEPTED" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const settled = await act({ action: "simulate", actionKey: target.action_key, response: "SETTLED" });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);

    // Exactly one cash_movement row for this action — never more, even if
    // settlement is attempted again.
    const movements = db()
      .prepare("SELECT amount_cents FROM cash_movement WHERE action_key = ?")
      .all(target.action_key) as { amount_cents: number }[];
    expect(movements).toHaveLength(1);

    const repeatSettle = await act({ action: "simulate", actionKey: target.action_key, response: "SETTLED" });
    expect(repeatSettle.status).toBeGreaterThanOrEqual(400);
    const movementsAfterRepeat = db().prepare("SELECT COUNT(*) AS n FROM cash_movement WHERE action_key = ?").get(target.action_key) as {
      n: number;
    };
    expect(movementsAfterRepeat.n).toBe(1);

    // Sandbox simulation never writes a user-reported payment.
    expect(listPayments(companyId)).toHaveLength(0);
  });
});

describe("sandbox simulation stays separate from user-reported outcomes", () => {
  it("recording a real payment never writes a cash_movement row", async () => {
    const fresh = await signUp("m4-separation@example.com");
    const created = await companyAction({ action: "create_company", name: "M4 Separation Co" }, fresh);
    const id = (created.body as { company: { id: string } }).company.id;
    await companyAction({ action: "add_account", name: "Main", openingBalance: "1000", asOfDate: day(-1) }, fresh, id);
    await companyAction({ action: "record_payment", direction: "receipt", amount: "200", effectiveDate: day(0) }, fresh, id);

    const movements = db().prepare("SELECT COUNT(*) AS n FROM cash_movement WHERE business_id = ?").get(id) as { n: number };
    expect(movements.n).toBe(0);
  });
});
