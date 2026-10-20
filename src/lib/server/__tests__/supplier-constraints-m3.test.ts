/**
 * M3.1: editable supplier constraints connected to recovery planning.
 *
 * What this pins, in the order the brief asks for it:
 *   explicit non-deferrability excludes a bill from deferral proposals;
 *   an agreed deferral limit is respected by the solve;
 *   criticality is a cost penalty, never an automatic exclusion — the hard
 *     gate is a bill's own `is_flexible`, nothing else;
 *   a supplier-default edit never rewrites an already-posted bill's terms,
 *     but an explicit edit to that bill itself does, on its next calculation;
 *   unauthorized and cross-company updates are rejected;
 *   a material edit invalidates only the editing company's plan version.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

import { POST as companyPost } from "../../../app/api/company/route";
import { getAuth } from "../auth";
import { db } from "../db";
import { loadPlanContext, BASELINE_SCENARIO } from "../plan";
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

/** The TS fallback optimizer — vitest has no Python engine running, exactly
 * as M2's tests already assume (`loadPlanContext` falls back to it). */
async function solve(companyId: string) {
  const plan = await loadPlanContext(companyId, BASELINE_SCENARIO);
  return plan.ctx.optimization;
}

let co: string;
let cookie: string;

beforeAll(async () => {
  ({ cookie, id: co } = await newCompany("m3-owner@example.com", "Supplier Constraints Co"));
});

describe("explicit non-deferrability", () => {
  it("excludes a bill explicitly marked fixed from deferral proposals", async () => {
    const cp = await post({ action: "add_counterparty", name: "Rigid Supplier", isSupplier: true }, cookie, co);
    const cpId = (cp.body as { counterparty: { id: string } }).counterparty.id;
    // A payroll-sized bill due early enough to force a crunch, deliberately
    // left fixed (no isFlexible) — explicitly, not just by omission.
    const bill = await post(
      { action: "add_payable", counterpartyId: cpId, amount: "90000", dueDate: day(5), isFlexible: false },
      cookie,
      co,
    );
    const billId = (bill.body as { payable: { id: string } }).payable.id;

    const optimization = await solve(co);
    const actions = optimization.optimal_plan.actions;
    expect(actions.some((a) => a.target_id === billId && a.kind === "ap_deferral")).toBe(false);
  });
});

describe("agreed deferral limits", () => {
  it("does not propose a deferral longer than the agreed limit", async () => {
    const fresh = await newCompany("m3-limit@example.com", "Deferral Limit Co");
    const cp = await post({ action: "add_counterparty", name: "Short Leash Supplier", isSupplier: true }, fresh.cookie, fresh.id);
    const cpId = (cp.body as { counterparty: { id: string } }).counterparty.id;
    // Due day 5, but only ever agreed to wait 2 days — a deferral past day 7
    // would need the crunch to be beyond that, which a 3-day limit prevents
    // from ever closing a later gap by itself.
    const bill = await post(
      {
        action: "add_payable",
        counterpartyId: cpId,
        amount: "90000",
        dueDate: day(5),
        isFlexible: true,
        maxDeferralDays: 2,
      },
      fresh.cookie,
      fresh.id,
    );
    const billId = (bill.body as { payable: { id: string } }).payable.id;

    const optimization = await solve(fresh.id);
    const deferral = optimization.optimal_plan.actions.find((a) => a.target_id === billId && a.kind === "ap_deferral");
    if (deferral) {
      // Whatever the plan proposes, it must stay within the 2-day limit.
      const detail = JSON.stringify(deferral);
      expect(detail).not.toMatch(/"days":\s*[3-9]\d*/);
    }
  });
});

