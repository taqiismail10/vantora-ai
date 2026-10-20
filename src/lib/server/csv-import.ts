/**
 * CSV import for receivables and payables.
 *
 * Two passes share one validation function: `preview` never writes anything
 * — it is pure classification — and `confirm` re-runs that exact same
 * classification server-side (the client's preview is never trusted) before
 * writing, inside one transaction, so a batch of accepted rows commits
 * atomically or not at all.
 *
 * Reuses the existing model rather than inventing a parallel one: a row is
 * resolved to an existing counterparty by name (never created), and
 * duplicate detection follows the schema's own unique key — `(company_id,
 * external_id)`, the same constraint `addReceivable`/`addPayable` already
 * enforce — not a new counterparty-scoped key, since the existing model has
 * none.
 */

import { randomUUID } from "node:crypto";

import {
  addPayable,
  addReceivable,
  amountCents,
  listCounterparties,
  optionalText,
  parseDate,
  type Counterparty,
} from "./records";
import { db, transaction } from "./db";
import { AccessError } from "./identity";
import type { CurrencyCode } from "./money";

export type ImportKind = "receivable" | "payable";

export interface ImportRowInput {
  rowNumber: number;
  counterpartyName: unknown;
  amount: unknown;
  dueDate: unknown;
  externalId: unknown;
  /** Receivables only. */
  issueDate?: unknown;
  /** Checked against the company's own currency when given; never converted. */
  currency?: unknown;
}

export type ImportRowStatus = "new" | "duplicate_identical" | "duplicate_conflict" | "error";

export interface ImportRowResult {
  rowNumber: number;
  status: ImportRowStatus;
  errors: string[];
  counterpartyId?: string;
  counterpartyName?: string;
  externalId?: string;
  amountCents?: number;
  dueDate?: string;
  issueDate?: string | null;
}

export interface ImportPreview {
  kind: ImportKind;
  rows: ImportRowResult[];
  counts: { new: number; duplicateIdentical: number; duplicateConflict: number; error: number };
}

// --- CSV parsing (RFC 4180: quoted fields, "" escaping, CRLF or LF) -------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      endField();
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // A trailing row with no final newline still counts, unless the file is empty.
  if (field !== "" || row.length > 0) endRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export interface ParsedCsv {
  header: string[];
  rows: string[][];
}

export function parseCsvWithHeader(text: string): ParsedCsv {
  const all = parseCsv(text);
  if (all.length === 0) throw new AccessError(422, "the file is empty");
  return { header: all[0], rows: all.slice(1) };
}

export interface ColumnMapping {
  counterpartyName: string;
  amount: string;
  dueDate: string;
  externalId: string;
  issueDate?: string;
  currency?: string;
}

/** Turns a parsed CSV body into the row shape `validateImportRows` expects,
 * using the caller's column-name-to-field mapping. */
export function mapCsvRows(parsed: ParsedCsv, mapping: ColumnMapping): ImportRowInput[] {
  const index = new Map(parsed.header.map((name, i) => [name, i]));
  const col = (name: string | undefined) => (name === undefined ? undefined : index.get(name));
  const cpCol = col(mapping.counterpartyName);
  const amtCol = col(mapping.amount);
  const dueCol = col(mapping.dueDate);
  const refCol = col(mapping.externalId);
  const issueCol = col(mapping.issueDate);
  const currCol = col(mapping.currency);
  if (cpCol === undefined || amtCol === undefined || dueCol === undefined || refCol === undefined) {
    throw new AccessError(422, "counterparty, amount, due date and reference columns must all be mapped");
  }
  const at = (row: string[], i: number | undefined) => (i === undefined ? undefined : row[i]);
  return parsed.rows.map((row, i) => ({
    rowNumber: i + 2, // header is line 1
    counterpartyName: at(row, cpCol),
    amount: at(row, amtCol),
    dueDate: at(row, dueCol),
    externalId: at(row, refCol),
    issueDate: at(row, issueCol),
    currency: at(row, currCol),
  }));
}

// --- Template --------------------------------------------------------------

export function importTemplate(kind: ImportKind): string {
  const header =
    kind === "receivable"
      ? "counterparty_name,amount,due_date,reference,issue_date"
      : "counterparty_name,amount,due_date,reference";
  const example =
    kind === "receivable"
      ? '"Example Buyer Ltd.",1000.00,2026-12-01,INV-1001,2026-11-01'
      : '"Example Supplier Ltd.",500.00,2026-12-15,BILL-2001';
  return `${header}\n${example}\n`;
}

