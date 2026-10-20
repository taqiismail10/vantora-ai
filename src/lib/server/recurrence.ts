/**
 * Recurring obligations: payroll, rent, utilities and other scheduled bills.
 *
 * No background scheduler exists or is planned — occurrences are computed on
 * demand (`previewOccurrences`) and only written when an authorized user
 * explicitly asks (`generateOccurrences`), matching the records workspace's
 * "nothing happens until you act" pattern everywhere else in this app.
 *
 * A generated occurrence becomes an ordinary `payable` row through the
 * existing entry path (`addPayable`) — not a parallel record type — so it
 * reaches the forecast, the optimizer and `dataVersion` invalidation for
 * free, exactly as a manually entered bill does. Generation itself never
 * moves cash: it only creates a `payable`, the same as typing one in by hand.
 *
 * Duplicate prevention is layered: `recurring_occurrence` has a unique
 * (recurring_id, due_date) key, and the payable it creates gets an
 * `external_id` derived from that same occurrence id, so `payable`'s own
 * unique-reference constraint is a second, independent guard. Two concurrent
 * "generate" calls serialize on the same `BEGIN IMMEDIATE` transaction every
 * other write in this codebase uses, so the second sees the first's row and
 * silently skips it rather than erroring or duplicating.
 */

import { randomUUID } from "node:crypto";

import { addPayable, amountCents, getCounterparty, type PayableInput } from "./records";
import { ENGINE_HORIZON_DAYS } from "./company-state";
import { db, transaction } from "./db";
import { AccessError } from "./identity";
import type { CurrencyCode } from "./money";

/** The same 30-day window the forecast itself uses — occurrences are never
 * previewed or generated further out by default, though an explicit
 * `through` date may ask for more (surfaced to the user, not hidden). */
export function defaultHorizonDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ENGINE_HORIZON_DAYS);
  return d.toISOString().slice(0, 10);
}

export type RecurringCategory = "payroll" | "rent" | "utilities" | "other";
export type RecurringSchedule = "weekly" | "monthly";
export type RecurringStatus = "active" | "paused" | "ended";

export interface RecurringObligation {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  category: RecurringCategory;
  amountCents: number;
  schedule: RecurringSchedule;
  scheduleDay: number;
  startDate: string;
  endDate: string | null;
  isPayroll: boolean;
  payrollLockOffsetDays: number | null;
  status: RecurringStatus;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_DATE.test(value.trim())) {
    throw new AccessError(422, `${field} must be a date in YYYY-MM-DD form`);
  }
  const date = value.trim();
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new AccessError(422, `${field} is not a real calendar date`);
  }
  return date;
}

function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** The last calendar date on or before `through`, at or after `from`,
 * inclusive, that the schedule lands on — company-local dates throughout,
 * never a timezone-shifted instant. */
