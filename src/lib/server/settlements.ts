/**
 * Payments, adjustments and allocations — what actually settles an obligation.
 *
 * Three record types, kept apart because they do different things:
 *
 *   payment     moves money. A customer receipt or a supplier disbursement.
 *   adjustment  changes what is owed without moving money. A credit note.
 *   allocation  points an existing payment or adjustment at a specific
 *               invoice or bill. It never moves money by itself.
 *
 * Separating allocation from the payment is what makes the hard cases work: a
 * lump receipt can settle several invoices, several receipts can settle one
 * invoice, and money can arrive before anyone decides what it pays for.
 *
 * ## Opening-balance cutoff
 *
 * An account's opening balance is the money that was really there on its
 * `as_of_date`. Every payment dated on or before the company's cutoff — the
 * latest as-of date across its accounts — is therefore *already inside* that
 * balance. Recording it must not add the money a second time, but it must
 * still be allocatable, because the invoice it paid is open regardless.
 *
 *   effective_date <= cutoff   already in the opening balance; cash unchanged
 *   effective_date >  cutoff   new money; cash moves
 *
 * The flag is derived from that rule and then stored, so a later edit to an
 * account's as-of date cannot silently re-interpret money that was already
 * counted. An owner who knows better may set it explicitly; the stored value
 * is what every computation uses, and who set it is recorded.
 *
 * ## Dates
 *
 * `effective_date` is when the money moved in the real world; `recorded_at` is
 * when someone typed it in. Only the effective date drives cash and forecasts.
 * A payment dated in the future is real and kept, but it is not current cash —
 * it is money expected to arrive, and it is reported that way rather than
 * quietly inflating today's balance.
 *
 * ## Reversal
 *
 * Nothing posted is edited or deleted. A reversal stamps the row with who
 * reversed it, when and why, and every computation ignores reversed rows —
 * including allocations whose payment was reversed. The stamp is applied
 * inside the write transaction only when the row is not already reversed, so
 * a reversal takes effect exactly once however many times it is submitted.
 */

import { randomUUID } from "node:crypto";

import { db, transaction } from "./db";
import { AccessError } from "./identity";
import { MAX_CENTS, parseCents, type CurrencyCode } from "./money";
import { listAccounts, parseDate } from "./records";

export type PaymentDirection = "receipt" | "disbursement";
export type ObligationKind = "receivable" | "payable";
export type SourceKind = "payment" | "adjustment";
export type AdjustmentKind = "credit_note" | "debit_note";

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The date on or before which money is already inside an opening balance.
 * Null when the company has no accounts, in which case nothing can be settled.
 */
export function openingCutoff(companyId: string): string | null {
  const accounts = listAccounts(companyId);
  if (accounts.length === 0) return null;
  return accounts.reduce((latest, a) => (a.asOfDate > latest ? a.asOfDate : latest), accounts[0].asOfDate);
}

function amountCents(value: unknown, currency: CurrencyCode, field: string): number {
  const parsed = parseCents(value, currency);
  if (!parsed.ok) throw new AccessError(422, `${field}: ${parsed.reason}`);
  if (parsed.cents > MAX_CENTS) throw new AccessError(422, `${field} exceeds the supported ceiling`);
  return parsed.cents;
}

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, max) : "";

const bool = (value: unknown): boolean => value === true || value === "true" || value === 1 || value === "1";

// --- Rows -----------------------------------------------------------------

export interface Payment {
  id: string;
  direction: PaymentDirection;
  counterpartyId: string | null;
  counterpartyName: string | null;
  amountCents: number;
  currency: string;
  effectiveDate: string;
  /** False when the money was already inside an opening balance. */
  affectsCash: boolean;
  method: string;
  reference: string | null;
  allocatedCents: number;
  unallocatedCents: number;
  reversedAt: number | null;
  reversalReason: string | null;
  recordedAt: number;
  createdBy: string;
}

export interface Adjustment {
  id: string;
  kind: AdjustmentKind;
  targetKind: ObligationKind;
  counterpartyId: string | null;
  amountCents: number;
  effectiveDate: string;
  reason: string;
  allocatedCents: number;
  unallocatedCents: number;
  reversedAt: number | null;
  reversalReason: string | null;
  recordedAt: number;
  createdBy: string;
}

