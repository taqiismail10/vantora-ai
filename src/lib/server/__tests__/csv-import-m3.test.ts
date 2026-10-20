/**
 * M3.3: CSV import for receivables and payables.
 *
 * What this pins:
 *   a valid import reaches the next forecast;
 *   an invalid row blocks the whole confirm, writing nothing;
 *   reimporting the same file, even reordered, creates no duplicates;
 *   a conflicting duplicate is never silently overwritten;
 *   a counterparty from another company never matches;
 *   preview and a duplicate-only confirm never change financial state or
 *     plan version; a real import invalidates only that company's plan;
 *   quoted fields and Unicode counterparty names parse correctly.
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
import { listPayables, listReceivables } from "../records";
import { parseCsv, validateImportRows } from "../csv-import";
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

const RECEIVABLE_MAPPING = {
  counterpartyName: "counterparty_name",
  amount: "amount",
  dueDate: "due_date",
  externalId: "reference",
  issueDate: "issue_date",
};

const PAYABLE_MAPPING = {
  counterpartyName: "counterparty_name",
  amount: "amount",
  dueDate: "due_date",
  externalId: "reference",
};

describe("parseCsv", () => {
  it("handles quoted fields with embedded commas and escaped quotes", () => {
    const rows = parseCsv('a,b,c\n"Smith, Jones & Co","He said ""hi""",3\n');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["Smith, Jones & Co", 'He said "hi"', "3"],
    ]);
  });

  it("keeps Unicode counterparty names intact", () => {
    const rows = parseCsv("name,amount\nকৃষি পণ্য লিমিটেড,500\n上海工厂,300\n");
    expect(rows[1][0]).toBe("কৃষি পণ্য লিমিটেড");
    expect(rows[2][0]).toBe("上海工厂");
  });
});

describe("a valid import reaches the forecast", () => {
  it("imports receivables and they appear in the next plan", async () => {
    const co = await newCompany("m3c-receivable@example.com", "Import Receivable Co");
    await post({ action: "add_counterparty", name: "Imported Buyer", isBuyer: true }, co.cookie, co.id);

    const csvText = `counterparty_name,amount,due_date,reference,issue_date\n"Imported Buyer",1000.00,${day(10)},INV-9001,${day(1)}\n`;
    const confirmed = await post(
      { action: "csv_import_confirm", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING },
      co.cookie,
      co.id,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.created).toBe(1);

    const plan = await loadPlanContext(co.id, BASELINE_SCENARIO);
    expect(plan.ctx.state.invoices_ar.some((i) => i.amount === 1000)).toBe(true);
    const stored = listReceivables(co.id)[0];
    expect(stored.source).toBe("csv_import");
  });

  it("imports payables and they appear in the next plan", async () => {
    const co = await newCompany("m3c-payable@example.com", "Import Payable Co");
    await post({ action: "add_counterparty", name: "Imported Supplier", isSupplier: true }, co.cookie, co.id);

    const csvText = `counterparty_name,amount,due_date,reference\n"Imported Supplier",500.00,${day(10)},BILL-9001\n`;
    const confirmed = await post(
      { action: "csv_import_confirm", kind: "payable", csvText, mapping: PAYABLE_MAPPING },
      co.cookie,
      co.id,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.created).toBe(1);

    const plan = await loadPlanContext(co.id, BASELINE_SCENARIO);
    expect(plan.ctx.state.payables_ap.some((p) => p.amount === 500)).toBe(true);
    expect(listPayables(co.id)[0].source).toBe("csv_import");
  });
});

describe("invalid rows", () => {
  it("blocks the whole confirm and writes nothing", async () => {
    const co = await newCompany("m3c-invalid@example.com", "Import Invalid Co");
    await post({ action: "add_counterparty", name: "Valid Buyer", isBuyer: true }, co.cookie, co.id);

    const csvText =
      `counterparty_name,amount,due_date,reference\n` +
      `"Valid Buyer",1000.00,${day(10)},INV-OK\n` +
      `"Valid Buyer",not-a-number,${day(10)},INV-BAD\n`;

    const preview = await post(
      { action: "csv_import_preview", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING },
      co.cookie,
      co.id,
    );
    expect(preview.status).toBe(200);
    expect((preview.body as { counts: { error: number } }).counts.error).toBe(1);

    const confirmed = await post(
      { action: "csv_import_confirm", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING },
      co.cookie,
      co.id,
    );
    expect(confirmed.status).toBe(422);
    expect(listReceivables(co.id)).toHaveLength(0); // the good row was not written either
  });

  it("flags a missing counterparty without creating one", async () => {
    const co = await newCompany("m3c-missing-cp@example.com", "Import Missing CP Co");
    const csvText = `counterparty_name,amount,due_date,reference\n"Nobody Here",1000.00,${day(10)},INV-X\n`;
    const preview = await post(
      { action: "csv_import_preview", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING },
      co.cookie,
      co.id,
    );
    const row = (preview.body as { rows: { status: string; errors: string[] }[] }).rows[0];
    expect(row.status).toBe("error");
    expect(row.errors[0]).toMatch(/no buyer named/);

    const { listCounterparties } = await import("../records");
    expect(listCounterparties(co.id)).toHaveLength(0);
  });
});

describe("reimporting, including reordered rows", () => {
  it("creates no duplicates the second time", async () => {
    const co = await newCompany("m3c-reimport@example.com", "Reimport Co");
    await post({ action: "add_counterparty", name: "Repeat Buyer", isBuyer: true }, co.cookie, co.id);
    const row1 = `"Repeat Buyer",1000.00,${day(10)},INV-A`;
    const row2 = `"Repeat Buyer",2000.00,${day(12)},INV-B`;
    const header = "counterparty_name,amount,due_date,reference";

    const first = await post(
      { action: "csv_import_confirm", kind: "receivable", csvText: `${header}\n${row1}\n${row2}\n`, mapping: RECEIVABLE_MAPPING },
      co.cookie,
      co.id,
    );
    expect(first.body.created).toBe(2);

    // Same data, rows reordered.
    const second = await post(
      { action: "csv_import_confirm", kind: "receivable", csvText: `${header}\n${row2}\n${row1}\n`, mapping: RECEIVABLE_MAPPING },
      co.cookie,
      co.id,
    );
    expect(second.body.created).toBe(0);
    expect(second.body.skippedIdentical).toBe(2);
    expect(listReceivables(co.id)).toHaveLength(2);
  });

  it("flags a within-file repeated reference as an error", async () => {
    const co = await newCompany("m3c-infile-dupe@example.com", "In-file Dupe Co");
    await post({ action: "add_counterparty", name: "Dup Buyer", isBuyer: true }, co.cookie, co.id);
    const csvText =
      `counterparty_name,amount,due_date,reference\n` +
      `"Dup Buyer",100.00,${day(10)},INV-SAME\n` +
      `"Dup Buyer",200.00,${day(11)},INV-SAME\n`;
    const preview = await post(
      { action: "csv_import_preview", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING },
      co.cookie,
      co.id,
    );
    const rows = (preview.body as { rows: { status: string; errors: string[] }[] }).rows;
    expect(rows[1].status).toBe("error");
    expect(rows[1].errors[0]).toMatch(/repeats row/);
  });
});

describe("conflicting duplicates", () => {
  it("is never silently overwritten", async () => {
    const co = await newCompany("m3c-conflict@example.com", "Conflict Co");
    const created = await post({ action: "add_counterparty", name: "Conflict Buyer", isBuyer: true }, co.cookie, co.id);
    const buyerId = (created.body as { counterparty: { id: string } }).counterparty.id;
    // Post the original record directly through the normal entry path.
    await post(
      { action: "add_receivable", counterpartyId: buyerId, amount: "1000", dueDate: day(10), externalId: "INV-CONFLICT" },
      co.cookie,
      co.id,
    );

    // The CSV claims the same reference with a different amount.
    const csvText = `counterparty_name,amount,due_date,reference\n"Conflict Buyer",9999.00,${day(10)},INV-CONFLICT\n`;
    const preview = await post(
      { action: "csv_import_preview", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING },
      co.cookie,
      co.id,
    );
    const row = (preview.body as { rows: { status: string }[] }).rows[0];
    expect(row.status).toBe("duplicate_conflict");

    const confirmed = await post(
      { action: "csv_import_confirm", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING },
      co.cookie,
      co.id,
    );
    expect(confirmed.body.created).toBe(0);
    expect(confirmed.body.skippedConflict).toBe(1);
    const stored = listReceivables(co.id).find((r) => r.externalId === "INV-CONFLICT")!;
    expect(stored.amountCents).toBe(100_000); // untouched — still the original $1,000
  });
});

describe("cross-company references", () => {
  it("never matches a counterparty from another company", async () => {
    const a = await newCompany("m3c-cross-a@example.com", "CSV Cross A");
    const b = await newCompany("m3c-cross-b@example.com", "CSV Cross B");
    await post({ action: "add_counterparty", name: "Shared Name Buyer", isBuyer: true }, a.cookie, a.id);
    // B has no counterparty with that name.
    const csvText = `counterparty_name,amount,due_date,reference\n"Shared Name Buyer",100.00,${day(10)},INV-CROSS\n`;
    const preview = await post(
      { action: "csv_import_preview", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING },
      b.cookie,
      b.id,
    );
    const row = (preview.body as { rows: { status: string; errors: string[] }[] }).rows[0];
    expect(row.status).toBe("error");
    expect(row.errors[0]).toMatch(/no buyer named/);
  });

  it("rejects an import posted against a company the caller does not belong to", async () => {
    const owner = await newCompany("m3c-forge-a@example.com", "CSV Forge A");
    const other = await newCompany("m3c-forge-b@example.com", "CSV Forge B");
    const csvText = `counterparty_name,amount,due_date,reference\n"X",100.00,${day(10)},INV-F\n`;
    const forged = await post(
      { action: "csv_import_confirm", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING },
      other.cookie,
      owner.id,
    );
    expect(forged.status).toBe(403);
  });

  it("rejects a VIEWER confirming an import", async () => {
    const owner = await newCompany("m3c-viewer-owner@example.com", "CSV Viewer Gate");
    const viewerCookie = await signUp("m3c-viewer@example.com");
    const userId = (db().prepare("SELECT id FROM user WHERE email = ?").get("m3c-viewer@example.com") as { id: string }).id;
    db()
      .prepare("INSERT INTO membership (user_id, business_id, role, created_at, created_by) VALUES (?, ?, 'VIEWER', ?, 'test')")
      .run(userId, owner.id, Date.now());
    const csvText = `counterparty_name,amount,due_date,reference\n"X",100.00,${day(10)},INV-V\n`;
    const result = await post(
      { action: "csv_import_confirm", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING },
      viewerCookie,
      owner.id,
    );
    expect(result.status).toBe(403);
  });
});

describe("financial state and plan invalidation", () => {
  it("does not change financial state on preview, or on a duplicate-only confirm", async () => {
    const co = await newCompany("m3c-noop@example.com", "No-op Import Co");
    await post({ action: "add_counterparty", name: "Noop Buyer", isBuyer: true }, co.cookie, co.id);
    const csvText = `counterparty_name,amount,due_date,reference\n"Noop Buyer",1000.00,${day(10)},INV-NOOP\n`;

    const beforePreview = listReceivables(co.id).length;
    await post({ action: "csv_import_preview", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING }, co.cookie, co.id);
    expect(listReceivables(co.id)).toHaveLength(beforePreview);

    await post({ action: "csv_import_confirm", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING }, co.cookie, co.id);
    const versionAfterFirst = (await loadPlanContext(co.id, BASELINE_SCENARIO)).planVersion;

    // Reimporting the identical row changes nothing.
    await post({ action: "csv_import_confirm", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING }, co.cookie, co.id);
    expect(listReceivables(co.id)).toHaveLength(1);
    expect((await loadPlanContext(co.id, BASELINE_SCENARIO)).planVersion).toBe(versionAfterFirst);
  });

  it("invalidates only the importing company's plan version", async () => {
    const a = await newCompany("m3c-plan-a@example.com", "CSV Plan A");
    const b = await newCompany("m3c-plan-b@example.com", "CSV Plan B");
    await post({ action: "add_counterparty", name: "A Buyer", isBuyer: true }, a.cookie, a.id);

    const aBefore = (await loadPlanContext(a.id, BASELINE_SCENARIO)).planVersion;
    const bBefore = (await loadPlanContext(b.id, BASELINE_SCENARIO)).planVersion;

    const csvText = `counterparty_name,amount,due_date,reference\n"A Buyer",1000.00,${day(10)},INV-PLAN-A\n`;
    await post({ action: "csv_import_confirm", kind: "receivable", csvText, mapping: RECEIVABLE_MAPPING }, a.cookie, a.id);

    expect((await loadPlanContext(a.id, BASELINE_SCENARIO)).planVersion).not.toBe(aBefore);
    expect((await loadPlanContext(b.id, BASELINE_SCENARIO)).planVersion).toBe(bBefore);
  });
});

describe("direct module validation", () => {
  it("rejects a row with an unsupported currency", async () => {
    const co = await newCompany("m3c-currency@example.com", "Currency Co");
    await post({ action: "add_counterparty", name: "FX Buyer", isBuyer: true }, co.cookie, co.id);
    const result = validateImportRows(co.id, "USD", "receivable", [
      { rowNumber: 2, counterpartyName: "FX Buyer", amount: "100", dueDate: day(10), externalId: "INV-FX", currency: "EUR" },
    ]);
    expect(result[0].status).toBe("error");
    expect(result[0].errors[0]).toMatch(/not this company's currency/);
  });
});
