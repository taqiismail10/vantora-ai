/**
 * The authorization and execution boundary, exercised through the real route
 * handlers with real Better Auth sessions. Nothing here checks a button: every
 * assertion is on an HTTP status, a database row or an audit entry.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

// `connection()` needs a Next request scope; the route logic under test does not.
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

import { POST as action } from "../../../app/api/action/route";
import { GET as state } from "../../../app/api/state/route";
import { readChain } from "../../sandbox/execution-logger";
import { db } from "../db";
import { loadPlanContext, sandboxAccount, BASELINE_SCENARIO, type ScenarioRef } from "../plan";
import { getRequest, jsonRequest, signedInAs } from "./helpers";

let owner: string;
let analyst: string;
let viewer: string;

beforeAll(async () => {
  owner = await signedInAs("OWNER");
  analyst = await signedInAs("ANALYST");
  viewer = await signedInAs("VIEWER");
});

async function call(body: Record<string, unknown>, cookie?: string) {
  const response = await action(jsonRequest("/api/action", body, cookie));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function specFor(kind: string, ref: ScenarioRef = BASELINE_SCENARIO) {
  const plan = await loadPlanContext("smart-jeans-mfg", ref);
  return plan.specs.find((s) => s.kind === kind)!;
}

const executions = () => (db().prepare("SELECT COUNT(*) AS n FROM action_execution").get() as { n: number }).n;

function resetSandbox() {
  db().exec("DELETE FROM action_execution; DELETE FROM action_event; DELETE FROM approval; DELETE FROM cash_movement;");
}

describe("who may call", () => {
  it("rejects anonymous approval, execution and reads", async () => {
    expect((await call({ action: "approve", target: { kind: "plan" }, confirmation: "1" })).status).toBe(401);
    expect((await call({ action: "execute", target: { kind: "plan" }, userApprovalToken: "x" })).status).toBe(401);
    expect((await state(getRequest("/api/state"))).status).toBe(401);
  });

  it("rejects ANALYST and VIEWER approval and execution", async () => {
    for (const cookie of [analyst, viewer]) {
      expect((await call({ action: "approve", target: { kind: "plan" }, confirmation: "868.88" }, cookie)).status).toBe(403);
      expect((await call({ action: "execute", target: { kind: "plan" }, userApprovalToken: "v1.x.y" }, cookie)).status).toBe(403);
      expect((await call({ action: "simulate", actionKey: "k", response: "ACCEPTED" }, cookie)).status).toBe(403);
    }
  });

  it("lets a VIEWER read but not draft", async () => {
    expect((await state(getRequest("/api/state", viewer))).status).toBe(200);
    expect((await call({ action: "draft", tool: "draft_recovery_plan_summary" }, viewer)).status).toBe(403);
    expect((await call({ action: "draft", tool: "draft_recovery_plan_summary" }, analyst)).status).toBe(200);
  });

  it("refuses identity, role and business fields in the body", async () => {
    for (const forged of [{ actorId: "owner@x" }, { role: "OWNER" }, { businessId: "smart-jeans-mfg" }, { actorType: "human" }]) {
      const result = await call({ action: "approve", target: { kind: "plan" }, confirmation: "868.88", ...forged }, analyst);
      expect(result.status).toBe(400);
      expect(String(result.body.error)).toMatch(/identity is taken from your session/);
    }
  });

  it("refuses a cross-origin request even with a valid cookie", async () => {
    const request = new Request("http://localhost:3000/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", cookie: owner },
      body: JSON.stringify({ action: "verify_chain" }),
    });
    expect((await action(request)).status).toBe(403);
  });

  it("keeps Tier 3 prohibited for the OWNER", async () => {
    const result = await call({ action: "draft", tool: "wire_funds_to_external_account", input: {} }, owner);
    expect(result.body.decision).toBe("DENIED");
    expect(result.body.tier).toBe("TIER_3_PROHIBITED");
  });
});

describe("what an OWNER may approve", () => {
  const approveLegacy = (financing_id: string, amount: unknown) =>
    call({ action: "approve", operation: "accept_financing_offer", input: { financing_id, amount }, confirmation: "2345" }, owner);

  it("refuses an ineligible lender with the screening reason, and records the attempt", async () => {
    const before = readChain().length;
    const result = await approveLegacy("FIN-GRANITE", 10_000_000);
    expect(result.status).toBe(422);
    expect(String(result.body.error)).toMatch(/not eligible: credit score 672 below minimum 700/);
    const entry = readChain().at(-1)!;
    expect(readChain().length).toBe(before + 1);
    expect(entry).toMatchObject({ actorType: "human", operation: "accept_financing_offer", decision: "DENIED" });
    expect(entry.actorId).toMatch(/#OWNER$/);
    expect(entry.reason).toMatch(/refused before approval: Granite/);
  });

  it("refuses a facility that does not exist and a negative amount", async () => {
    expect(String((await approveLegacy("FIN-DOES-NOT-EXIST", 5000)).body.error)).toMatch(/not a facility on this ledger/);
    expect(String((await approveLegacy("FIN-MERIDIAN", -5000)).body.error)).toMatch(/cannot be negative/);
  });

  it("refuses an eligible facility the plan does not use, and an off-plan amount", async () => {
    expect(String((await approveLegacy("FIN-QUICKFLOAT", 90_000)).body.error)).toMatch(/not part of the current plan/);
    expect(String((await approveLegacy("FIN-MERIDIAN", 2345.5)).body.error)).toMatch(/must equal the planned draw of \$2,345\.00/);
    expect(String((await approveLegacy("FIN-MERIDIAN", "1e5")).body.error)).toMatch(/not a valid USD amount/);
    expect(String((await approveLegacy("FIN-MERIDIAN", Number.POSITIVE_INFINITY)).body.error)).toMatch(/amount/);
  });

  it("requires the confirmation to equal the actual financial effect", async () => {
    const draw = await specFor("bridge_draw");
    const wrong = await call({ action: "approve", target: { kind: "action", actionKey: draw.action_key }, confirmation: "2344" }, owner);
    expect(wrong.status).toBe(422);
    expect(String(wrong.body.error)).toMatch(/You confirmed \$2,344\.00, but the principal you draw is \$2,345\.00/);
    const missing = await call({ action: "approve", target: { kind: "action", actionKey: draw.action_key } }, owner);
    expect(missing.status).toBe(422);
  });

  it("uses per-action confirmation fields, not a loan amount everywhere", async () => {
    const deferral = await specFor("ap_deferral");
    const discount = await specFor("ar_early_discount");
    expect(deferral.confirmation).toMatchObject({ field: "deferred_cents", expected_cents: 3_000_000 });
    expect(discount.confirmation).toMatchObject({ field: "discount_cents", expected_cents: 64_500 });
  });
});

describe("approval binding and single execution", () => {
  it("executes a valid OWNER approval exactly once", async () => {
    resetSandbox();
    const draw = await specFor("bridge_draw");
    const approval = await call({ action: "approve", target: { kind: "action", actionKey: draw.action_key }, confirmation: "$2,345.00" }, owner);
    expect(approval.status).toBe(200);
    const token = String(approval.body.userApprovalToken);

    const first = await call({ action: "execute", target: { kind: "action", actionKey: draw.action_key }, userApprovalToken: token }, owner);
    expect(first.status).toBe(200);
    expect(first.body.decision).toBe("ALLOWED");
    expect(executions()).toBe(1);

    const replay = await call({ action: "execute", target: { kind: "action", actionKey: draw.action_key }, userApprovalToken: token }, owner);
    expect(replay.status).not.toBe(200);
    expect(executions()).toBe(1);
  });

  it("lets only one of two concurrent executions with the same approval through", async () => {
    resetSandbox();
    const discount = await specFor("ar_early_discount");
    const approval = await call({ action: "approve", target: { kind: "action", actionKey: discount.action_key }, confirmation: "645" }, owner);
    const body = { action: "execute", target: { kind: "action", actionKey: discount.action_key }, userApprovalToken: approval.body.userApprovalToken };
    const results = await Promise.all([call(body, owner), call(body, owner), call(body, owner)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(executions()).toBe(1);
  });

  it("refuses an expired approval", async () => {
    resetSandbox();
    const draw = await specFor("bridge_draw");
    const approval = await call({ action: "approve", target: { kind: "action", actionKey: draw.action_key }, confirmation: "2345" }, owner);
    db().prepare("UPDATE approval SET expires_at = ?").run(Date.now() - 1);
    const result = await call({ action: "execute", target: { kind: "action", actionKey: draw.action_key }, userApprovalToken: approval.body.userApprovalToken }, owner);
    expect(result.status).toBe(403);
    expect(String(result.body.reason)).toMatch(/expired/);
    expect(executions()).toBe(0);
  });

  it("refuses an approval presented by a different OWNER", async () => {
    resetSandbox();
    const other = await signedInAs("OWNER");
    const draw = await specFor("bridge_draw");
    const approval = await call({ action: "approve", target: { kind: "action", actionKey: draw.action_key }, confirmation: "2345" }, owner);
    const result = await call({ action: "execute", target: { kind: "action", actionKey: draw.action_key }, userApprovalToken: approval.body.userApprovalToken }, other);
    expect(result.status).toBe(403);
    expect(String(result.body.reason)).toMatch(/different user/);
  });

  it("cannot run an action twice through the full-plan and single-action paths", async () => {
    resetSandbox();
    const discount = await specFor("ar_early_discount");
    const single = await call({ action: "approve", target: { kind: "action", actionKey: discount.action_key }, confirmation: "645" }, owner);
    const plan = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    const cash = (plan.bundle!.payload.cash_cost_cents / 100).toFixed(2);
    const whole = await call({ action: "approve", target: { kind: "plan" }, confirmation: cash }, owner);
    expect(whole.status).toBe(200);

    // The full plan runs first and submits all three actions...
    const ran = await call({ action: "execute", target: { kind: "plan" }, userApprovalToken: whole.body.userApprovalToken }, owner);
    expect(ran.status).toBe(200);
    expect(executions()).toBe(3);

    // ...so the single-action approval for one of them can never run it again.
    const again = await call({ action: "execute", target: { kind: "action", actionKey: discount.action_key }, userApprovalToken: single.body.userApprovalToken }, owner);
    expect(again.status).toBe(409);
    expect(String(again.body.error)).toMatch(/already submitted/);
    expect(executions()).toBe(3);
  });

  it("submits the customer discount offer on its own, and the full plan then sends only the rest", async () => {
    resetSandbox();
    const discount = await specFor("ar_early_discount");
    const approval = await call({ action: "approve", target: { kind: "action", actionKey: discount.action_key }, confirmation: "645.00" }, owner);
    const sent = await call({ action: "execute", target: { kind: "action", actionKey: discount.action_key }, userApprovalToken: approval.body.userApprovalToken }, owner);
    expect(sent.status).toBe(200);
    expect(executions()).toBe(1);

    const after = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    const offer = after.records.find((r) => r.action_key === discount.action_key)!;
    expect(offer.status).toBe("AWAITING_COUNTERPARTY");
    expect(offer.events.map((e) => e.status)).toContain("AWAITING_COUNTERPARTY");
    expect(offer.events.every((e) => e.audit_seq !== null)).toBe(true);
    // The remaining plan no longer contains the offer already sent.
    expect(after.bundle!.action_keys).not.toContain(discount.action_key);
    expect(after.specs.some((s) => s.kind === "ar_early_discount" && s.target_id === discount.target_id)).toBe(false);

    const cash = (after.bundle!.payload.cash_cost_cents / 100).toFixed(2);
    const whole = await call({ action: "approve", target: { kind: "plan" }, confirmation: cash }, owner);
    expect((await call({ action: "execute", target: { kind: "plan" }, userApprovalToken: whole.body.userApprovalToken }, owner)).status).toBe(200);
    const final = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    expect(final.records.filter((r) => r.target_id === discount.target_id)).toHaveLength(1);
  });

  it("invalidates an outstanding approval when another action changes the plan", async () => {
    resetSandbox();
    const plan = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    const cash = (plan.bundle!.payload.cash_cost_cents / 100).toFixed(2);
    const whole = await call({ action: "approve", target: { kind: "plan" }, confirmation: cash }, owner);
    const draw = plan.specs.find((s) => s.kind === "bridge_draw")!;
    const single = await call({ action: "approve", target: { kind: "action", actionKey: draw.action_key }, confirmation: "2345" }, owner);
    await call({ action: "execute", target: { kind: "action", actionKey: draw.action_key }, userApprovalToken: single.body.userApprovalToken }, owner);

    const stale = await call({ action: "execute", target: { kind: "plan" }, userApprovalToken: whole.body.userApprovalToken }, owner);
    expect(stale.status).toBe(403);
    // The signed token embeds the plan version, so the HMAC check refuses it
    // before the database row is even consulted.
    expect(String(stale.body.reason)).toMatch(/plan changed since this approval|different recovery plan|payloadDigest mismatch/);
  });
});

describe("scenario consistency", () => {
  const stressed = { profile: "SOLVABLE_DAY14_CRUNCH", stress: { workforce: 150 } };
  const stressedRef: ScenarioRef = { preset: "SOLVABLE_DAY14_CRUNCH", stress: { delayShift: 0, workforce: 150, rho: 0, priorExtensions: 0 } };

  it("approves and executes the plan the owner is looking at under stress", async () => {
    resetSandbox();
    const plan = await loadPlanContext("smart-jeans-mfg", stressedRef);
    const cash = (plan.bundle!.payload.cash_cost_cents / 100).toFixed(2);
    const approval = await call({ action: "approve", target: { kind: "plan" }, confirmation: cash, scenario: stressed }, owner);
    expect(approval.status).toBe(200);
    const result = await call({ action: "execute", target: { kind: "plan" }, userApprovalToken: approval.body.userApprovalToken, scenario: stressed }, owner);
    expect(result.status).toBe(200);
    expect(result.body.decision).toBe("ALLOWED");
  });

  it("refuses a baseline approval presented under a stressed scenario", async () => {
    resetSandbox();
    const plan = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    const cash = (plan.bundle!.payload.cash_cost_cents / 100).toFixed(2);
    const approval = await call({ action: "approve", target: { kind: "plan" }, confirmation: cash }, owner);
    const result = await call({ action: "execute", target: { kind: "plan" }, userApprovalToken: approval.body.userApprovalToken, scenario: stressed }, owner);
    expect(result.status).toBe(403);
    // Caught twice over: the token's signed plan id embeds the plan version,
    // and the approval row records the scenario key.
    expect(String(result.body.reason)).toMatch(/different scenario|different recovery plan/);
    expect(executions()).toBe(0);
  });

  it("refuses off-dial stress values instead of silently using the baseline", async () => {
    const result = await call({ action: "approve", target: { kind: "plan" }, confirmation: "1", scenario: { stress: { workforce: 151 } } }, owner);
    expect(result.status).toBe(400);
  });
});

describe("counterparty responses", () => {
  async function executeWholePlan() {
    resetSandbox();
    const plan = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    const cash = (plan.bundle!.payload.cash_cost_cents / 100).toFixed(2);
    const approval = await call({ action: "approve", target: { kind: "plan" }, confirmation: cash }, owner);
    await call({ action: "execute", target: { kind: "plan" }, userApprovalToken: approval.body.userApprovalToken }, owner);
    return loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
  }

  it("treats submitted actions as forecast, not cash, and surfaces the next shortfall", async () => {
    const after = await executeWholePlan();
    expect(after.ctx.state.current_cash).toBe(52_000);
    expect(after.records.every((r) => r.status === "AWAITING_COUNTERPARTY")).toBe(true);
    // If every pending counterparty accepts, day 14 is back at the buffer...
    expect(after.ctx.forecast.p10_trajectory[13]).toBe(25_000);
    // ...and the re-solve finds the next gap: the day-22 VAT remittance, which
    // the echo check had already flagged as a dip below the buffer.
    expect(after.ctx.optimization.crunch_day).toBe(22);
    expect(after.ctx.optimization.required_cash).toBe(21_000);
  });

  it("re-plans coherently when the buyer declines, and revokes pending approvals", async () => {
    const after = await executeWholePlan();
    const zara = after.records.find((r) => r.kind === "ar_early_discount")!;
    // An approval for the day-22 top-up is outstanding when Zara declines.
    const cash = (after.bundle!.payload.cash_cost_cents / 100).toFixed(2);
    const pending = await call({ action: "approve", target: { kind: "plan" }, confirmation: cash }, owner);
    expect(pending.status).toBe(200);

    const declined = await call({ action: "simulate", actionKey: zara.action_key, response: "DECLINED" }, owner);
    expect(declined.status).toBe(200);
    const revised = declined.body.revised_plan as { feasible: boolean; actions: { label: string }[] };
    expect(revised.feasible).toBe(true);
    expect(revised.actions.length).toBeGreaterThan(0);
    expect(revised.actions.some((a) => /Zara/.test(a.label))).toBe(false);
    expect(declined.body.revoked_approvals).toBe(1);

    // The revoked approval cannot be spent on the revised plan.
    const stale = await call({ action: "execute", target: { kind: "plan" }, userApprovalToken: pending.body.userApprovalToken }, owner);
    expect(stale.status).toBe(403);
    expect(String(stale.body.reason)).toMatch(/revoked|plan changed|different recovery plan/);

    // Day 14 is open again without Zara's cash, and the revised plan closes it.
    const revisedPlan = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    expect(revisedPlan.ctx.optimization.crunch_day).toBe(14);
    expect(revisedPlan.ctx.optimization.optimal_plan.feasible).toBe(true);
  });

  it("records settled cash separately and only on SETTLED", async () => {
    const after = await executeWholePlan();
    const draw = after.records.find((r) => r.kind === "bridge_draw")!;
    await call({ action: "simulate", actionKey: draw.action_key, response: "ACCEPTED" }, owner);
    let plan = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    expect(plan.movements).toHaveLength(0);
    expect(plan.ctx.state.current_cash).toBe(52_000);
    await call({ action: "simulate", actionKey: draw.action_key, response: "SETTLED" }, owner);
    plan = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    expect(plan.movements.map((m) => m.amount_cents)).toEqual([234_500]);
    expect(plan.ctx.state.current_cash).toBe(54_345);
  });

  it("settles each action into the sandbox account exactly once, never on submit or accept", async () => {
    const after = await executeWholePlan();
    const zara = after.records.find((r) => r.kind === "ar_early_discount")!;
    const draw = after.records.find((r) => r.kind === "bridge_draw")!;
    const midland = after.records.find((r) => r.kind === "ap_deferral")!;
    const account = async () => sandboxAccount(await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO));

    // Submitted: everything is conditional, nothing is in the account.
    let a = await account();
    expect(a.cash_cents).toBe(5_200_000);
    expect(a.receivables_cents).toBe(a.receivables_opening_cents);
    expect(a.pending_inflows.map((i) => i.target_id).sort()).toEqual([draw.target_id, zara.target_id].sort());
    expect(a.moved_obligations).toEqual([]);

    // Accepted is a promise, not money.
    await call({ action: "simulate", actionKey: zara.action_key, response: "ACCEPTED" }, owner);
    await call({ action: "simulate", actionKey: midland.action_key, response: "ACCEPTED" }, owner);
    a = await account();
    expect(a.cash_cents).toBe(5_200_000);
    expect(a.moved_obligations).toEqual([
      { target_id: midland.target_id, amount_cents: midland.payload.deferred_cents! + midland.payload.fee_cents!, from_day: 10, to_day: 31 },
    ]);

    // Settlement moves cash, clears the receivable, books the discount and the facility debt.
    expect((await call({ action: "simulate", actionKey: zara.action_key, response: "SETTLED" }, owner)).status).toBe(200);
    await call({ action: "simulate", actionKey: draw.action_key, response: "ACCEPTED" }, owner);
    await call({ action: "simulate", actionKey: draw.action_key, response: "SETTLED" }, owner);
    a = await account();
    const expectedCash = 5_200_000 + zara.payload.settlement_cents! + draw.payload.principal_cents!;
    expect(a.cash_cents).toBe(expectedCash);
    expect(a.receivables_cents).toBe(a.receivables_opening_cents - zara.payload.face_cents!);
    expect(a.discounts_given_cents).toBe(zara.payload.discount_cents!);
    expect(a.facility_owed).toEqual([
      { target_id: draw.target_id, principal_cents: 234_500, cost_cents: draw.payload.cost_cents!, repay_day: 44 },
    ]);
    expect(a.pending_inflows).toEqual([]);

    // A second settlement is refused and changes nothing, even written straight to the table.
    expect((await call({ action: "simulate", actionKey: zara.action_key, response: "SETTLED" }, owner)).status).toBe(409);
    expect(() =>
      db()
        .prepare("INSERT INTO cash_movement (business_id, scenario_key, action_key, amount_cents, description, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("smart-jeans-mfg", after.scenarioKey, zara.action_key, 1, "dup", Date.now()),
    ).toThrow(/UNIQUE/);
    expect((await account()).cash_cents).toBe(expectedCash);
    const plan = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    expect(plan.ctx.state.current_cash * 100).toBe(expectedCash);
  });

  it("produces a payload React can hand to a client component once actions exist", async () => {
    await executeWholePlan();
    const { buildDashboardState } = await import("../../dashboard-data");
    const userId = (db().prepare("SELECT user_id FROM membership WHERE role = 'OWNER' LIMIT 1").get() as { user_id: string }).user_id;
    const payload = await buildDashboardState(
      { kind: "human", userId, email: "o@x", name: "O", role: "OWNER", businessId: "smart-jeans-mfg", sessionExpiresAt: new Date().toISOString() },
      BASELINE_SCENARIO,
    );
    // node:sqlite rows have a null prototype; React refuses those across the
    // server/client boundary, which once broke the page after any execution.
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (!Array.isArray(value)) expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      Object.values(value).forEach(walk);
    };
    walk(payload.execution);
    expect(payload.execution.actions.some((a) => a.events.length > 0)).toBe(true);
  });

  it("refuses a transition the action type cannot make", async () => {
    const after = await executeWholePlan();
    const deferral = after.records.find((r) => r.kind === "ap_deferral")!;
    expect((await call({ action: "simulate", actionKey: deferral.action_key, response: "SETTLED" }, owner)).status).toBe(409);
    expect((await call({ action: "simulate", actionKey: deferral.action_key, response: "PAID" }, owner)).status).toBe(409);
  });
});