export interface Allocation {
  id: string;
  sourceKind: SourceKind;
  sourceId: string;
  targetKind: ObligationKind;
  targetId: string;
  amountCents: number;
  reversedAt: number | null;
  recordedAt: number;
  createdBy: string;
}

/** Original value, what has been applied to it, and what is still owed. */
export interface ObligationBalance {
  id: string;
  kind: ObligationKind;
  originalCents: number;
  /** Credit notes and other non-cash changes applied to it. */
  adjustedCents: number;
  /** Payments applied to it. */
  paidCents: number;
  remainingCents: number;
  settled: boolean;
}

// --- Reads ----------------------------------------------------------------

/** Live allocated totals per source, excluding reversed rows on either side. */
function allocatedBySource(companyId: string, kind: SourceKind): Map<string, number> {
  const rows = db()
    .prepare(
      `SELECT source_id, SUM(amount_cents) AS total FROM allocation
       WHERE company_id = ? AND source_kind = ? AND reversed_at IS NULL
       GROUP BY source_id`,
    )
    .all(companyId, kind) as unknown as { source_id: string; total: number }[];
  return new Map(rows.map((r) => [r.source_id, r.total]));
}

export function listPayments(companyId: string): Payment[] {
  const rows = db()
    .prepare(
      `SELECT p.*, c.name AS counterparty_name FROM payment p
       LEFT JOIN counterparty c ON c.id = p.counterparty_id AND c.company_id = p.company_id
       WHERE p.company_id = ? ORDER BY p.effective_date DESC, p.recorded_at DESC`,
    )
    .all(companyId) as unknown as Record<string, never>[];
  const allocated = allocatedBySource(companyId, "payment");
  return (rows as unknown as {
    id: string;
    direction: PaymentDirection;
    counterparty_id: string | null;
    counterparty_name: string | null;
    amount_cents: number;
    currency: string;
    effective_date: string;
    affects_cash: number;
    method: string;
    reference: string | null;
    reversed_at: number | null;
    reversal_reason: string | null;
    recorded_at: number;
    created_by: string;
  }[]).map((r) => {
    const allocatedCents = r.reversed_at ? 0 : (allocated.get(r.id) ?? 0);
    return {
      id: r.id,
      direction: r.direction,
      counterpartyId: r.counterparty_id,
      counterpartyName: r.counterparty_name,
      amountCents: r.amount_cents,
      currency: r.currency,
      effectiveDate: r.effective_date,
      affectsCash: r.affects_cash === 1,
      method: r.method,
      reference: r.reference,
      allocatedCents,
      unallocatedCents: r.reversed_at ? 0 : r.amount_cents - allocatedCents,
      reversedAt: r.reversed_at,
      reversalReason: r.reversal_reason,
      recordedAt: r.recorded_at,
      createdBy: r.created_by,
    };
  });
}

export function listAdjustments(companyId: string): Adjustment[] {
  const rows = db()
    .prepare("SELECT * FROM adjustment WHERE company_id = ? ORDER BY effective_date DESC, recorded_at DESC")
    .all(companyId) as unknown as {
    id: string;
    kind: AdjustmentKind;
    target_kind: ObligationKind;
    counterparty_id: string | null;
    amount_cents: number;
    effective_date: string;
    reason: string;
    reversed_at: number | null;
    reversal_reason: string | null;
    recorded_at: number;
    created_by: string;
  }[];
  const allocated = allocatedBySource(companyId, "adjustment");
  return rows.map((r) => {
    const allocatedCents = r.reversed_at ? 0 : (allocated.get(r.id) ?? 0);
    return {
      id: r.id,
      kind: r.kind,
      targetKind: r.target_kind,
      counterpartyId: r.counterparty_id,
      amountCents: r.amount_cents,
      effectiveDate: r.effective_date,
      reason: r.reason,
      allocatedCents,
      unallocatedCents: r.reversed_at ? 0 : r.amount_cents - allocatedCents,
      reversedAt: r.reversed_at,
      reversalReason: r.reversal_reason,
      recordedAt: r.recorded_at,
      createdBy: r.created_by,
    };
  });
}