// --- Counterparty matching ---------------------------------------------

function resolveCounterparty(
  companies: Counterparty[],
  roleField: "isBuyer" | "isSupplier",
  rawName: unknown,
): { id?: string; name?: string; error?: string } {
  const name = optionalText(rawName, 120);
  if (!name) return { error: "counterparty name is required" };
  const candidates = companies.filter((c) => c[roleField]);
  const exact = candidates.filter((c) => c.name === name);
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].name };
  if (exact.length > 1) return { error: `"${name}" matches more than one ${roleField === "isBuyer" ? "buyer" : "supplier"} — ambiguous` };
  const loose = candidates.filter((c) => c.name.trim().toLowerCase() === name.toLowerCase());
  if (loose.length === 1) return { id: loose[0].id, name: loose[0].name };
  if (loose.length > 1) return { error: `"${name}" matches more than one ${roleField === "isBuyer" ? "buyer" : "supplier"} — ambiguous` };
  return { error: `no ${roleField === "isBuyer" ? "buyer" : "supplier"} named "${name}" exists on this company` };
}

// --- Validation (shared by preview and confirm) -------------------------

function existingByReference(
  companyId: string,
  kind: ImportKind,
): Map<string, { amountCents: number; dueDate: string; counterpartyId: string }> {
  const table = kind === "receivable" ? "receivable" : "payable";
  const rows = db()
    .prepare(`SELECT external_id, amount_cents, due_date, counterparty_id FROM ${table} WHERE company_id = ? AND external_id IS NOT NULL`)
    .all(companyId) as { external_id: string; amount_cents: number; due_date: string; counterparty_id: string }[];
  return new Map(rows.map((r) => [r.external_id, { amountCents: r.amount_cents, dueDate: r.due_date, counterpartyId: r.counterparty_id }]));
}

export function validateImportRows(
  companyId: string,
  currency: CurrencyCode,
  kind: ImportKind,
  inputRows: ImportRowInput[],
): ImportRowResult[] {
  const counterparties = listCounterparties(companyId);
  const roleField = kind === "receivable" ? "isBuyer" : "isSupplier";
  const existing = existingByReference(companyId, kind);
  const seenInFile = new Map<string, number>(); // external_id -> first row number

  return inputRows.map((input): ImportRowResult => {
    const errors: string[] = [];

    const refRaw = optionalText(input.externalId, 64);
    if (!refRaw) errors.push("reference is required for an imported record");

    if (input.currency !== undefined && optionalText(input.currency, 8) && optionalText(input.currency, 8) !== currency) {
      errors.push(`currency "${optionalText(input.currency, 8)}" is not this company's currency (${currency})`);
    }

    let amount: number | undefined;
    try {
      amount = amountCents(input.amount, currency, "amount");
    } catch (error) {
      errors.push(error instanceof AccessError ? error.message : "amount is invalid");
    }

    let dueDate: string | undefined;
    try {
      dueDate = parseDate(input.dueDate, "due date");
    } catch (error) {
      errors.push(error instanceof AccessError ? error.message : "due date is invalid");
    }

    let issueDate: string | null = null;
    if (kind === "receivable" && input.issueDate !== undefined && optionalText(input.issueDate, 10)) {
      try {
        issueDate = parseDate(input.issueDate, "issue date");
      } catch (error) {
        errors.push(error instanceof AccessError ? error.message : "issue date is invalid");
      }
      if (issueDate && dueDate && issueDate > dueDate) errors.push("issue date cannot be after due date");
    }

    const resolved = resolveCounterparty(counterparties, roleField, input.counterpartyName);
    if (resolved.error) errors.push(resolved.error);

    if (refRaw) {
      const firstSeen = seenInFile.get(refRaw);
      if (firstSeen !== undefined) {
        errors.push(`reference "${refRaw}" repeats row ${firstSeen} in this file`);
      } else {
        seenInFile.set(refRaw, input.rowNumber);
      }
    }

    if (errors.length > 0) {
      return { rowNumber: input.rowNumber, status: "error", errors };
    }

    const already = existing.get(refRaw);
    if (already) {
      const identical = already.amountCents === amount && already.dueDate === dueDate && already.counterpartyId === resolved.id;
      return {
        rowNumber: input.rowNumber,
        status: identical ? "duplicate_identical" : "duplicate_conflict",
        errors: identical
          ? []
          : [
              `reference "${refRaw}" already exists with different amount, due date or counterparty — not overwritten`,
            ],
        counterpartyId: resolved.id,
        counterpartyName: resolved.name,
        externalId: refRaw,
        amountCents: amount,
        dueDate,
        issueDate,
      };
    }

    return {
      rowNumber: input.rowNumber,
      status: "new",
      errors: [],
      counterpartyId: resolved.id,
      counterpartyName: resolved.name,
      externalId: refRaw,
      amountCents: amount,
      dueDate,
      issueDate,
    };
  });
}