export function occurrenceDates(
  schedule: RecurringSchedule,
  scheduleDay: number,
  from: string,
  through: string,
): string[] {
  const dates: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${through}T00:00:00Z`);
  if (start > end) return dates;

  if (schedule === "weekly") {
    const cursor = new Date(start);
    const shift = (scheduleDay - cursor.getUTCDay() + 7) % 7;
    cursor.setUTCDate(cursor.getUTCDate() + shift);
    while (cursor <= end) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
    return dates;
  }

  // monthly: day-of-month `scheduleDay`, clamped to the last real day of a
  // shorter month — the one explicit, documented month-end rule. Never
  // skipped, never rolled into the next month.
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() + 1;
  for (;;) {
    const day = Math.min(scheduleDay, daysInMonth(year, month));
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate > end) break;
    if (candidate >= start) dates.push(candidate.toISOString().slice(0, 10));
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return dates;
}

export interface RecurringInput {
  counterpartyId: unknown;
  category: unknown;
  amount: unknown;
  schedule: unknown;
  scheduleDay: unknown;
  startDate: unknown;
  endDate?: unknown;
  isPayroll?: unknown;
  payrollLockOffsetDays?: unknown;
}

const CATEGORIES: readonly string[] = ["payroll", "rent", "utilities", "other"];

export function addRecurring(companyId: string, currency: CurrencyCode, input: RecurringInput): RecurringObligation {
  const counterparty = getCounterparty(companyId, typeof input.counterpartyId === "string" ? input.counterpartyId : "");
  if (!counterparty) throw new AccessError(404, "select a supplier that belongs to this company");
  if (!counterparty.isSupplier) throw new AccessError(422, `${counterparty.name} is not marked as a supplier`);
  if (typeof input.category !== "string" || !CATEGORIES.includes(input.category)) {
    throw new AccessError(422, `category must be one of ${CATEGORIES.join(", ")}`);
  }
  const amount = amountCents(input.amount, currency, "amount");
  if (input.schedule !== "weekly" && input.schedule !== "monthly") {
    throw new AccessError(422, 'schedule must be "weekly" or "monthly"');
  }
  const schedule = input.schedule;
  const dayMax = schedule === "weekly" ? 6 : 31;
  const dayMin = schedule === "weekly" ? 0 : 1;
  const scheduleDay = Number(input.scheduleDay);
  if (!Number.isInteger(scheduleDay) || scheduleDay < dayMin || scheduleDay > dayMax) {
    throw new AccessError(422, `scheduleDay must be an integer between ${dayMin} and ${dayMax} for a ${schedule} schedule`);
  }
  const startDate = parseDate(input.startDate, "start date");
  const endDate = input.endDate !== undefined && input.endDate !== "" && input.endDate !== null ? parseDate(input.endDate, "end date") : null;
  if (endDate && endDate < startDate) throw new AccessError(422, "end date cannot be before the start date");
  const isPayroll = input.isPayroll === true || input.isPayroll === "true";
  let lockOffset: number | null = null;
  if (isPayroll && input.payrollLockOffsetDays !== undefined && input.payrollLockOffsetDays !== "") {
    const offset = Number(input.payrollLockOffsetDays);
    if (!Number.isInteger(offset) || offset < 0 || offset > 30) throw new AccessError(422, "payroll lock offset must be 0-30 days");
    lockOffset = offset;
  }

  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO recurring_obligation
         (id, company_id, counterparty_id, category, amount_cents, schedule, schedule_day, start_date, end_date,
          is_payroll, payroll_lock_offset_days, status, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      id,
      companyId,
      counterparty.id,
      input.category,
      amount,
      schedule,
      scheduleDay,
      startDate,
      endDate,
      isPayroll ? 1 : 0,
      lockOffset,
      Date.now(),
      "system",
    );
  return getRecurring(companyId, id)!;
}

function hydrate(row: {
  id: string;
  counterparty_id: string;
  counterparty_name: string;
  category: RecurringCategory;
  amount_cents: number;
  schedule: RecurringSchedule;
  schedule_day: number;
  start_date: string;
  end_date: string | null;
  is_payroll: number;
  payroll_lock_offset_days: number | null;
  status: RecurringStatus;
}): RecurringObligation {
  return {
    id: row.id,
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparty_name,
    category: row.category,
    amountCents: row.amount_cents,
    schedule: row.schedule,
    scheduleDay: row.schedule_day,
    startDate: row.start_date,
    endDate: row.end_date,
    isPayroll: row.is_payroll === 1,
    payrollLockOffsetDays: row.payroll_lock_offset_days,
    status: row.status,
  };
}

export function listRecurring(companyId: string): RecurringObligation[] {
  const rows = db()
    .prepare(
      `SELECT r.*, c.name AS counterparty_name FROM recurring_obligation r
       JOIN counterparty c ON c.id = r.counterparty_id
       WHERE r.company_id = ? ORDER BY r.created_at`,
    )
    .all(companyId) as Parameters<typeof hydrate>[0][];
  return rows.map(hydrate);
}

export function getRecurring(companyId: string, id: string): RecurringObligation | null {
  const row = db()
    .prepare(
      `SELECT r.*, c.name AS counterparty_name FROM recurring_obligation r
       JOIN counterparty c ON c.id = r.counterparty_id
       WHERE r.company_id = ? AND r.id = ?`,
    )
    .get(companyId, id) as Parameters<typeof hydrate>[0] | undefined;
  return row ? hydrate(row) : null;
}

export interface RecurringUpdateInput {
  amount?: unknown;
  scheduleDay?: unknown;
  endDate?: unknown;
  payrollLockOffsetDays?: unknown;
}

/**
 * Edits the schedule itself — never a payable already generated from it.
 * Takes effect for occurrences computed after this call; anything already
 * in `recurring_occurrence` (and the payable it points to) is untouched,
 * because generation never re-reads the schedule for a date it already
 * resolved.
 */
export function updateRecurring(companyId: string, id: string, currency: CurrencyCode, input: RecurringUpdateInput): RecurringObligation {
  const existing = getRecurring(companyId, id);
  if (!existing) throw new AccessError(404, "recurring obligation not found");
  const amount = input.amount === undefined ? existing.amountCents : amountCents(input.amount, currency, "amount");
  let scheduleDay = existing.scheduleDay;
  if (input.scheduleDay !== undefined) {
    const dayMax = existing.schedule === "weekly" ? 6 : 31;
    const dayMin = existing.schedule === "weekly" ? 0 : 1;
    const next = Number(input.scheduleDay);
    if (!Number.isInteger(next) || next < dayMin || next > dayMax) throw new AccessError(422, `scheduleDay must be between ${dayMin} and ${dayMax}`);
    scheduleDay = next;
  }
  const endDate =
    input.endDate === undefined
      ? existing.endDate
      : input.endDate === "" || input.endDate === null
        ? null
        : parseDate(input.endDate, "end date");
  if (endDate && endDate < existing.startDate) throw new AccessError(422, "end date cannot be before the start date");
  let lockOffset = existing.payrollLockOffsetDays;
  if (input.payrollLockOffsetDays !== undefined) {
    if (input.payrollLockOffsetDays === "" || input.payrollLockOffsetDays === null) {
      lockOffset = null;
    } else {
      const offset = Number(input.payrollLockOffsetDays);
      if (!Number.isInteger(offset) || offset < 0 || offset > 30) throw new AccessError(422, "payroll lock offset must be 0-30 days");
      lockOffset = offset;
    }
  }
  db()
    .prepare("UPDATE recurring_obligation SET amount_cents = ?, schedule_day = ?, end_date = ?, payroll_lock_offset_days = ? WHERE company_id = ? AND id = ?")
    .run(amount, scheduleDay, endDate, lockOffset, companyId, id);
  return getRecurring(companyId, id)!;
}

export function setRecurringStatus(companyId: string, id: string, status: RecurringStatus): RecurringObligation {
  const existing = getRecurring(companyId, id);
  if (!existing) throw new AccessError(404, "recurring obligation not found");
  db().prepare("UPDATE recurring_obligation SET status = ? WHERE company_id = ? AND id = ?").run(status, companyId, id);
  return getRecurring(companyId, id)!;
}

export function deleteRecurring(companyId: string, id: string): void {
  const generated = db()
    .prepare("SELECT COUNT(*) AS n FROM recurring_occurrence WHERE recurring_id = ? AND company_id = ?")
    .get(id, companyId) as { n: number };
  if (generated.n > 0) {
    throw new AccessError(409, "This schedule has already generated obligations — end it instead of deleting it, to keep its history.");
  }
  db().prepare("DELETE FROM recurring_obligation WHERE company_id = ? AND id = ?").run(companyId, id);
}

// --- Occurrences ------------------------------------------------------

export interface OccurrenceRow {
  dueDate: string;
  occurrenceId: string;
  resolved: boolean;
  payableId: string | null;
  origin: "generated" | "linked" | null;
}

function occurrenceId(recurringId: string, dueDate: string): string {
  return `${recurringId}@${dueDate}`;
}

/** Every occurrence the schedule implies up to `through`, each marked
 * with whether it has already been resolved (generated or linked). Pure
 * read — never writes anything. */
export function previewOccurrences(companyId: string, recurringId: string, through: string): OccurrenceRow[] {
  const schedule = getRecurring(companyId, recurringId);
  if (!schedule) throw new AccessError(404, "recurring obligation not found");
  if (schedule.status === "ended") return [];
  const horizon = schedule.endDate && schedule.endDate < through ? schedule.endDate : through;
  const dates = occurrenceDates(schedule.schedule, schedule.scheduleDay, schedule.startDate, horizon);
  const resolved = new Map(
    (
      db()
        .prepare("SELECT due_date, payable_id, origin FROM recurring_occurrence WHERE recurring_id = ? AND company_id = ?")
        .all(recurringId, companyId) as { due_date: string; payable_id: string; origin: "generated" | "linked" }[]
    ).map((r) => [r.due_date, r]),
  );
  return dates.map((dueDate) => {
    const row = resolved.get(dueDate);
    return {
      dueDate,
      occurrenceId: occurrenceId(recurringId, dueDate),
      resolved: !!row,
      payableId: row?.payable_id ?? null,
      origin: row?.origin ?? null,
    };
  });
}

export interface GenerateResult {
  generated: number;
  alreadyResolved: number;
}

/**
 * Creates a payable for every not-yet-resolved occurrence through `through`.
 * Idempotent and concurrency-safe: the whole batch runs inside one
 * transaction, and each occurrence is re-checked against storage immediately
 * before it is written, so a repeated or concurrent call for the same
 * schedule generates nothing twice.
 */
export function generateOccurrences(companyId: string, currency: CurrencyCode, recurringId: string, through: string): GenerateResult {
  const schedule = getRecurring(companyId, recurringId);
  if (!schedule) throw new AccessError(404, "recurring obligation not found");
  if (schedule.status !== "active") throw new AccessError(409, `this schedule is ${schedule.status}; resume it before generating`);

  const planned = previewOccurrences(companyId, recurringId, through);
  const toGenerate = planned.filter((o) => !o.resolved);

  return transaction((database) => {
    let generated = 0;
    for (const occurrence of toGenerate) {
      const already = database
        .prepare("SELECT 1 FROM recurring_occurrence WHERE recurring_id = ? AND due_date = ?")
        .get(recurringId, occurrence.dueDate);
      if (already) continue; // a concurrent call already resolved this one
      const lockDate =
        schedule.isPayroll && schedule.payrollLockOffsetDays !== null
          ? shiftDate(occurrence.dueDate, -schedule.payrollLockOffsetDays)
          : undefined;
      const payableInput: PayableInput = {
        counterpartyId: schedule.counterpartyId,
        amount: (schedule.amountCents / 100).toFixed(2),
        dueDate: occurrence.dueDate,
        externalId: occurrence.occurrenceId,
        isPayroll: schedule.isPayroll,
        ...(lockDate ? { payrollLockDate: lockDate } : {}),
      };
      const payable = addPayable(companyId, currency, payableInput);
      database
        .prepare(
          "INSERT INTO recurring_occurrence (id, recurring_id, company_id, due_date, payable_id, origin, created_at, created_by) VALUES (?, ?, ?, ?, ?, 'generated', ?, ?)",
        )
        .run(randomUUID(), recurringId, companyId, occurrence.dueDate, payable.id, Date.now(), "system");
      generated += 1;
    }
    return { generated, alreadyResolved: planned.length - toGenerate.length };
  });
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Points an occurrence at a payable that already exists (entered manually
 * or imported) instead of generating a new one — so it is counted once.
 * Never merges automatically on matching amount, category or month; the
 * caller names the exact payable.
 */
export function linkOccurrence(companyId: string, recurringId: string, dueDate: string, payableId: string): void {
  const schedule = getRecurring(companyId, recurringId);
  if (!schedule) throw new AccessError(404, "recurring obligation not found");
  const payable = db().prepare("SELECT id FROM payable WHERE company_id = ? AND id = ?").get(companyId, payableId) as { id: string } | undefined;
  if (!payable) throw new AccessError(404, "that bill does not belong to this company");
  try {
    db()
      .prepare(
        "INSERT INTO recurring_occurrence (id, recurring_id, company_id, due_date, payable_id, origin, created_at, created_by) VALUES (?, ?, ?, ?, ?, 'linked', ?, ?)",
      )
      .run(randomUUID(), recurringId, companyId, dueDate, payableId, Date.now(), "system");
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new AccessError(409, `${dueDate} is already resolved for this schedule`);
    throw error;
  }
}