export function listAllocations(companyId: string): Allocation[] {
  const rows = db()
    .prepare("SELECT * FROM allocation WHERE company_id = ? ORDER BY recorded_at")
    .all(companyId) as unknown as {
    id: string;
    source_kind: SourceKind;
    source_id: string;
    target_kind: ObligationKind;
    target_id: string;
    amount_cents: number;
    reversed_at: number | null;
    recorded_at: number;
    created_by: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    targetKind: r.target_kind,
    targetId: r.target_id,
    amountCents: r.amount_cents,
    reversedAt: r.reversed_at,
    recordedAt: r.recorded_at,
    createdBy: r.created_by,
  }));
}

/**
 * What is still owed on every invoice and bill.
 *
 * The original value is never altered by settlement: it stays on the record,
 * and what has been applied to it is reported beside it.
 */
export function obligationBalances(companyId: string): Map<string, ObligationBalance> {
  const balances = new Map<string, ObligationBalance>();
  const seed = (kind: ObligationKind, table: string) => {
    const rows = db()
      .prepare(`SELECT id, amount_cents, status FROM ${table} WHERE company_id = ?`)
      .all(companyId) as unknown as { id: string; amount_cents: number; status: string }[];
    for (const row of rows) {
      balances.set(row.id, {
        id: row.id,
        kind,
        originalCents: row.amount_cents,
        adjustedCents: 0,
        paidCents: 0,
        remainingCents: row.status === "cancelled" ? 0 : row.amount_cents,
        settled: row.status === "cancelled",
      });
    }
  };
  seed("receivable", "receivable");
  seed("payable", "payable");

  // Only live allocations whose source is itself live.
  const applied = db()
    .prepare(
      `SELECT a.target_id, a.source_kind, SUM(a.amount_cents) AS total
       FROM allocation a
       LEFT JOIN payment p    ON a.source_kind = 'payment'    AND p.id = a.source_id
       LEFT JOIN adjustment j ON a.source_kind = 'adjustment' AND j.id = a.source_id
       WHERE a.company_id = ? AND a.reversed_at IS NULL
         AND (a.source_kind <> 'payment'    OR p.reversed_at IS NULL)
         AND (a.source_kind <> 'adjustment' OR j.reversed_at IS NULL)
       GROUP BY a.target_id, a.source_kind`,
    )
    .all(companyId) as unknown as { target_id: string; source_kind: SourceKind; total: number }[];

  for (const row of applied) {
    const balance = balances.get(row.target_id);
    if (!balance || balance.settled) continue;
    if (row.source_kind === "payment") balance.paidCents += row.total;
    else balance.adjustedCents += row.total;
  }
  for (const balance of balances.values()) {
    if (balance.settled) continue;
    balance.remainingCents = Math.max(0, balance.originalCents - balance.paidCents - balance.adjustedCents);
    balance.settled = balance.remainingCents === 0;
  }
  return balances;
}

/**
 * Net cash recorded since the opening balances, as of `asOf`.
 *
 * Only payments that move money and have actually happened count: anything
 * already inside an opening balance, anything reversed, and anything dated in
 * the future is excluded.
 */
export function netCashCents(companyId: string, asOf = today()): number {
  const row = db()
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'receipt' THEN amount_cents ELSE -amount_cents END), 0) AS net
       FROM payment
       WHERE company_id = ? AND reversed_at IS NULL AND affects_cash = 1 AND effective_date <= ?`,
    )
    .get(companyId, asOf) as unknown as { net: number };
  return row.net;
}

/** Money recorded as arriving or leaving after `asOf`: real, but not yet cash. */
export function futureCashCents(companyId: string, asOf = today()): number {
  const row = db()
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'receipt' THEN amount_cents ELSE -amount_cents END), 0) AS net
       FROM payment
       WHERE company_id = ? AND reversed_at IS NULL AND affects_cash = 1 AND effective_date > ?`,
    )
    .get(companyId, asOf) as unknown as { net: number };
  return row.net;
}

// --- Writes ---------------------------------------------------------------

function obligationRow(companyId: string, kind: ObligationKind, id: string) {
  const table = kind === "receivable" ? "receivable" : "payable";
  return db()
    .prepare(`SELECT id, counterparty_id, amount_cents, status FROM ${table} WHERE company_id = ? AND id = ?`)
    .get(companyId, id) as unknown as
    | { id: string; counterparty_id: string; amount_cents: number; status: string }
    | undefined;
}