function summarize(rows: ImportRowResult[]): ImportPreview["counts"] {
  return {
    new: rows.filter((r) => r.status === "new").length,
    duplicateIdentical: rows.filter((r) => r.status === "duplicate_identical").length,
    duplicateConflict: rows.filter((r) => r.status === "duplicate_conflict").length,
    error: rows.filter((r) => r.status === "error").length,
  };
}

/** Pure classification. Never writes to the database. */
export function previewImport(companyId: string, currency: CurrencyCode, kind: ImportKind, inputRows: ImportRowInput[]): ImportPreview {
  const rows = validateImportRows(companyId, currency, kind, inputRows);
  return { kind, rows, counts: summarize(rows) };
}

export interface ImportResult {
  created: number;
  skippedIdentical: number;
  skippedConflict: number;
}

/**
 * Re-validates from scratch, then commits every `new` row in one
 * transaction. Refuses outright — writing nothing — if any row still has an
 * error, so a client cannot bypass preview by only sending the rows it
 * liked.
 */
export function commitImport(
  companyId: string,
  currency: CurrencyCode,
  kind: ImportKind,
  inputRows: ImportRowInput[],
): ImportResult {
  const classified = validateImportRows(companyId, currency, kind, inputRows);
  const errorRows = classified.filter((r) => r.status === "error");
  if (errorRows.length > 0) {
    throw new AccessError(
      422,
      `${errorRows.length} row${errorRows.length === 1 ? "" : "s"} still have errors (e.g. row ${errorRows[0].rowNumber}: ${errorRows[0].errors[0]}) — fix them before confirming`,
    );
  }

  const toCreate = classified.filter((r) => r.status === "new");
  const batch = randomUUID();

  return transaction((database) => {
    for (const row of toCreate) {
      const created =
        kind === "receivable"
          ? addReceivable(companyId, currency, {
              counterpartyId: row.counterpartyId,
              amount: (row.amountCents! / 100).toFixed(2),
              dueDate: row.dueDate,
              externalId: row.externalId,
              issueDate: row.issueDate ?? undefined,
            })
          : addPayable(companyId, currency, {
              counterpartyId: row.counterpartyId,
              amount: (row.amountCents! / 100).toFixed(2),
              dueDate: row.dueDate,
              externalId: row.externalId,
            });
      const table = kind === "receivable" ? "receivable" : "payable";
      database.prepare(`UPDATE ${table} SET source = 'csv_import', import_batch = ? WHERE id = ?`).run(batch, created.id);
    }
    return {
      created: toCreate.length,
      skippedIdentical: classified.filter((r) => r.status === "duplicate_identical").length,
      skippedConflict: classified.filter((r) => r.status === "duplicate_conflict").length,
    };
  });
}

// --- CSV-text entry points (what the API actually receives) --------------
//
// The client never parses CSV itself — it only reads the header line to
// populate the column-mapping dropdowns. The authoritative parse, with
// quoted fields and Unicode handled correctly, happens here, once, so it is
// exercised by the same code on every request instead of trusting a second
// implementation in the browser.

function rowsFromCsv(csvText: unknown, mapping: unknown): ImportRowInput[] {
  if (typeof csvText !== "string" || !csvText.trim()) throw new AccessError(422, "a CSV file is required");
  if (!mapping || typeof mapping !== "object") throw new AccessError(422, "a column mapping is required");
  return mapCsvRows(parseCsvWithHeader(csvText), mapping as ColumnMapping);
}

export function previewImportFromCsv(
  companyId: string,
  currency: CurrencyCode,
  kind: ImportKind,
  csvText: unknown,
  mapping: unknown,
): ImportPreview {
  return previewImport(companyId, currency, kind, rowsFromCsv(csvText, mapping));
}

export function commitImportFromCsv(
  companyId: string,
  currency: CurrencyCode,
  kind: ImportKind,
  csvText: unknown,
  mapping: unknown,
): ImportResult {
  return commitImport(companyId, currency, kind, rowsFromCsv(csvText, mapping));
}