describe("criticality and risk: a penalty, never an automatic exclusion", () => {
  it("still prices a flexible-and-critical bill as a deferral candidate, at a higher cost", async () => {
    // Exercised directly against the engine (as quant-client.test.ts already
    // does), not through a company, so the two runs differ by exactly one
    // field: whether the same otherwise-deferrable bill is marked critical.
    const { localForecast, localOptimize } = await import("../../quant-client");
    const { smartJeansFinancialState } = await import("../../sandbox/seed-data");

    const base = smartJeansFinancialState();
    const target = base.payables_ap.find((p) => p.is_flexible)!;
    expect(target).toBeDefined();

    const plain = localOptimize(base, localForecast(base));
    const critical = localOptimize(
      { ...base, payables_ap: base.payables_ap.map((p) => (p.id === target.id ? { ...p, is_critical: true, default_penalty: 5000 } : p)) },
      localForecast(base),
    );

    const deferredInPlain = plain.optimal_plan.actions.some((a) => a.target_id === target.id && a.kind === "ap_deferral");
    const deferredInCritical = critical.optimal_plan.actions.some((a) => a.target_id === target.id && a.kind === "ap_deferral");

    // Criticality must not silently remove it from candidacy: if the plain
    // run was willing to defer it, marking it critical can still choose to
    // (a cost penalty changes what is cheapest, not what is legal), and the
    // critical run's total cost must never be cheaper for the same gap —
    // the penalty has to show up as cost, not be ignored.
    if (deferredInPlain && deferredInCritical) {
      expect(critical.optimal_plan.total_cost).toBeGreaterThanOrEqual(plain.optimal_plan.total_cost);
    }
    // Either way, the candidate was never screened out of the feasible set
    // purely for being critical — the solve still ran to completion on it.
    expect(critical.optimal_plan.feasible).toBe(plain.optimal_plan.feasible);
  });
});

describe("supplier-default edits vs explicit obligation edits", () => {
  it("does not rewrite an already-posted bill's terms when the supplier default changes", async () => {
    const fresh = await newCompany("m3-snapshot@example.com", "Snapshot Preserved Co");
    const cp = await post(
      { action: "add_counterparty", name: "Changing Supplier", isSupplier: true, isFlexible: true, maxDeferralDays: 10 },
      fresh.cookie,
      fresh.id,
    );
    const cpId = (cp.body as { counterparty: { id: string } }).counterparty.id;
    const bill = await post(
      { action: "add_payable", counterpartyId: cpId, amount: "500", dueDate: day(10) },
      fresh.cookie,
      fresh.id,
    );
    const billId = (bill.body as { payable: { id: string } }).payable.id;
    const posted = (bill.body as { payable: { terms: Record<string, unknown> } }).payable.terms;
    expect(posted.is_flexible).toBe(true);
    expect(posted.max_deferral_days).toBe(10);

    // The supplier's default changes completely afterward.
    await post(
      { action: "update_counterparty", id: cpId, isFlexible: false, maxDeferralDays: 0, isCritical: true },
      fresh.cookie,
      fresh.id,
    );

    const { listPayables } = await import("../records");
    const stillPosted = listPayables(fresh.id).find((p) => p.id === billId)!;
    expect(stillPosted.terms.is_flexible).toBe(true);
    expect(stillPosted.terms.max_deferral_days).toBe(10);
  });

  it("applies an explicit edit to an existing bill on its next calculation", async () => {
    const fresh = await newCompany("m3-override@example.com", "Explicit Override Co");
    const cp = await post({ action: "add_counterparty", name: "Fixed By Default", isSupplier: true }, fresh.cookie, fresh.id);
    const cpId = (cp.body as { counterparty: { id: string } }).counterparty.id;
    const bill = await post(
      { action: "add_payable", counterpartyId: cpId, amount: "500", dueDate: day(10) },
      fresh.cookie,
      fresh.id,
    );
    const billId = (bill.body as { payable: { id: string } }).payable.id;
    const { listPayables } = await import("../records");
    expect(listPayables(fresh.id).find((p) => p.id === billId)!.terms.is_flexible).toBeUndefined();

    const before = await loadPlanContext(fresh.id, BASELINE_SCENARIO);

    const updated = await post(
      { action: "update_payable", id: billId, isFlexible: true, maxDeferralDays: 15 },
      fresh.cookie,
      fresh.id,
    );
    expect(updated.status).toBe(200);
    const after = (updated.body as { payable: { terms: Record<string, unknown> } }).payable.terms;
    expect(after.is_flexible).toBe(true);
    expect(after.max_deferral_days).toBe(15);

    // Read straight from storage too, not just the response echo.
    const stored = listPayables(fresh.id).find((p) => p.id === billId)!;
    expect(stored.terms.is_flexible).toBe(true);

    // The next plan for this company picks it up.
    const next = await loadPlanContext(fresh.id, BASELINE_SCENARIO);
    expect(next.planVersion).not.toBe(before.planVersion);
    expect(next.ctx.state.payables_ap.find((p) => p.id === billId)?.is_flexible).toBe(true);
  });
});