export interface PaymentInput {
  direction: unknown;
  amount: unknown;
  effectiveDate: unknown;
  counterpartyId?: unknown;
  method?: unknown;
  reference?: unknown;
  currency?: unknown;
  /** Explicit override of the opening-balance rule. */
  alreadyInOpeningBalance?: unknown;
  idempotencyKey?: unknown;
  /** Optional one-step allocation: settle these obligations with this payment. */
  allocations?: unknown;
}

export interface RecordedPayment {
  payment: Payment;
  /** True when an existing record was returned for a repeated idempotency key. */
  idempotent: boolean;
}

export function recordPayment(
  companyId: string,
  currency: CurrencyCode,
  input: PaymentInput,
  actor: string,
): RecordedPayment {
  const direction = input.direction === "disbursement" ? "disbursement" : input.direction === "receipt" ? "receipt" : null;
  if (!direction) throw new AccessError(422, 'direction must be "receipt" or "disbursement"');
  if (input.currency !== undefined && input.currency !== currency) {
    throw new AccessError(
      422,
      `this company keeps its books in ${currency}; a ${String(input.currency).slice(0, 8)} payment cannot be recorded against it`,
    );
  }
  const amount = amountCents(input.amount, currency, "payment amount");
  const effectiveDate = parseDate(input.effectiveDate, "payment date");
  const cutoff = openingCutoff(companyId);
  if (!cutoff) throw new AccessError(409, "Add an account with its opening balance before recording payments.");

  const affectsCash =
    input.alreadyInOpeningBalance === undefined ? effectiveDate > cutoff : !bool(input.alreadyInOpeningBalance);

  let counterpartyId: string | null = null;
  if (typeof input.counterpartyId === "string" && input.counterpartyId) {
    const row = db()
      .prepare("SELECT id FROM counterparty WHERE company_id = ? AND id = ?")
      .get(companyId, input.counterpartyId) as unknown as { id: string } | undefined;
    if (!row) throw new AccessError(404, "select a counterparty that belongs to this company");
    counterpartyId = row.id;
  }

  const key = text(input.idempotencyKey, 100) || null;
  const requested = Array.isArray(input.allocations) ? input.allocations : [];

  return transaction((database) => {
    if (key) {
      const existing = database
        .prepare("SELECT id FROM payment WHERE company_id = ? AND idempotency_key = ?")
        .get(companyId, key) as unknown as { id: string } | undefined;
      if (existing) {
        // A repeat of a request that already succeeded returns what it made,
        // rather than a second payment or an error the caller cannot act on.
        const payment = listPayments(companyId).find((p) => p.id === existing.id)!;
        return { payment, idempotent: true };
      }
    }

    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO payment (id, company_id, direction, counterparty_id, amount_cents, currency, effective_date,
                              affects_cash, method, reference, idempotency_key, recorded_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        companyId,
        direction,
        counterpartyId,
        amount,
        currency,
        effectiveDate,
        affectsCash ? 1 : 0,
        text(input.method, 40),
        text(input.reference, 80) || null,
        key,
        Date.now(),
        actor,
      );

    for (const entry of requested) {
      const spec = entry as { targetKind?: unknown; targetId?: unknown; amount?: unknown };
      allocateWithin(database, companyId, currency, {
        sourceKind: "payment",
        sourceId: id,
        sourceAmount: amount,
        targetKind: spec.targetKind,
        targetId: spec.targetId,
        amount: spec.amount,
        actor,
      });
    }

    const payment = listPayments(companyId).find((p) => p.id === id)!;
    return { payment, idempotent: false };
  });
}

export interface AdjustmentInput {
  kind: unknown;
  targetKind: unknown;
  amount: unknown;
  effectiveDate: unknown;
  reason?: unknown;
  counterpartyId?: unknown;
  idempotencyKey?: unknown;
  allocations?: unknown;
}

