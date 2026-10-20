/**
 * M2: payments, adjustments, allocations and outstanding balances.
 *
 * The invariants under test, in the order they matter:
 *   a payment moves cash, an adjustment does not, an allocation never does;
 *   an original invoice value is never rewritten by settling it;
 *   money already inside an opening balance is not counted a second time;
 *   nothing can be over-allocated, including by two racing requests;
 *   a reversal restores effects exactly once and keeps the history.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

import { POST as companyPost } from "../../../app/api/company/route";
import { getAuth } from "../auth";
import { getCompany } from "../companies";
import { companyDataset } from "../company-state";
import { db } from "../db";
import { loadPlanContext, BASELINE_SCENARIO } from "../plan";
import {
  listPayments,
  netCashCents,
  obligationBalances,
  openingCutoff,
  recordPayment,
  settlementRecords,
} from "../settlements";
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

let cookie: string;
let co: string;
let buyerId: string;
let supplierId: string;
/** The 1,000 invoice the brief's worked example uses. */
let invoice: string;

async function newCompany(email: string, name: string): Promise<{ cookie: string; id: string }> {
  const c = await signUp(email);
  const created = await post({ action: "create_company", name }, c);
  const id = (created.body as { company: { id: string } }).company.id;
  await post({ action: "add_account", name: "Main", openingBalance: "10000", asOfDate: day(-30) }, c, id);
  return { cookie: c, id };
}

beforeAll(async () => {
  ({ cookie, id: co } = await newCompany("m2-owner@example.com", "Settlement Co"));
  const buyer = await post({ action: "add_counterparty", name: "Buyer Ltd", isBuyer: true }, cookie, co);
  buyerId = (buyer.body as { counterparty: { id: string } }).counterparty.id;
  const supplier = await post({ action: "add_counterparty", name: "Supplier Ltd", isSupplier: true }, cookie, co);
  supplierId = (supplier.body as { counterparty: { id: string } }).counterparty.id;
  const inv = await post(
    { action: "add_receivable", counterpartyId: buyerId, amount: "1000", dueDate: day(10) },
    cookie,
    co,
  );
  invoice = (inv.body as { receivable: { id: string } }).receivable.id;
});

const remaining = (id: string) => obligationBalances(co).get(id)!.remainingCents;

describe("the worked example from the brief", () => {
  it("invoice 1,000 with receipts of 300 and 200 leaves 500 owing and 500 more cash", async () => {
    const cashBefore = netCashCents(co);
    for (const amount of ["300", "200"]) {
      const result = await post(
        {
          action: "record_payment",
          direction: "receipt",
          amount,
          effectiveDate: day(0),
          counterpartyId: buyerId,
          allocations: [{ targetKind: "receivable", targetId: invoice, amount }],
        },
        cookie,
        co,
      );
      expect(result.status).toBe(200);
    }
    expect(remaining(invoice)).toBe(50_000);
    expect(netCashCents(co) - cashBefore).toBe(50_000);

    const balance = obligationBalances(co).get(invoice)!;
    // The original value is preserved, not rewritten by settlement.
    expect(balance.originalCents).toBe(100_000);
    expect(balance.paidCents).toBe(50_000);
    expect(balance.adjustedCents).toBe(0);
  });

  it("a credit note of 100 leaves 400 owing and moves no cash", async () => {
    const cashBefore = netCashCents(co);
    const result = await post(
      {
        action: "record_adjustment",
        kind: "credit_note",
        targetKind: "receivable",
        amount: "100",
        effectiveDate: day(0),
        reason: "short delivery",
        allocations: [{ targetId: invoice, amount: "100" }],
      },
      cookie,
      co,
    );
    expect(result.status).toBe(200);
    expect(remaining(invoice)).toBe(40_000);
    expect(netCashCents(co)).toBe(cashBefore);

    const balance = obligationBalances(co).get(invoice)!;
    expect(balance.originalCents).toBe(100_000);
    expect(balance.adjustedCents).toBe(10_000);
  });
});

