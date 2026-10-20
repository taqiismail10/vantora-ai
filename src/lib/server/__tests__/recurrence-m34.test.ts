/**
 * M3.4: recurring obligations.
 *
 * What this pins:
 *   weekly and monthly occurrence dates, including the explicit month-end
 *     clamp rule;
 *   generation creates ordinary payable rows through the existing entry
 *     path, reaching the forecast and the company's dataVersion;
 *   repeated and concurrent generation create no duplicates, enforced by
 *     the database, not just application logic;
 *   explicit linking to an existing payable counts it once, never auto-merged;
 *   editing or pausing a schedule never rewrites an already-generated payable;
 *   payroll occurrences carry is_payroll and a correctly offset lock date;
 *   generation never moves cash;
 *   tenant/role boundaries on every new action.
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
import { listPayables } from "../records";
import { netCashCents } from "../settlements";
import { defaultHorizonDate, occurrenceDates, previewOccurrences } from "../recurrence";
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
      headers: { "content-type": "application/json", origin: BASE, cookie, ...(company ? { "x-vantora-company": company } : {}) },
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

describe("occurrenceDates", () => {
  it("lands on the stated weekday every week", () => {
    // 2026-11-02 is a Monday (day 1).
    const dates = occurrenceDates("weekly", 1, "2026-11-01", "2026-11-22");
    expect(dates).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
  });

  it("clamps day 31 to the last real day of a shorter month", () => {
    const dates = occurrenceDates("monthly", 31, "2026-01-01", "2026-04-30");
    // Jan 31, Feb 28 (not a leap year), Mar 31, Apr 30.
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("returns nothing when the window is empty", () => {
    expect(occurrenceDates("monthly", 1, "2026-05-01", "2026-04-01")).toEqual([]);
  });
});

describe("generation reuses the existing payable entry path", () => {
  it("creates a payable that reaches the forecast and changes the plan version", async () => {
    const co = await newCompany("m34-generate@example.com", "Recurring Co");
    const supplier = await post({ action: "add_counterparty", name: "Landlord", isSupplier: true }, co.cookie, co.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    const recurring = await post(
      {
        action: "add_recurring",
        counterpartyId: supplierId,
        category: "rent",
        amount: "5000",
        schedule: "monthly",
        scheduleDay: 1,
        startDate: day(-40),
      },
      co.cookie,
      co.id,
    );
    expect(recurring.status).toBe(200);
    const recurringId = (recurring.body as { recurring: { id: string } }).recurring.id;

    const before = (await loadPlanContext(co.id, BASELINE_SCENARIO)).planVersion;
    const cashBefore = netCashCents(co.id);

    const generated = await post({ action: "generate_recurring_occurrences", id: recurringId }, co.cookie, co.id);
    expect(generated.status).toBe(200);
    expect((generated.body as { generated: number }).generated).toBeGreaterThan(0);

    const payables = listPayables(co.id);
    expect(payables.length).toBeGreaterThan(0);
    expect(payables[0].source).toBe("manual"); // addPayable's own default — recurrence adds no new provenance tag of its own

    // Reaches the forecast and invalidates the plan.
    const after = await loadPlanContext(co.id, BASELINE_SCENARIO);
    expect(after.planVersion).not.toBe(before);
    expect(after.ctx.state.payables_ap.length).toBeGreaterThan(0);

    // Generation itself never moves cash.
    expect(netCashCents(co.id)).toBe(cashBefore);
  });

  it("gives a payroll occurrence is_payroll and a correctly offset lock date", async () => {
    const co = await newCompany("m34-payroll@example.com", "Payroll Co");
    const supplier = await post({ action: "add_counterparty", name: "Payroll Processor", isSupplier: true }, co.cookie, co.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    const recurring = await post(
      {
        action: "add_recurring",
        counterpartyId: supplierId,
        category: "payroll",
        amount: "20000",
        schedule: "monthly",
        scheduleDay: 25,
        startDate: day(-40),
        isPayroll: true,
        payrollLockOffsetDays: 3,
      },
      co.cookie,
      co.id,
    );
    const recurringId = (recurring.body as { recurring: { id: string } }).recurring.id;
    await post({ action: "generate_recurring_occurrences", id: recurringId }, co.cookie, co.id);

    const payable = listPayables(co.id).find((p) => p.isPayroll)!;
    expect(payable).toBeDefined();
    expect(payable.payrollLockDate).not.toBeNull();
    const dueDate = new Date(`${payable.dueDate}T00:00:00Z`);
    const lockDate = new Date(`${payable.payrollLockDate}T00:00:00Z`);
    const offsetDays = (dueDate.getTime() - lockDate.getTime()) / 86_400_000;
    expect(offsetDays).toBe(3);
  });
});

describe("repeated and concurrent generation create no duplicates", () => {
  it("generating twice in a row adds nothing the second time", async () => {
    const co = await newCompany("m34-repeat@example.com", "Repeat Gen Co");
    const supplier = await post({ action: "add_counterparty", name: "Utility Co", isSupplier: true }, co.cookie, co.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    const recurring = await post(
      { action: "add_recurring", counterpartyId: supplierId, category: "utilities", amount: "300", schedule: "monthly", scheduleDay: 5, startDate: day(-70) },
      co.cookie,
      co.id,
    );
    const recurringId = (recurring.body as { recurring: { id: string } }).recurring.id;

    const first = await post({ action: "generate_recurring_occurrences", id: recurringId }, co.cookie, co.id);
    const firstCount = (first.body as { generated: number }).generated;
    expect(firstCount).toBeGreaterThan(0);

    const second = await post({ action: "generate_recurring_occurrences", id: recurringId }, co.cookie, co.id);
    expect((second.body as { generated: number }).generated).toBe(0);
    expect((second.body as { alreadyResolved: number }).alreadyResolved).toBe(firstCount);

    expect(listPayables(co.id)).toHaveLength(firstCount);
  });

  it("two concurrent generate calls still produce exactly the right count, enforced by the database", async () => {
    const co = await newCompany("m34-concurrent@example.com", "Concurrent Gen Co");
    const supplier = await post({ action: "add_counterparty", name: "Concurrent Supplier", isSupplier: true }, co.cookie, co.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    const recurring = await post(
      { action: "add_recurring", counterpartyId: supplierId, category: "other", amount: "100", schedule: "weekly", scheduleDay: 1, startDate: day(-60) },
      co.cookie,
      co.id,
    );
    const recurringId = (recurring.body as { recurring: { id: string } }).recurring.id;

    const [a, b] = await Promise.all([
      post({ action: "generate_recurring_occurrences", id: recurringId }, co.cookie, co.id),
      post({ action: "generate_recurring_occurrences", id: recurringId }, co.cookie, co.id),
    ]);
    const totalGenerated = (a.body as { generated: number }).generated + (b.body as { generated: number }).generated;
    const payables = listPayables(co.id);
    expect(payables).toHaveLength(totalGenerated);

    const expectedCount = previewOccurrences(co.id, recurringId, defaultHorizonDate()).length;
    expect(payables).toHaveLength(expectedCount);

    // No duplicate external_id reached the database.
    const refs = db().prepare("SELECT external_id FROM payable WHERE company_id = ?").all(co.id) as { external_id: string }[];
    expect(new Set(refs.map((r) => r.external_id)).size).toBe(refs.length);
  });
});

describe("linking to an existing payable", () => {
  it("counts an existing bill once instead of generating a duplicate", async () => {
    const co = await newCompany("m34-link@example.com", "Link Co");
    const supplier = await post({ action: "add_counterparty", name: "Linked Supplier", isSupplier: true }, co.cookie, co.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    const recurring = await post(
      { action: "add_recurring", counterpartyId: supplierId, category: "rent", amount: "1000", schedule: "monthly", scheduleDay: 1, startDate: day(-5) },
      co.cookie,
      co.id,
    );
    const recurringId = (recurring.body as { recurring: { id: string } }).recurring.id;

    const planned = previewOccurrences(co.id, recurringId, defaultHorizonDate());
    expect(planned.length).toBeGreaterThan(0);
    const occurrenceDate = planned[0].dueDate;

    // A manually entered bill, already on file, for the same occurrence.
    const manual = await post(
      { action: "add_payable", counterpartyId: supplierId, amount: "1000", dueDate: occurrenceDate },
      co.cookie,
      co.id,
    );
    const manualId = (manual.body as { payable: { id: string } }).payable.id;

    const linked = await post(
      { action: "link_recurring_occurrence", id: recurringId, dueDate: occurrenceDate, payableId: manualId },
      co.cookie,
      co.id,
    );
    expect(linked.status).toBe(200);

    // Generating now must not also create a payable for that same date.
    await post({ action: "generate_recurring_occurrences", id: recurringId }, co.cookie, co.id);
    const payables = listPayables(co.id).filter((p) => p.dueDate === occurrenceDate);
    expect(payables).toHaveLength(1);
    expect(payables[0].id).toBe(manualId);
  });

  it("never automatically merges on matching amount, category or month", async () => {
    const co = await newCompany("m34-no-automerge@example.com", "No Automerge Co");
    const supplier = await post({ action: "add_counterparty", name: "Coincidence Supplier", isSupplier: true }, co.cookie, co.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    const recurring = await post(
      { action: "add_recurring", counterpartyId: supplierId, category: "other", amount: "750", schedule: "monthly", scheduleDay: 15, startDate: day(-5) },
      co.cookie,
      co.id,
    );
    const recurringId = (recurring.body as { recurring: { id: string } }).recurring.id;
    const planned = previewOccurrences(co.id, recurringId, defaultHorizonDate());
    expect(planned.length).toBeGreaterThan(0);
    const occurrenceDate = planned[0].dueDate;

    // A manual bill that happens to land on the exact same date, amount and
    // counterparty as the schedule's own first occurrence.
    await post({ action: "add_payable", counterpartyId: supplierId, amount: "750", dueDate: occurrenceDate }, co.cookie, co.id);
    await post({ action: "generate_recurring_occurrences", id: recurringId }, co.cookie, co.id);

    // Still two separate bills, not folded into one just because every
    // field happens to match.
    const sameDate = listPayables(co.id).filter((p) => p.dueDate === occurrenceDate);
    expect(sameDate).toHaveLength(2);
    expect(new Set(sameDate.map((p) => p.id)).size).toBe(2);
  });

  it("refuses a payable that belongs to another company and writes nothing", async () => {
    const co = await newCompany("m34-link-home@example.com", "Link Home Co");
    const stranger = await newCompany("m34-link-away@example.com", "Link Stranger Co");
    const strangerParty = await post({ action: "add_counterparty", name: "Stranger Supplier", isSupplier: true }, stranger.cookie, stranger.id);
    const strangerPartyId = (strangerParty.body as { counterparty: { id: string } }).counterparty.id;
    const strangerBill = await post({ action: "add_payable", counterpartyId: strangerPartyId, amount: "500", dueDate: day(10) }, stranger.cookie, stranger.id);
    const strangerBillId = (strangerBill.body as { payable: { id: string } }).payable.id;

    const supplier = await post({ action: "add_counterparty", name: "Home Supplier", isSupplier: true }, co.cookie, co.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    const recurring = await post(
      { action: "add_recurring", counterpartyId: supplierId, category: "rent", amount: "1000", schedule: "monthly", scheduleDay: 1, startDate: day(-5) },
      co.cookie,
      co.id,
    );
    const recurringId = (recurring.body as { recurring: { id: string } }).recurring.id;
    const occurrenceDate = previewOccurrences(co.id, recurringId, defaultHorizonDate())[0].dueDate;

    const refused = await post(
      { action: "link_recurring_occurrence", id: recurringId, dueDate: occurrenceDate, payableId: strangerBillId },
      co.cookie,
      co.id,
    );
    expect(refused.status).toBe(404);
    expect(refused.body.error).toContain("does not belong to this company");

    // Nothing was written: no occurrence resolves for this schedule, and the
    // stranger's bill never entered this company's ledger.
    const occurrenceRows = db().prepare("SELECT COUNT(*) AS n FROM recurring_occurrence WHERE recurring_id = ?").get(recurringId) as { n: number };
    expect(occurrenceRows.n).toBe(0);
    expect(listPayables(co.id).every((p) => p.id !== strangerBillId)).toBe(true);
  });

  it("refuses a second link for an already-resolved date, counting the bill once, moving no cash", async () => {
    const co = await newCompany("m34-link-twice@example.com", "Link Twice Co");
    const supplier = await post({ action: "add_counterparty", name: "Twice Supplier", isSupplier: true }, co.cookie, co.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    const recurring = await post(
      { action: "add_recurring", counterpartyId: supplierId, category: "utilities", amount: "150", schedule: "monthly", scheduleDay: 20, startDate: day(-5) },
      co.cookie,
      co.id,
    );
    const recurringId = (recurring.body as { recurring: { id: string } }).recurring.id;
    const occurrenceDate = previewOccurrences(co.id, recurringId, defaultHorizonDate())[0].dueDate;

    const manual = await post({ action: "add_payable", counterpartyId: supplierId, amount: "150", dueDate: occurrenceDate }, co.cookie, co.id);
    const manualId = (manual.body as { payable: { id: string } }).payable.id;
    const linked = await post({ action: "link_recurring_occurrence", id: recurringId, dueDate: occurrenceDate, payableId: manualId }, co.cookie, co.id);
    expect(linked.status).toBe(200);
    const payablesAfterLink = listPayables(co.id);

    const again = await post({ action: "link_recurring_occurrence", id: recurringId, dueDate: occurrenceDate, payableId: manualId }, co.cookie, co.id);
    expect(again.status).toBe(409);
    expect(again.body.error).toContain(`${occurrenceDate} is already resolved for this schedule`);

    // Exactly one occurrence row, still pointing at the manual bill — the
    // refused second link added no duplicate obligation and no payment row.
    const occurrenceRows = db().prepare("SELECT COUNT(*) AS n FROM recurring_occurrence WHERE recurring_id = ? AND due_date = ?").get(recurringId, occurrenceDate) as {
      n: number;
    };
    expect(occurrenceRows.n).toBe(1);
    const row = db().prepare("SELECT payable_id, origin FROM recurring_occurrence WHERE recurring_id = ? AND due_date = ?").get(recurringId, occurrenceDate) as {
      payable_id: string;
      origin: string;
    };
    expect(row.origin).toBe("linked");
    expect(row.payable_id).toBe(manualId);
    expect(listPayables(co.id)).toEqual(payablesAfterLink);
    const paymentRows = db().prepare("SELECT COUNT(*) AS n FROM payment WHERE company_id = ?").get(co.id) as { n: number };
    expect(paymentRows.n).toBe(0);
  });
});

describe("editing and pausing preserve already-generated records", () => {
  it("does not change an already-generated payable when the schedule's amount changes", async () => {
    const co = await newCompany("m34-edit@example.com", "Edit Preserve Co");
    const supplier = await post({ action: "add_counterparty", name: "Changing Rate Supplier", isSupplier: true }, co.cookie, co.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    const recurring = await post(
      { action: "add_recurring", counterpartyId: supplierId, category: "utilities", amount: "400", schedule: "monthly", scheduleDay: 1, startDate: day(-40) },
      co.cookie,
      co.id,
    );
    const recurringId = (recurring.body as { recurring: { id: string } }).recurring.id;
    await post({ action: "generate_recurring_occurrences", id: recurringId }, co.cookie, co.id);
    const postedAmount = listPayables(co.id)[0].amountCents;
    expect(postedAmount).toBe(40_000);

    const updated = await post({ action: "update_recurring", id: recurringId, amount: "900" }, co.cookie, co.id);
    expect(updated.status).toBe(200);
    expect((updated.body as { recurring: { amountCents: number } }).recurring.amountCents).toBe(90_000);

    // The already-generated payable is untouched.
    expect(listPayables(co.id)[0].amountCents).toBe(postedAmount);
  });

  it("a paused schedule refuses further generation without touching past occurrences", async () => {
    const co = await newCompany("m34-pause@example.com", "Pause Co");
    const supplier = await post({ action: "add_counterparty", name: "Pausable Supplier", isSupplier: true }, co.cookie, co.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    const recurring = await post(
      { action: "add_recurring", counterpartyId: supplierId, category: "other", amount: "100", schedule: "monthly", scheduleDay: 1, startDate: day(-40) },
      co.cookie,
      co.id,
    );
    const recurringId = (recurring.body as { recurring: { id: string } }).recurring.id;
    await post({ action: "generate_recurring_occurrences", id: recurringId }, co.cookie, co.id);
    const countBeforePause = listPayables(co.id).length;
    expect(countBeforePause).toBeGreaterThan(0);

    const paused = await post({ action: "set_recurring_status", id: recurringId, status: "paused" }, co.cookie, co.id);
    expect(paused.status).toBe(200);

    const blocked = await post({ action: "generate_recurring_occurrences", id: recurringId }, co.cookie, co.id);
    expect(blocked.status).toBe(409);
    expect(listPayables(co.id)).toHaveLength(countBeforePause);
  });
});

describe("authorization and company scoping", () => {
  it("rejects a cross-company recurring action", async () => {
    const owner = await newCompany("m34-cross-a@example.com", "Recurring Cross A");
    const other = await newCompany("m34-cross-b@example.com", "Recurring Cross B");
    const supplier = await post({ action: "add_counterparty", name: "A Supplier", isSupplier: true }, owner.cookie, owner.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    const recurring = await post(
      { action: "add_recurring", counterpartyId: supplierId, category: "rent", amount: "100", schedule: "monthly", scheduleDay: 1, startDate: day(-5) },
      owner.cookie,
      owner.id,
    );
    const recurringId = (recurring.body as { recurring: { id: string } }).recurring.id;

    const forged = await post({ action: "generate_recurring_occurrences", id: recurringId }, other.cookie, owner.id);
    expect(forged.status).toBe(403);

    const wrongId = await post({ action: "generate_recurring_occurrences", id: recurringId }, other.cookie, other.id);
    expect(wrongId.status).toBe(404);
  });

  it("rejects a VIEWER creating or generating a schedule", async () => {
    const owner = await newCompany("m34-viewer-owner@example.com", "Recurring Viewer Gate");
    const viewerCookie = await signUp("m34-viewer@example.com");
    const userId = (db().prepare("SELECT id FROM user WHERE email = ?").get("m34-viewer@example.com") as { id: string }).id;
    db()
      .prepare("INSERT INTO membership (user_id, business_id, role, created_at, created_by) VALUES (?, ?, 'VIEWER', ?, 'test')")
      .run(userId, owner.id, Date.now());

    const supplier = await post({ action: "add_counterparty", name: "Gated Supplier", isSupplier: true }, owner.cookie, owner.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    const result = await post(
      { action: "add_recurring", counterpartyId: supplierId, category: "rent", amount: "100", schedule: "monthly", scheduleDay: 1, startDate: day(-5) },
      viewerCookie,
      owner.id,
    );
    expect(result.status).toBe(403);
  });

  it("rejects a VIEWER linking an occurrence", async () => {
    const owner = await newCompany("m34-link-viewer-owner@example.com", "Link Viewer Owner Co");
    const viewerCookie = await signUp("m34-link-viewer2@example.com");
    const userId = (db().prepare("SELECT id FROM user WHERE email = ?").get("m34-link-viewer2@example.com") as { id: string }).id;
    db()
      .prepare("INSERT INTO membership (user_id, business_id, role, created_at, created_by) VALUES (?, ?, 'VIEWER', ?, 'test')")
      .run(userId, owner.id, Date.now());

    const supplier = await post({ action: "add_counterparty", name: "Link Gate Supplier", isSupplier: true }, owner.cookie, owner.id);
    const supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
    const recurring = await post(
      { action: "add_recurring", counterpartyId: supplierId, category: "rent", amount: "100", schedule: "monthly", scheduleDay: 1, startDate: day(-5) },
      owner.cookie,
      owner.id,
    );
    const recurringId = (recurring.body as { recurring: { id: string } }).recurring.id;
    const occurrenceDate = previewOccurrences(owner.id, recurringId, defaultHorizonDate())[0].dueDate;
    const bill = await post({ action: "add_payable", counterpartyId: supplierId, amount: "100", dueDate: occurrenceDate }, owner.cookie, owner.id);
    const billId = (bill.body as { payable: { id: string } }).payable.id;

    const refused = await post(
      { action: "link_recurring_occurrence", id: recurringId, dueDate: occurrenceDate, payableId: billId },
      viewerCookie,
      owner.id,
    );
    expect(refused.status).toBe(403);
  });
});