export function recordAdjustment(
  companyId: string,
  currency: CurrencyCode,
  input: AdjustmentInput,
  actor: string,
): { adjustment: Adjustment; idempotent: boolean } {
  const kind = input.kind === "debit_note" ? "debit_note" : input.kind === "credit_note" ? "credit_note" : null;
  if (!kind) throw new AccessError(422, 'kind must be "credit_note" or "debit_note"');
  const targetKind = input.targetKind === "payable" ? "payable" : input.targetKind === "receivable" ? "receivable" : null;
  if (!targetKind) throw new AccessError(422, 'targetKind must be "receivable" or "payable"');
  const amount = amountCents(input.amount, currency, "adjustment amount");
  const effectiveDate = parseDate(input.effectiveDate, "adjustment date");
  const key = text(input.idempotencyKey, 100) || null;
  const requested = Array.isArray(input.allocations) ? input.allocations : [];

  let counterpartyId: string | null = null;
  if (typeof input.counterpartyId === "string" && input.counterpartyId) {
    const row = db()
      .prepare("SELECT id FROM counterparty WHERE company_id = ? AND id = ?")
      .get(companyId, input.counterpartyId) as unknown as { id: string } | undefined;
    if (!row) throw new AccessError(404, "select a counterparty that belongs to this company");
    counterpartyId = row.id;
  }

  return transaction((database) => {
    if (key) {
      const existing = database
        .prepare("SELECT id FROM adjustment WHERE company_id = ? AND idempotency_key = ?")
        .get(companyId, key) as unknown as { id: string } | undefined;
      if (existing) {
        return { adjustment: listAdjustments(companyId).find((a) => a.id === existing.id)!, idempotent: true };
      }
    }
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO adjustment (id, company_id, kind, target_kind, counterparty_id, amount_cents, effective_date,
                                 reason, idempotency_key, recorded_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, companyId, kind, targetKind, counterpartyId, amount, effectiveDate, text(input.reason, 200), key, Date.now(), actor);

    for (const entry of requested) {
      const spec = entry as { targetId?: unknown; amount?: unknown };
      allocateWithin(database, companyId, currency, {
        sourceKind: "adjustment",
        sourceId: id,
        sourceAmount: amount,
        targetKind,
        targetId: spec.targetId,
        amount: spec.amount,
        actor,
      });
    }
    return { adjustment: listAdjustments(companyId).find((a) => a.id === id)!, idempotent: false };
  });
}

interface AllocateSpec {
  sourceKind: SourceKind;
  sourceId: string;
  sourceAmount: number;
  targetKind: unknown;
  targetId: unknown;
  amount: unknown;
  actor: string;
}

/**
 * Apply part of a payment or adjustment to one obligation.
 *
 * Runs inside the caller's transaction: the remaining balance and the source's
 * unallocated amount are both re-read here, so two requests racing to spend
 * the same money cannot both pass their check — `BEGIN IMMEDIATE` serialises
 * them and the second sees the first's row.
 */
function allocateWithin(
  database: ReturnType<typeof db>,
  companyId: string,
  currency: CurrencyCode,
  spec: AllocateSpec,
): Allocation {
  const targetKind = spec.targetKind === "payable" ? "payable" : spec.targetKind === "receivable" ? "receivable" : null;
  if (!targetKind) throw new AccessError(422, 'targetKind must be "receivable" or "payable"');
  if (typeof spec.targetId !== "string" || !spec.targetId) throw new AccessError(422, "targetId is required");

  const obligation = obligationRow(companyId, targetKind, spec.targetId);
  if (!obligation) throw new AccessError(404, "that invoice or bill does not belong to this company");
  if (obligation.status === "cancelled") throw new AccessError(409, "that record is cancelled and cannot be settled");

  const amount = amountCents(spec.amount, currency, "allocation amount");

  const alreadyOnSource = (
    database
      .prepare(
        "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM allocation WHERE company_id = ? AND source_kind = ? AND source_id = ? AND reversed_at IS NULL",
      )
      .get(companyId, spec.sourceKind, spec.sourceId) as unknown as { total: number }
  ).total;
  if (alreadyOnSource + amount > spec.sourceAmount) {
    throw new AccessError(
      409,
      `only ${(spec.sourceAmount - alreadyOnSource) / 100} of this ${spec.sourceKind} is unallocated`,
    );
  }

  const appliedToTarget = (
    database
      .prepare(
        `SELECT COALESCE(SUM(a.amount_cents), 0) AS total FROM allocation a
         LEFT JOIN payment p    ON a.source_kind = 'payment'    AND p.id = a.source_id
         LEFT JOIN adjustment j ON a.source_kind = 'adjustment' AND j.id = a.source_id
         WHERE a.company_id = ? AND a.target_id = ? AND a.reversed_at IS NULL
           AND (a.source_kind <> 'payment'    OR p.reversed_at IS NULL)
           AND (a.source_kind <> 'adjustment' OR j.reversed_at IS NULL)`,
      )
      .get(companyId, spec.targetId) as unknown as { total: number }
  ).total;
  if (appliedToTarget + amount > obligation.amount_cents) {
    throw new AccessError(
      409,
      `only ${(obligation.amount_cents - appliedToTarget) / 100} is still outstanding on that record`,
    );
  }

  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO allocation (id, company_id, source_kind, source_id, target_kind, target_id, amount_cents, recorded_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, companyId, spec.sourceKind, spec.sourceId, targetKind, spec.targetId, amount, Date.now(), spec.actor);

  return {
    id,
    sourceKind: spec.sourceKind,
    sourceId: spec.sourceId,
    targetKind,
    targetId: spec.targetId,
    amountCents: amount,
    reversedAt: null,
    recordedAt: Date.now(),
    createdBy: spec.actor,
  };
}