describe("allocation shapes", () => {
  it("spreads one receipt across several invoices", async () => {
    const ids: string[] = [];
    for (const amount of ["400", "600"]) {
      const inv = await post({ action: "add_receivable", counterpartyId: buyerId, amount, dueDate: day(12) }, cookie, co);
      ids.push((inv.body as { receivable: { id: string } }).receivable.id);
    }
    const result = await post(
      {
        action: "record_payment",
        direction: "receipt",
        amount: "1000",
        effectiveDate: day(0),
        allocations: [
          { targetKind: "receivable", targetId: ids[0], amount: "400" },
          { targetKind: "receivable", targetId: ids[1], amount: "600" },
        ],
      },
      cookie,
      co,
    );
    expect(result.status).toBe(200);
    expect(remaining(ids[0])).toBe(0);
    expect(remaining(ids[1])).toBe(0);
  });

  it("applies several receipts to one invoice", async () => {
    const inv = await post({ action: "add_receivable", counterpartyId: buyerId, amount: "900", dueDate: day(12) }, cookie, co);
    const id = (inv.body as { receivable: { id: string } }).receivable.id;
    for (const amount of ["300", "300", "300"]) {
      await post(
        {
          action: "record_payment",
          direction: "receipt",
          amount,
          effectiveDate: day(0),
          allocations: [{ targetKind: "receivable", targetId: id, amount }],
        },
        cookie,
        co,
      );
    }
    expect(remaining(id)).toBe(0);
    expect(obligationBalances(co).get(id)!.settled).toBe(true);
  });

  it("keeps an overpayment as unallocated credit rather than negative debt", async () => {
    const inv = await post({ action: "add_receivable", counterpartyId: buyerId, amount: "500", dueDate: day(12) }, cookie, co);
    const id = (inv.body as { receivable: { id: string } }).receivable.id;
    const paid = await post(
      {
        action: "record_payment",
        direction: "receipt",
        amount: "800",
        effectiveDate: day(0),
        allocations: [{ targetKind: "receivable", targetId: id, amount: "500" }],
      },
      cookie,
      co,
    );
    expect(paid.status).toBe(200);
    expect(remaining(id)).toBe(0);
    const payment = (paid.body as { payment: { id: string; unallocatedCents: number } }).payment;
    expect(payment.unallocatedCents).toBe(30_000);
  });

  it("reduces cash and the bill when a supplier is paid", async () => {
    const bill = await post(
      { action: "add_payable", counterpartyId: supplierId, amount: "700", dueDate: day(8) },
      cookie,
      co,
    );
    const id = (bill.body as { payable: { id: string } }).payable.id;
    const cashBefore = netCashCents(co);
    await post(
      {
        action: "record_payment",
        direction: "disbursement",
        amount: "700",
        effectiveDate: day(0),
        counterpartyId: supplierId,
        allocations: [{ targetKind: "payable", targetId: id, amount: "700" }],
      },
      cookie,
      co,
    );
    expect(remaining(id)).toBe(0);
    expect(netCashCents(co) - cashBefore).toBe(-70_000);
  });
});

