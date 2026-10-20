/**
 * The customer journey, end to end through the real route handlers.
 *
 * `company-m1.test.ts` proves the record layer. This file proves the parts a
 * person actually walks through: that an anonymous visitor is not treated as a
 * tenant, that a company's own numbers reach its own forecast, that switching
 * between two companies swaps every figure and the currency with them, and
 * that the demonstration company still behaves exactly as it did.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

import { POST as companyPost } from "../../../app/api/company/route";
import { GET as stateGet } from "../../../app/api/state/route";
import { buildDashboardState, CompanyNotReadyError } from "../../dashboard-data";
import { getAuth } from "../auth";
import { companiesForUser, getCompany } from "../companies";
import { requireActor, requireSession } from "../identity";
import { BASELINE_SCENARIO } from "../plan";
import { BASE, getRequest, signedInAs } from "./helpers";

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
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function post(body: Record<string, unknown>, cookie: string, company?: string) {
  const headers = new Headers({ "content-type": "application/json", origin: BASE, cookie });
  if (company) headers.set("x-vantora-company", company);
  const response = await companyPost(new Request(`${BASE}/api/company`, { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const state = (cookie: string, company: string) =>
  stateGet(new Request(`${BASE}/api/state`, { headers: { cookie, "x-vantora-company": company } }));

/** One owner, two companies, different currencies and different figures. */
let cookie: string;
let dhaka: string;
let miami: string;

beforeAll(async () => {
  cookie = await signUp("journey@two.example");

  const a = await post({ action: "create_company", name: "Dhaka Knitwear", currency: "BDT", country: "BD" }, cookie);
  dhaka = (a.body as { company: { id: string } }).company.id;
  const b = await post({ action: "create_company", name: "Miami Imports", currency: "USD", country: "US" }, cookie);
  miami = (b.body as { company: { id: string } }).company.id;

  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);

  for (const [id, cash, buyer, invoice] of [
    [dhaka, "400000", "Zara Bangladesh", "150000"],
    [miami, "25000", "Gulf Retail", "9000"],
  ] as const) {
    await post({ action: "add_account", name: "Operating", openingBalance: cash, asOfDate: today }, cookie, id);
    const party = await post({ action: "add_counterparty", name: buyer, isBuyer: true }, cookie, id);
    await post(
      {
        action: "add_receivable",
        counterpartyId: (party.body as { counterparty: { id: string } }).counterparty.id,
        amount: invoice,
        dueDate: due,
      },
      cookie,
      id,
    );
  }
});

describe("a visitor is not a tenant", () => {
  it("has no session, so nothing company-scoped resolves", async () => {
    await expect(requireSession(getRequest("/"))).rejects.toMatchObject({ status: 401 });
    await expect(requireActor(getRequest("/api/state"), "read")).rejects.toMatchObject({ status: 401 });
    expect((await stateGet(getRequest("/api/state"))).status).toBe(401);
  });
});

describe("a signed-in account with no company", () => {
  it("is routed to onboarding rather than into someone else's workspace", async () => {
    const fresh = await signUp("nobody@new.example");
    const session = await requireSession(getRequest("/", fresh));
    // This is the condition src/app/page.tsx redirects on.
    expect(companiesForUser(session.userId)).toEqual([]);
    await expect(requireActor(getRequest("/", fresh), "read")).rejects.toMatchObject({ status: 403 });
  });

  it("gets a company-not-ready error, not a demo fallback, before entering an account", async () => {
    const fresh = await signUp("empty@new.example");
    const created = await post({ action: "create_company", name: "Empty Co" }, fresh);
    const id = (created.body as { company: { id: string } }).company.id;
    const actor = await requireActor(
      new Request(`${BASE}/`, { headers: { cookie: fresh, "x-vantora-company": id } }),
      "read",
    );
    await expect(buildDashboardState(actor, BASELINE_SCENARIO)).rejects.toBeInstanceOf(CompanyNotReadyError);
  });
});