export function allocate(
  companyId: string,
  currency: CurrencyCode,
  input: { sourceKind: unknown; sourceId: unknown; targetKind: unknown; targetId: unknown; amount: unknown },
  actor: string,
): Allocation {
  const sourceKind = input.sourceKind === "adjustment" ? "adjustment" : input.sourceKind === "payment" ? "payment" : null;
  if (!sourceKind) throw new AccessError(422, 'sourceKind must be "payment" or "adjustment"');
  if (typeof input.sourceId !== "string" || !input.sourceId) throw new AccessError(422, "sourceId is required");
  const sourceId = input.sourceId;

  return transaction((database) => {
    const table = sourceKind === "payment" ? "payment" : "adjustment";
    const source = database
      .prepare(`SELECT id, amount_cents, reversed_at FROM ${table} WHERE company_id = ? AND id = ?`)
      .get(companyId, sourceId) as unknown as { id: string; amount_cents: number; reversed_at: number | null } | undefined;
    if (!source) throw new AccessError(404, `that ${sourceKind} does not belong to this company`);
    if (source.reversed_at) throw new AccessError(409, `that ${sourceKind} was reversed and cannot be allocated`);

    return allocateWithin(database, companyId, currency, {
      sourceKind,
      sourceId: source.id,
      sourceAmount: source.amount_cents,
      targetKind: input.targetKind,
      targetId: input.targetId,
      amount: input.amount,
      actor,
    });
  });
}

/**
 * Reverse a posted record. The row is kept and stamped, never deleted.
 *
 * Reversing a payment or adjustment also voids what it settled, because the
 * allocation only ever pointed at money that no longer stands.
 */
export function reverse(
  companyId: string,
  kind: SourceKind | "allocation",
  id: string,
  reason: string,
  actor: string,
): { reversed: boolean } {
  const table = kind === "allocation" ? "allocation" : kind;
  return transaction((database) => {
    const row = database
      .prepare(`SELECT id, reversed_at FROM ${table} WHERE company_id = ? AND id = ?`)
      .get(companyId, id) as unknown as { id: string; reversed_at: number | null } | undefined;
    if (!row) throw new AccessError(404, "that record does not belong to this company");
    // Applied only when it is not already reversed, so repeating the request
    // cannot restore an effect twice.
    if (row.reversed_at) return { reversed: false };

    const now = Date.now();
    database
      .prepare(`UPDATE ${table} SET reversed_at = ?, reversed_by = ?, reversal_reason = ? WHERE company_id = ? AND id = ?`)
      .run(now, actor, reason.slice(0, 200), companyId, id);
    if (kind !== "allocation") {
      database
        .prepare(
          `UPDATE allocation SET reversed_at = ?, reversed_by = ?, reversal_reason = 'source reversed'
           WHERE company_id = ? AND source_kind = ? AND source_id = ? AND reversed_at IS NULL`,
        )
        .run(now, actor, companyId, kind, id);
    }
    return { reversed: true };
  });
}

/** Everything settlement-related a company owns, for the API and the UI. */
export function settlementRecords(companyId: string) {
  return {
    payments: listPayments(companyId),
    adjustments: listAdjustments(companyId),
    allocations: listAllocations(companyId),
    balances: [...obligationBalances(companyId).values()],
    openingCutoff: openingCutoff(companyId),
    netCashCents: netCashCents(companyId),
    futureCashCents: futureCashCents(companyId),
  };
}