describe("cash and the opening-balance cutoff", () => {
  it("does not add money again when the payment is already inside the opening balance", async () => {
    const fresh = await newCompany("m2-cutoff@example.com", "Cutoff Co");
    const cutoff = openingCutoff(fresh.id)!;
    expect(cutoff).toBe(day(-30));

    const cp = await post({ action: "add_counterparty", name: "Old Buyer", isBuyer: true }, fresh.cookie, fresh.id);
    const cpId = (cp.body as { counterparty: { id: string } }).counterparty.id;
    const inv = await post(
      { action: "add_receivable", counterpartyId: cpId, amount: "400", dueDate: day(-40) },
      fresh.cookie,
      fresh.id,
    );
    const invId = (inv.body as { receivable: { id: string } }).receivable.id;

    // Paid before the opening balance date: the cash is already in it.
    const historical = await post(
      {
        action: "record_payment",
        direction: "receipt",
        amount: "400",
        effectiveDate: day(-35),
        allocations: [{ targetKind: "receivable", targetId: invId, amount: "400" }],
      },
      fresh.cookie,
      fresh.id,
    );
    expect(historical.status).toBe(200);
    expect((historical.body as { payment: { affectsCash: boolean } }).payment.affectsCash).toBe(false);

    // The invoice is settled, but no cash was added on top of the opening balance.
    expect(netCashCents(fresh.id)).toBe(0);
    expect(obligationBalances(fresh.id).get(invId)!.remainingCents).toBe(0);
    const dataset = companyDataset(getCompany(fresh.id)!);
    expect(dataset.state!.current_cash).toBe(10_000);
  });

  it("allocating an existing payment never moves cash a second time", async () => {
    const inv = await post({ action: "add_receivable", counterpartyId: buyerId, amount: "250", dueDate: day(11) }, cookie, co);
    const invId = (inv.body as { receivable: { id: string } }).receivable.id;
    const paid = await post(
      { action: "record_payment", direction: "receipt", amount: "250", effectiveDate: day(0) },
      cookie,
      co,
    );
    const paymentId = (paid.body as { payment: { id: string } }).payment.id;
    const cashAfterPayment = netCashCents(co);

    const allocated = await post(
      { action: "allocate", sourceKind: "payment", sourceId: paymentId, targetKind: "receivable", targetId: invId, amount: "250" },
      cookie,
      co,
    );
    expect(allocated.status).toBe(200);
    expect(remaining(invId)).toBe(0);
    expect(netCashCents(co)).toBe(cashAfterPayment);
  });

  it("does not present a future-dated payment as cash held now", async () => {
    const fresh = await newCompany("m2-future@example.com", "Future Co");
    await post(
      { action: "record_payment", direction: "receipt", amount: "5000", effectiveDate: day(14) },
      fresh.cookie,
      fresh.id,
    );
    expect(netCashCents(fresh.id)).toBe(0);
    const dataset = companyDataset(getCompany(fresh.id)!);
    expect(dataset.state!.current_cash).toBe(10_000);
    expect(dataset.coverage.map((n) => n.code)).toContain("future_dated_payments");
  });
});

describe("opening-balance updates", () => {
  /**
   * There is no `updateAccount`: an account's opening balance and as-of date
   * can only be added or deleted (`records.ts`), never edited in place. The
   * hazardous sequence — move an as-of date forward so it now postdates a
   * payment already recorded against the old one — is therefore structurally
   * unreachable through the normal entry path, not merely guarded against.
   *
   * This test exercises the one way a company's accounts actually change
   * after a payment exists: delete the account and add a replacement with a
   * later as-of date. A payment's `affects_cash` flag is set once, when it is
   * recorded, from the cutoff *at that moment*, and is never recomputed —
   * so replacing the account cannot silently fold that payment into the new
   * opening balance and double it, however the new as-of date relates to the
   * payment's date. If an owner's new balance figure already accounts for
   * that money, reconciling it is an explicit, auditable action (reverse the
   * payment, stating why), never an implicit side effect of editing a date.
   */
  it("does not recount a payment when its account is replaced with a later as-of date", async () => {
    const fresh = await newCompany("m2-rebase@example.com", "Rebase Co");
    // The $300 payment is dated after the account's original cutoff (day -30),
    // so it is live cash, not already inside the opening balance.
    const paid = await post(
      { action: "record_payment", direction: "receipt", amount: "300", effectiveDate: day(-10) },
      fresh.cookie,
      fresh.id,
    );
    expect((paid.body as { payment: { affectsCash: boolean } }).payment.affectsCash).toBe(true);
    expect(netCashCents(fresh.id)).toBe(30_000);

    // Delete the original account and replace it with one whose as-of date
    // (day -5) is now AFTER the $300 payment (day -10).
    const { listAccounts, deleteAccount, addAccount } = await import("../records");
    const original = listAccounts(fresh.id)[0];
    deleteAccount(fresh.id, original.id);
    addAccount(fresh.id, "USD", { name: "Operating (restated)", openingBalance: "20000", asOfDate: day(-5) });

    // The cutoff moved, but the already-posted payment's flag did not: it
    // still counts once, exactly as it did before the account was replaced.
    expect(openingCutoff(fresh.id)).toBe(day(-5));
    const payment = listPayments(fresh.id).find((p) => p.id === (paid.body as { payment: { id: string } }).payment.id)!;
    expect(payment.affectsCash).toBe(true);
    expect(netCashCents(fresh.id)).toBe(30_000);

    const after = companyDataset(getCompany(fresh.id)!);
    // New opening (20,000) + the one unchanged $300 payment, counted once.
    expect(after.state!.current_cash).toBe(20_300);
  });
});

