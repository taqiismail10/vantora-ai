/**
 * The copilot answers for exactly one company: the one the caller's session
 * grants, never one named in the request and never the demonstration seed.
 *
 * This file exists because of a real defect. `/api/copilot` and every
 * `/api/action` branch called `loadPlanContext` without a dataset, so a real
 * company's copilot, drafts and approvals all ran on the seeded Smart Jeans
 * figures while being labelled as that company's. The dataset is now resolved
 * inside `loadPlanContext` from the business id alone; these tests pin that.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

import { POST as action } from "../../../app/api/action/route";
import { POST as companyPost } from "../../../app/api/company/route";
import { POST as copilot } from "../../../app/api/copilot/route";
import { getAuth } from "../auth";
import { db } from "../db";
import { loadPlanContext, BASELINE_SCENARIO } from "../plan";
import { BASE } from "./helpers";

const PASSWORD = "correct-horse-battery-staple-42";

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
  return signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

function post(handler: (r: Request) => Promise<Response>, path: string, body: unknown, cookie: string, company?: string) {
  return handler(
    new Request(`${BASE}${path}`, {
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
}

/** A company whose figures are unmistakable if they leak. */
async function companyWith(cookie: string, name: string, cash: string, invoice: string, buyer: string) {
  const created = await post(companyPost, "/api/company", { action: "create_company", name }, cookie);
  const id = ((await created.json()) as { company: { id: string } }).company.id;
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  await post(companyPost, "/api/company", { action: "add_account", name: "Main", openingBalance: cash, asOfDate: day(-1) }, cookie, id);
  const cp = await post(companyPost, "/api/company", { action: "add_counterparty", name: buyer, isBuyer: true, isSupplier: true }, cookie, id);
  const counterpartyId = ((await cp.json()) as { counterparty: { id: string } }).counterparty.id;
  await post(companyPost, "/api/company", { action: "add_receivable", counterpartyId, amount: invoice, dueDate: day(9) }, cookie, id);
  await post(
    companyPost,
    "/api/company",
    { action: "add_payable", counterpartyId, amount: "7000", dueDate: day(7), isPayroll: true },
    cookie,
    id,
  );
  return { id, counterpartyId };
}

let aliceCookie: string;
let aliceCo: string;
let bobCookie: string;
let bobCo: string;

beforeAll(async () => {
  aliceCookie = await signUp("iso-alice@north.example");
  ({ id: aliceCo } = await companyWith(aliceCookie, "Northwind Looms", "123456", "54321", "Aurora Retail"));
  bobCookie = await signUp("iso-bob@south.example");
  ({ id: bobCo } = await companyWith(bobCookie, "Southgate Mills", "999111", "88222", "Borealis Trading"));
});

const DEMO = /smart ?jeans|kenneth cole|zara|atradius|coface/i;