describe("a company's own records reach its own forecast", () => {
  it("opens the forecast on the balance that was entered, in that company's currency", async () => {
    const response = await state(cookie, dhaka);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      company: { name: string; currency: string; is_demo: boolean };
      state: { current_cash: number; invoices_ar: { customer_name: string; amount: number }[] };
      seed: { mode: string };
    };
    expect(payload.company).toMatchObject({ name: "Dhaka Knitwear", currency: "BDT", is_demo: false });
    expect(payload.state.current_cash).toBe(400_000);
    expect(payload.state.invoices_ar).toHaveLength(1);
    expect(payload.state.invoices_ar[0]).toMatchObject({ customer_name: "Zara Bangladesh", amount: 150_000 });
    expect(payload.seed.mode).toBe("company");
  });

  it("runs the real forecast and optimizer over those figures", async () => {
    const payload = (await (await state(cookie, dhaka)).json()) as {
      forecast: { p10_trajectory: number[]; engine_source: string };
      optimization: { solver_status: string };
    };
    // The engine actually ran over this company's numbers: a 30-day P10 path.
    expect(payload.forecast.p10_trajectory).toHaveLength(30);
    expect(payload.forecast.engine_source).toMatch(/python-fastapi|typescript-fallback/);
    expect(typeof payload.optimization.solver_status).toBe("string");
  });
});

describe("switching between two companies", () => {
  it("swaps every figure and the currency with it", async () => {
    const bd = (await (await state(cookie, dhaka)).json()) as {
      company: { currency: string; name: string };
      state: { current_cash: number; invoices_ar: { customer_name: string }[] };
      plan_id: string;
      scenario: { dataset_version: string };
    };
    const us = (await (await state(cookie, miami)).json()) as typeof bd;

    expect(bd.company.currency).toBe("BDT");
    expect(us.company.currency).toBe("USD");
    expect(bd.state.current_cash).toBe(400_000);
    expect(us.state.current_cash).toBe(25_000);
    expect(bd.state.invoices_ar[0].customer_name).toBe("Zara Bangladesh");
    expect(us.state.invoices_ar[0].customer_name).toBe("Gulf Retail");
    // Separate plan identities and separate data versions, so an approval
    // minted against one can never match the other.
    expect(bd.plan_id).not.toBe(us.plan_id);
    expect(bd.scenario.dataset_version).not.toBe(us.scenario.dataset_version);
  });

  it("re-reading one company does not carry the other's figures across", async () => {
    // Interleaved reads: shared state would let the last one win.
    const first = (await (await state(cookie, dhaka)).json()) as { state: { current_cash: number } };
    await state(cookie, miami);
    const again = (await (await state(cookie, dhaka)).json()) as { state: { current_cash: number } };
    expect(again.state.current_cash).toBe(first.state.current_cash);
    expect(again.state.current_cash).toBe(400_000);
  });

  it("refuses a company the account does not belong to", async () => {
    const stranger = await signUp("stranger@elsewhere.example");
    await post({ action: "create_company", name: "Stranger Co" }, stranger);
    expect((await state(stranger, dhaka)).status).toBe(403);
    expect((await state(cookie, "smart-jeans-mfg")).status).toBe(403);
  });
});

describe("missing data is disclosed, not smoothed over", () => {
  it("warns that payroll was never entered and that balances are unreconciled", async () => {
    const payload = (await (await state(cookie, miami)).json()) as {
      coverage: { level: string; code: string; message: string }[];
    };
    const codes = payload.coverage.map((note) => note.code);
    expect(codes).toContain("payroll_not_entered");
    expect(codes).toContain("balances_not_reconciled");
    expect(codes).toContain("no_buffer");
    expect(payload.coverage.find((n) => n.code === "payroll_not_entered")?.level).toBe("warning");
  });
});

describe("the demonstration company is unchanged", () => {
  it("still builds, still labelled a demo, still offers its scenarios, and discloses nothing", async () => {
    const demo = await signedInAs("OWNER");
    const response = await stateGet(getRequest("/api/state", demo));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      company: { id: string; is_demo: boolean; currency: string };
      coverage: unknown[];
      profile: { available: unknown[] };
      seed: { mode: string };
      plan_id: string;
      state: { company_name?: string };
    };
    expect(payload.company).toMatchObject({ id: "smart-jeans-mfg", is_demo: true, currency: "USD" });
    // Its dataset is complete by construction, so there is nothing to disclose.
    expect(payload.coverage).toEqual([]);
    expect(payload.profile.available.length).toBeGreaterThan(1);
    expect(payload.seed.mode).not.toBe("company");
    expect(payload.plan_id).toMatch(/^smartjeans-/);
  });

  it("is read-only: an owner of it cannot enter records into it", async () => {
    const demo = await signedInAs("OWNER");
    const result = await post(
      { action: "add_account", name: "Nope", openingBalance: "1", asOfDate: "2026-10-01" },
      demo,
      "smart-jeans-mfg",
    );
    expect(result.status).toBe(403);
  });

  it("never lends its records to a real company", () => {
    for (const id of [dhaka, miami]) {
      const company = getCompany(id)!;
      expect(company.isDemo).toBe(false);
      expect(company.name).not.toMatch(/Smart Jeans/i);
    }
  });
});