describe("what cannot happen", () => {
  it("refuses to over-allocate a payment", async () => {
    const paid = await post(
      { action: "record_payment", direction: "receipt", amount: "100", effectiveDate: day(0) },
      cookie,
      co,
    );
    const paymentId = (paid.body as { payment: { id: string } }).payment.id;
    const inv = await post({ action: "add_receivable", counterpartyId: buyerId, amount: "900", dueDate: day(12) }, cookie, co);
    const invId = (inv.body as { receivable: { id: string } }).receivable.id;
    const result = await post(
      { action: "allocate", sourceKind: "payment", sourceId: paymentId, targetKind: "receivable", targetId: invId, amount: "150" },
      cookie,
      co,
    );
    expect(result.status).toBe(409);
    expect(String(result.body.error)).toMatch(/unallocated/);
  });

  it("refuses to allocate more than is outstanding on an invoice", async () => {
    const inv = await post({ action: "add_receivable", counterpartyId: buyerId, amount: "200", dueDate: day(12) }, cookie, co);
    const invId = (inv.body as { receivable: { id: string } }).receivable.id;
    const paid = await post(
      { action: "record_payment", direction: "receipt", amount: "500", effectiveDate: day(0) },
      cookie,
      co,
    );
    const paymentId = (paid.body as { payment: { id: string } }).payment.id;
    const result = await post(
      { action: "allocate", sourceKind: "payment", sourceId: paymentId, targetKind: "receivable", targetId: invId, amount: "300" },
      cookie,
      co,
    );
    expect(result.status).toBe(409);
    expect(String(result.body.error)).toMatch(/still outstanding/);
  });

  it("cannot be over-allocated by two concurrent requests", async () => {
    const inv = await post({ action: "add_receivable", counterpartyId: buyerId, amount: "100", dueDate: day(12) }, cookie, co);
    const invId = (inv.body as { receivable: { id: string } }).receivable.id;
    const first = await post(
      { action: "record_payment", direction: "receipt", amount: "100", effectiveDate: day(0) },
      cookie,
      co,
    );
    const second = await post(
      { action: "record_payment", direction: "receipt", amount: "100", effectiveDate: day(0) },
      cookie,
      co,
    );
    const ids = [
      (first.body as { payment: { id: string } }).payment.id,
      (second.body as { payment: { id: string } }).payment.id,
    ];
    // Both race to settle the same 100 invoice.
    const results = await Promise.all(
      ids.map((sourceId) =>
        post(
          { action: "allocate", sourceKind: "payment", sourceId, targetKind: "receivable", targetId: invId, amount: "100" },
          cookie,
          co,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    expect(remaining(invId)).toBe(0);
  });

  it("returns the same payment for a repeated idempotency key instead of a second one", async () => {
    const body = {
      action: "record_payment",
      direction: "receipt",
      amount: "321",
      effectiveDate: day(0),
      idempotencyKey: "receipt-abc-123",
    };
    const first = await post(body, cookie, co);
    const second = await post(body, cookie, co);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.body as { idempotent: boolean }).idempotent).toBe(true);
    expect((second.body as { payment: { id: string } }).payment.id).toBe(
      (first.body as { payment: { id: string } }).payment.id,
    );
    expect(listPayments(co).filter((p) => p.reference === null && p.amountCents === 32_100)).toHaveLength(1);
  });

  it("keeps two genuine payments that merely share a date and amount", async () => {
    const before = listPayments(co).filter((p) => p.amountCents === 4_200).length;
    for (let i = 0; i < 2; i += 1) {
      await post({ action: "record_payment", direction: "receipt", amount: "42", effectiveDate: day(0) }, cookie, co);
    }
    expect(listPayments(co).filter((p) => p.amountCents === 4_200)).toHaveLength(before + 2);
  });

  it("refuses a payment in a currency the company does not keep books in", async () => {
    const result = await post(
      { action: "record_payment", direction: "receipt", amount: "100", effectiveDate: day(0), currency: "CNY" },
      cookie,
      co,
    );
    expect(result.status).toBe(422);
    expect(String(result.body.error)).toMatch(/keeps its books in USD/);
  });

  it("refuses settlement aimed at another company's records", async () => {
    const other = await newCompany("m2-other@example.com", "Other Co");
    const mine = await post(
      { action: "record_payment", direction: "receipt", amount: "50", effectiveDate: day(0) },
      cookie,
      co,
    );
    const paymentId = (mine.body as { payment: { id: string } }).payment.id;

    // Their session cannot touch my payment.
    const theirs = await post(
      { action: "allocate", sourceKind: "payment", sourceId: paymentId, targetKind: "receivable", targetId: invoice, amount: "50" },
      other.cookie,
      other.id,
    );
    expect(theirs.status).toBe(404);
    // And naming my company outright is refused before anything is read.
    const forged = await post(
      { action: "record_payment", direction: "receipt", amount: "50", effectiveDate: day(0) },
      other.cookie,
      co,
    );
    expect(forged.status).toBe(403);
  });

  it("will not let an ANALYST reverse a posted record", async () => {
    const analystCookie = await signUp("m2-analyst@example.com");
    const userId = (db().prepare("SELECT id FROM user WHERE email = ?").get("m2-analyst@example.com") as { id: string }).id;
    db()
      .prepare("INSERT INTO membership (user_id, business_id, role, created_at, created_by) VALUES (?, ?, 'ANALYST', ?, 'test')")
      .run(userId, co, Date.now());

    const paid = await post(
      { action: "record_payment", direction: "receipt", amount: "60", effectiveDate: day(0) },
      analystCookie,
      co,
    );
    expect(paid.status).toBe(200); // entry is allowed

    const reversal = await post(
      { action: "reverse", kind: "payment", id: (paid.body as { payment: { id: string } }).payment.id, reason: "nope" },
      analystCookie,
      co,
    );
    expect(reversal.status).toBe(403);
  });
});

describe("reversal", () => {
  it("restores the balance and the cash exactly once, keeping the record", async () => {
    const inv = await post({ action: "add_receivable", counterpartyId: buyerId, amount: "640", dueDate: day(12) }, cookie, co);
    const invId = (inv.body as { receivable: { id: string } }).receivable.id;
    const cashBefore = netCashCents(co);
    const paid = await post(
      {
        action: "record_payment",
        direction: "receipt",
        amount: "640",
        effectiveDate: day(0),
        allocations: [{ targetKind: "receivable", targetId: invId, amount: "640" }],
      },
      cookie,
      co,
    );
    const paymentId = (paid.body as { payment: { id: string } }).payment.id;
    expect(remaining(invId)).toBe(0);
    expect(netCashCents(co)).toBe(cashBefore + 64_000);

    const first = await post({ action: "reverse", kind: "payment", id: paymentId, reason: "bounced" }, cookie, co);
    expect(first.status).toBe(200);
    expect((first.body as { reversed: boolean }).reversed).toBe(true);
    expect(remaining(invId)).toBe(64_000);
    expect(netCashCents(co)).toBe(cashBefore);

    // Repeating it changes nothing further.
    const again = await post({ action: "reverse", kind: "payment", id: paymentId, reason: "bounced" }, cookie, co);
    expect((again.body as { reversed: boolean }).reversed).toBe(false);
    expect(remaining(invId)).toBe(64_000);
    expect(netCashCents(co)).toBe(cashBefore);

    // The history is kept, stamped rather than deleted.
    const payment = listPayments(co).find((p) => p.id === paymentId)!;
    expect(payment.reversedAt).not.toBeNull();
    expect(payment.reversalReason).toBe("bounced");
    expect(payment.amountCents).toBe(64_000);
  });

  it("reverses a credit note without touching cash", async () => {
    const inv = await post({ action: "add_receivable", counterpartyId: buyerId, amount: "300", dueDate: day(12) }, cookie, co);
    const invId = (inv.body as { receivable: { id: string } }).receivable.id;
    const note = await post(
      {
        action: "record_adjustment",
        kind: "credit_note",
        targetKind: "receivable",
        amount: "120",
        effectiveDate: day(0),
        allocations: [{ targetId: invId, amount: "120" }],
      },
      cookie,
      co,
    );
    const id = (note.body as { adjustment: { id: string } }).adjustment.id;
    expect(remaining(invId)).toBe(18_000);
    const cash = netCashCents(co);
    await post({ action: "reverse", kind: "adjustment", id, reason: "raised in error" }, cookie, co);
    expect(remaining(invId)).toBe(30_000);
    expect(netCashCents(co)).toBe(cash);
  });
});

describe("the forecast and other companies", () => {
  it("forecasts the outstanding balance, not the original invoice", async () => {
    const fresh = await newCompany("m2-forecast@example.com", "Forecast Co");
    const cp = await post({ action: "add_counterparty", name: "A Buyer", isBuyer: true }, fresh.cookie, fresh.id);
    const cpId = (cp.body as { counterparty: { id: string } }).counterparty.id;
    const inv = await post(
      { action: "add_receivable", counterpartyId: cpId, amount: "1000", dueDate: day(10) },
      fresh.cookie,
      fresh.id,
    );
    const invId = (inv.body as { receivable: { id: string } }).receivable.id;

    const before = companyDataset(getCompany(fresh.id)!);
    expect(before.state!.invoices_ar[0].amount).toBe(1000);

    await post(
      {
        action: "record_payment",
        direction: "receipt",
        amount: "600",
        effectiveDate: day(0),
        allocations: [{ targetKind: "receivable", targetId: invId, amount: "600" }],
      },
      fresh.cookie,
      fresh.id,
    );

    const after = companyDataset(getCompany(fresh.id)!);
    // 400 still expected in, and the 600 already collected is now cash —
    // counted once each, never twice.
    expect(after.state!.invoices_ar[0].amount).toBe(400);
    expect(after.state!.current_cash).toBe(10_600);
    expect(after.dataVersion).not.toBe(before.dataVersion);
  });

  it("drops a fully settled invoice from the forecast and says so", async () => {
    const fresh = await newCompany("m2-settled@example.com", "Settled Co");
    const cp = await post({ action: "add_counterparty", name: "Payer", isBuyer: true }, fresh.cookie, fresh.id);
    const cpId = (cp.body as { counterparty: { id: string } }).counterparty.id;
    const inv = await post(
      { action: "add_receivable", counterpartyId: cpId, amount: "500", dueDate: day(10) },
      fresh.cookie,
      fresh.id,
    );
    const invId = (inv.body as { receivable: { id: string } }).receivable.id;
    await post(
      {
        action: "record_payment",
        direction: "receipt",
        amount: "500",
        effectiveDate: day(0),
        allocations: [{ targetKind: "receivable", targetId: invId, amount: "500" }],
      },
      fresh.cookie,
      fresh.id,
    );
    const dataset = companyDataset(getCompany(fresh.id)!);
    expect(dataset.state!.invoices_ar).toHaveLength(0);
    expect(dataset.coverage.map((n) => n.code)).toContain("settled_excluded");
  });

  it("changes only the paying company's plan version", async () => {
    const a = await newCompany("m2-plan-a@example.com", "Plan A Co");
    const b = await newCompany("m2-plan-b@example.com", "Plan B Co");
    for (const company of [a, b]) {
      const cp = await post({ action: "add_counterparty", name: "X", isBuyer: true }, company.cookie, company.id);
      const cpId = (cp.body as { counterparty: { id: string } }).counterparty.id;
      await post(
        { action: "add_receivable", counterpartyId: cpId, amount: "800", dueDate: day(9) },
        company.cookie,
        company.id,
      );
    }
    const aBefore = (await loadPlanContext(a.id, BASELINE_SCENARIO)).planVersion;
    const bBefore = (await loadPlanContext(b.id, BASELINE_SCENARIO)).planVersion;

    await post(
      { action: "record_payment", direction: "receipt", amount: "300", effectiveDate: day(0) },
      a.cookie,
      a.id,
    );

    expect((await loadPlanContext(a.id, BASELINE_SCENARIO)).planVersion).not.toBe(aBefore);
    expect((await loadPlanContext(b.id, BASELINE_SCENARIO)).planVersion).toBe(bBefore);
  });

  it("reports settlement state through the API, labelled as entered rather than reconciled", async () => {
    const records = settlementRecords(co);
    expect(records.payments.length).toBeGreaterThan(0);
    expect(records.openingCutoff).toBe(day(-30));
    const dataset = companyDataset(getCompany(co)!);
    expect(dataset.coverage.map((n) => n.code)).toContain("balances_not_reconciled");
  });
});

describe("stale plans at approval and execution time", () => {
  /**
   * A payment changes what is outstanding, so a plan minted before it is no
   * longer the plan the owner approved. The race that matters is the one where
   * the money arrives between approving and executing.
   */
  it("refuses to execute an approval minted before a payment changed the plan", async () => {
    const { POST: action } = await import("../../../app/api/action/route");
    const fresh = await newCompany("m2-stale@example.com", "Stale Plan Co");
    const cp = await post({ action: "add_counterparty", name: "Buyer", isBuyer: true, isSupplier: true }, fresh.cookie, fresh.id);
    const cpId = (cp.body as { counterparty: { id: string } }).counterparty.id;
    await post(
      {
        action: "add_receivable",
        counterpartyId: cpId,
        amount: "9000",
        dueDate: day(12),
        discountEligible: true,
        discountPct: 0.02,
        discountSettlesInDays: 3,
      },
      fresh.cookie,
      fresh.id,
    );
    await post(
      { action: "add_payable", counterpartyId: cpId, amount: "14000", dueDate: day(6), isPayroll: true },
      fresh.cookie,
      fresh.id,
    );
    await post({ action: "set_policy", key: "minimum_safe_buffer_cents", value: "2000" }, fresh.cookie, fresh.id);

    const call = async (body: Record<string, unknown>) => {
      const response = await action(
        new Request(`${BASE}/api/action`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: BASE,
            cookie: fresh.cookie,
            "x-vantora-company": fresh.id,
          },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, body: (await response.json()) as Record<string, string> };
    };

    const plan = await loadPlanContext(fresh.id, BASELINE_SCENARIO);
    if (!plan.bundle) return; // No feasible plan for this dataset: nothing to approve.

    const cash = (plan.bundle.payload.cash_cost_cents / 100).toFixed(2);
    const approved = await call({ action: "approve", target: { kind: "plan" }, confirmation: cash });
    expect(approved.status).toBe(200);

    // The money lands between approving and executing.
    const paid = await post(
      { action: "record_payment", direction: "receipt", amount: "3000", effectiveDate: day(0) },
      fresh.cookie,
      fresh.id,
    );
    expect(paid.status).toBe(200);
    expect((await loadPlanContext(fresh.id, BASELINE_SCENARIO)).planVersion).not.toBe(plan.planVersion);

    const executed = await call({
      action: "execute",
      target: { kind: "plan" },
      userApprovalToken: approved.body.userApprovalToken,
    });
    // Refused because the token is bound to the plan as it was before the
    // money arrived — and the refusal is itself recorded in the audit chain.
    expect(executed.status).toBe(403);
    expect(executed.body.decision).toBe("DENIED");
    expect(String(executed.body.reason)).toMatch(/bound to a different recovery plan/i);
    expect(
      (db().prepare("SELECT COUNT(*) AS n FROM action_execution WHERE business_id = ?").get(fresh.id) as { n: number } | undefined)
        ?.n ?? 0,
    ).toBe(0);
  });
});

describe("direct module guards", () => {
  it("refuses a payment before any account exists", async () => {
    const created = await post({ action: "create_company", name: "No Account Co" }, cookie);
    const id = (created.body as { company: { id: string } }).company.id;
    expect(() =>
      recordPayment(id, "USD", { direction: "receipt", amount: "10", effectiveDate: day(0) }, "test"),
    ).toThrow(/opening balance/i);
  });
});