describe("the copilot's dataset comes from the session's company", () => {
  it("answers from the caller's own figures, not the demonstration seed", async () => {
    const ask = (cookie: string, company: string) =>
      post(copilot, "/api/copilot", { question: "How much cash do we have?" }, cookie, company);

    const hers = (await (await ask(aliceCookie, aliceCo)).json()) as { answer: string; plan_id: string; attested: boolean };
    const his = (await (await ask(bobCookie, bobCo)).json()) as { answer: string; plan_id: string };

    expect(hers.plan_id.startsWith(aliceCo)).toBe(true);
    expect(hers.plan_id).not.toMatch(/smartjeans/);
    expect(hers.answer).not.toMatch(DEMO);
    expect(hers.answer).not.toMatch(/Borealis|Southgate/);

    // Each company gets its own answer, and every figure in it clears the
    // numerical check against that company's own engine output.
    expect(hers.answer).not.toBe(his.answer);
    expect(hers.attested).toBe(true);

    // The recovered balance is hers: 123,456 cash + 54,321 due in - 7,000 payroll.
    expect(hers.answer).toContain("170,777");
    expect(his.answer).not.toContain("170,777");
  });

  it("gives each company a different plan built from its own records", async () => {
    const a = await loadPlanContext(aliceCo, BASELINE_SCENARIO);
    const b = await loadPlanContext(bobCo, BASELINE_SCENARIO);
    expect(a.ctx.state.current_cash).toBe(123456);
    expect(b.ctx.state.current_cash).toBe(999111);
    expect(a.planVersion).not.toBe(b.planVersion);
    expect(a.ctx.planId).not.toBe(b.ctx.planId);
    expect(a.ctx.state.invoices_ar[0].customer_name).toBe("Aurora Retail");
    expect(b.ctx.state.invoices_ar[0].customer_name).toBe("Borealis Trading");
    // Neither carries the demonstration dataset's memos.
    expect(a.ctx.memos).toEqual({});
    expect(JSON.stringify(a.ctx.state)).not.toMatch(DEMO);
  });

  it("refuses a company named in the request body", async () => {
    const response = await post(copilot, "/api/copilot", { question: "cash?", businessId: bobCo }, aliceCookie, aliceCo);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/may not set businessId/);
  });

  it("refuses a company header the caller is not a member of", async () => {
    const response = await post(copilot, "/api/copilot", { question: "cash?" }, aliceCookie, bobCo);
    expect(response.status).toBe(403);
  });

  it("will not let the scenario selector reach another company's dataset", async () => {
    // The only scenario knobs are presets and stress dials; neither names a
    // company, and a real company ignores presets entirely.
    const response = await post(
      copilot,
      "/api/copilot",
      { question: "cash?", scenario: { preset: "INSOLVENT_STRUCTURAL_GAP", stress: { workforce: 150 } } },
      aliceCookie,
      aliceCo,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { answer: string };
    expect(body.answer).not.toMatch(DEMO);
    // The preset's structural dataset must not have replaced hers.
    const plan = await loadPlanContext(aliceCo, BASELINE_SCENARIO);
    expect(plan.ctx.state.current_cash).toBe(123456);
  });
});

describe("model-requested tools stay inside the caller's company", () => {
  it("runs tools against the session's company and audits them under it", async () => {
    const { readChain } = await import("../../sandbox/execution-logger");
    const { visibleChainFor } = await import("../companies");
    const before = readChain().length;

    const response = await post(
      copilot,
      "/api/copilot",
      { question: "Run the recovery optimisation and tell me the cheapest plan." },
      aliceCookie,
      aliceCo,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tool_runs: { tool: string }[] };

    const added = readChain().slice(before);
    if (added.length) {
      // Everything written for this turn belongs to her company.
      expect(added.every((e) => e.smeProfileId === aliceCo)).toBe(true);
      expect(JSON.stringify(added)).not.toMatch(DEMO);
      // And none of it is visible to the other company.
      expect(visibleChainFor(bobCo, readChain()).some((e) => e.smeProfileId === aliceCo)).toBe(false);
    }
    expect(Array.isArray(body.tool_runs)).toBe(true);
  });

  it("drafts for a real company from that company's own plan", async () => {
    const response = await post(
      action,
      "/api/action",
      { action: "draft", tool: "draft_recovery_plan_summary" },
      aliceCookie,
      aliceCo,
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toMatch(DEMO);
  });

  it("keeps the demonstration company on the seeded dataset", async () => {
    db()
      .prepare(
        "INSERT OR IGNORE INTO membership (user_id, business_id, role, created_at, created_by) VALUES ((SELECT id FROM user WHERE email = ?), 'smart-jeans-mfg', 'OWNER', ?, 'test')",
      )
      .run("iso-alice@north.example", Date.now());
    const plan = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    expect(plan.ctx.planId).toMatch(/^smartjeans-/);
    expect(plan.ctx.state.company_name).toMatch(/Smart Jeans/i);
    expect(Object.keys(plan.ctx.memos).length).toBeGreaterThan(0);
    db()
      .prepare("DELETE FROM membership WHERE business_id = 'smart-jeans-mfg' AND user_id = (SELECT id FROM user WHERE email = ?)")
      .run("iso-alice@north.example");
  });
});