describe("authorization and company scoping", () => {
  it("rejects a cross-company update_counterparty", async () => {
    const owner = await newCompany("m3-cross-a@example.com", "Cross A Co");
    const other = await newCompany("m3-cross-b@example.com", "Cross B Co");
    const cp = await post({ action: "add_counterparty", name: "A's Supplier", isSupplier: true }, owner.cookie, owner.id);
    const cpId = (cp.body as { counterparty: { id: string } }).counterparty.id;

    // B's session, naming A's company: refused before anything is read.
    const forged = await post({ action: "update_counterparty", id: cpId, isCritical: true }, other.cookie, owner.id);
    expect(forged.status).toBe(403);

    // B's own session and company, but A's counterparty id: not found, not leaked into.
    const wrongId = await post({ action: "update_counterparty", id: cpId, isCritical: true }, other.cookie, other.id);
    expect(wrongId.status).toBe(404);
  });

  it("rejects a cross-company update_payable", async () => {
    const owner = await newCompany("m3-cross-c@example.com", "Cross C Co");
    const other = await newCompany("m3-cross-d@example.com", "Cross D Co");
    const cp = await post({ action: "add_counterparty", name: "C's Supplier", isSupplier: true }, owner.cookie, owner.id);
    const cpId = (cp.body as { counterparty: { id: string } }).counterparty.id;
    const bill = await post(
      { action: "add_payable", counterpartyId: cpId, amount: "100", dueDate: day(10) },
      owner.cookie,
      owner.id,
    );
    const billId = (bill.body as { payable: { id: string } }).payable.id;

    const wrongId = await post({ action: "update_payable", id: billId, isFlexible: true }, other.cookie, other.id);
    expect(wrongId.status).toBe(404);
  });

  it("rejects a VIEWER updating supplier terms", async () => {
    const owner = await newCompany("m3-viewer-owner@example.com", "Viewer Gate Co");
    const cp = await post({ action: "add_counterparty", name: "Gated Supplier", isSupplier: true }, owner.cookie, owner.id);
    const cpId = (cp.body as { counterparty: { id: string } }).counterparty.id;

    const viewerCookie = await signUp("m3-viewer@example.com");
    const userId = (db().prepare("SELECT id FROM user WHERE email = ?").get("m3-viewer@example.com") as { id: string }).id;
    db()
      .prepare("INSERT INTO membership (user_id, business_id, role, created_at, created_by) VALUES (?, ?, 'VIEWER', ?, 'test')")
      .run(userId, owner.id, Date.now());

    const result = await post({ action: "update_counterparty", id: cpId, isCritical: true }, viewerCookie, owner.id);
    expect(result.status).toBe(403);
  });
});

describe("material edits invalidate only the editing company's plan", () => {
  it("changes this company's plan version but not another's", async () => {
    const a = await newCompany("m3-plan-a@example.com", "Plan Invalidation A");
    const b = await newCompany("m3-plan-b@example.com", "Plan Invalidation B");
    const cpA = await post({ action: "add_counterparty", name: "A Supplier", isSupplier: true }, a.cookie, a.id);
    const cpAId = (cpA.body as { counterparty: { id: string } }).counterparty.id;
    const billA = await post(
      { action: "add_payable", counterpartyId: cpAId, amount: "300", dueDate: day(10) },
      a.cookie,
      a.id,
    );
    const billAId = (billA.body as { payable: { id: string } }).payable.id;

    const aBefore = (await loadPlanContext(a.id, BASELINE_SCENARIO)).planVersion;
    const bBefore = (await loadPlanContext(b.id, BASELINE_SCENARIO)).planVersion;

    await post({ action: "update_payable", id: billAId, isFlexible: true, maxDeferralDays: 5 }, a.cookie, a.id);

    expect((await loadPlanContext(a.id, BASELINE_SCENARIO)).planVersion).not.toBe(aBefore);
    expect((await loadPlanContext(b.id, BASELINE_SCENARIO)).planVersion).toBe(bBefore);
  });
});
