/**
 * Monitoring mandate management and event queue.
 *
 * One mandate per company. Financial mutations queue monitoring_event rows;
 * the worker claims them atomically (one active run per company) and writes
 * monitoring_run rows for the results.
 */

import { randomUUID } from "node:crypto";

import { db, transaction } from "./db";
import { AccessError } from "./identity";

// ---------------------------------------------------------------------- types

export interface MonitoringMandate {
  id: string;
  companyId: string;
  connectionId: string;
  connectionRevision: number;
  status: "active" | "paused" | "stopped";
  ownerUserId: string;
  checkIntervalS: number;
  endDate: string | null;
  maxRunsTotal: number;
  maxTokensRun: number;
  maxToolCallsRun: number;
  runsExecuted: number;
  createdAt: number;
  activatedAt: number | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
}

export interface MonitoringRun {
  id: string;
  companyId: string;
  mandateId: string;
  connectionId: string;
  connectionRevision: number;
  dataVersion: string;
  status: "running" | "completed" | "failed" | "stale";
  trigger: string;
  startedAt: number;
  completedAt: number | null;
  findingsJson: string | null;
  draftsJson: string | null;
  toolCallsJson: string | null;
  provider: string | null;
  model: string | null;
  source: "live_model" | "deterministic" | "failed" | null;
  fallbackReason: string | null;
  errorMessage: string | null;
  toolCallsUsed: number;
}

interface MandateRow {
  id: string;
  company_id: string;
  connection_id: string;
  connection_revision: number;
  status: string;
  owner_user_id: string;
  check_interval_s: number;
  end_date: string | null;
  max_runs_total: number;
  max_tokens_run: number;
  max_tool_calls_run: number;
  runs_executed: number;
  created_at: number;
  activated_at: number | null;
  last_run_at: number | null;
  next_run_at: number | null;
}

interface RunRow {
  id: string;
  company_id: string;
  mandate_id: string;
  connection_id: string;
  connection_revision: number;
  data_version: string;
  status: string;
  trigger: string;
  started_at: number;
  completed_at: number | null;
  findings_json: string | null;
  drafts_json: string | null;
  tool_calls_json: string | null;
  provider: string | null;
  model: string | null;
  source: string | null;
  fallback_reason: string | null;
  error_message: string | null;
  tool_calls_used: number;
}

// ---------------------------------------------------------------------- mappers

function rowToMandate(r: MandateRow): MonitoringMandate {
  return {
    id: r.id,
    companyId: r.company_id,
    connectionId: r.connection_id,
    connectionRevision: r.connection_revision,
    status: r.status as MonitoringMandate["status"],
    ownerUserId: r.owner_user_id,
    checkIntervalS: r.check_interval_s,
    endDate: r.end_date,
    maxRunsTotal: r.max_runs_total,
    maxTokensRun: r.max_tokens_run,
    maxToolCallsRun: r.max_tool_calls_run,
    runsExecuted: r.runs_executed,
    createdAt: r.created_at,
    activatedAt: r.activated_at,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
  };
}

function rowToRun(r: RunRow): MonitoringRun {
  return {
    id: r.id,
    companyId: r.company_id,
    mandateId: r.mandate_id,
    connectionId: r.connection_id,
    connectionRevision: r.connection_revision,
    dataVersion: r.data_version,
    status: r.status as MonitoringRun["status"],
    trigger: r.trigger,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    findingsJson: r.findings_json,
    draftsJson: r.drafts_json,
    toolCallsJson: r.tool_calls_json,
    provider: r.provider,
    model: r.model,
    source: r.source as MonitoringRun["source"],
    fallbackReason: r.fallback_reason,
    errorMessage: r.error_message,
    toolCallsUsed: r.tool_calls_used,
  };
}

// ------------------------------------------------------------------- mandates

export function getMandate(companyId: string): MonitoringMandate | null {
  const row = db()
    .prepare("SELECT * FROM monitoring_mandate WHERE company_id = ?")
    .get(companyId) as unknown as MandateRow | undefined;
  return row ? rowToMandate(row) : null;
}

export function createMandate(input: {
  companyId: string;
  connectionId: string;
  ownerUserId: string;
  checkIntervalS?: number;
  endDate?: string | null;
}): MonitoringMandate {
  const id = randomUUID();
  const now = Date.now();
  const intervalS = Math.max(300, input.checkIntervalS ?? 3600);

  return transaction((d) => {
    d.prepare("DELETE FROM monitoring_mandate WHERE company_id = ?").run(input.companyId);
    d.prepare(`
      INSERT INTO monitoring_mandate
        (id, company_id, connection_id, status, owner_user_id,
         check_interval_s, end_date, max_runs_total, max_tokens_run,
         max_tool_calls_run, runs_executed, created_at)
      VALUES (?, ?, ?, 'paused', ?, ?, ?, 100, 8000, 20, 0, ?)
    `).run(id, input.companyId, input.connectionId, input.ownerUserId, intervalS, input.endDate ?? null, now);
    return rowToMandate(d.prepare("SELECT * FROM monitoring_mandate WHERE id = ?").get(id) as unknown as MandateRow);
  });
}

export function setMandateStatus(
  companyId: string,
  newStatus: "active" | "paused" | "stopped",
  ownerUserId: string,
): MonitoringMandate {
  return transaction((d) => {
    const row = d.prepare("SELECT * FROM monitoring_mandate WHERE company_id = ?").get(companyId) as unknown as MandateRow | undefined;
    if (!row) throw new AccessError(404, "No monitoring mandate for this company");
    if (row.owner_user_id !== ownerUserId) throw new AccessError(403, "Only the authorizing owner may change mandate status");

    const now = Date.now();
    if (newStatus === "active") {
      // Verify limits not exhausted
      if (row.runs_executed >= row.max_runs_total) {
        throw new AccessError(422, "Run limit reached. Create a new mandate to continue.");
      }
      if (row.end_date && new Date(`${row.end_date}T00:00:00Z`).getTime() < now) {
        throw new AccessError(422, "Mandate end date has passed. Update the end date to reactivate.");
      }
      const nextRunAt = now; // queue immediately on activation
      d.prepare("UPDATE monitoring_mandate SET status = 'active', activated_at = ?, next_run_at = ? WHERE company_id = ?")
        .run(now, nextRunAt, companyId);
      // Queue an activation event
      d.prepare("INSERT INTO monitoring_event (company_id, event_type, created_at) VALUES (?, 'activation', ?)")
        .run(companyId, now);
    } else {
      d.prepare("UPDATE monitoring_mandate SET status = ? WHERE company_id = ?").run(newStatus, companyId);
    }
    return rowToMandate(d.prepare("SELECT * FROM monitoring_mandate WHERE company_id = ?").get(companyId) as unknown as MandateRow);
  });
}

/** Called by financial mutations to queue a reassessment event. */
export function queueFinancialChange(companyId: string, eventType = "financial_change", payload: unknown = {}): void {
  const mandate = getMandate(companyId);
  if (!mandate || mandate.status !== "active") return;
  db().prepare("INSERT INTO monitoring_event (company_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(companyId, eventType, JSON.stringify(payload), Date.now());
}

// ------------------------------------------------------- worker claiming

export interface PendingEvent {
  id: number;
  companyId: string;
  eventType: string;
}

/**
 * Claim the oldest unclaimed event across all companies that have active mandates.
 * Returns null if none available. Atomic: uses IMMEDIATE transaction.
 */
export function claimNextEvent(workerId: string): PendingEvent | null {
  const now = Date.now();
  return transaction((d) => {
    const row = d.prepare(`
      SELECT e.id, e.company_id, e.event_type
      FROM monitoring_event e
      JOIN monitoring_mandate m ON m.company_id = e.company_id
      WHERE e.claimed_at IS NULL
        AND e.created_at <= ?
        AND m.status = 'active'
        AND m.runs_executed < m.max_runs_total
        AND (m.end_date IS NULL OR m.end_date >= date('now'))
      ORDER BY e.created_at ASC
      LIMIT 1
    `).get(now) as { id: number; company_id: string; event_type: string } | undefined;

    if (!row) return null;

    const claimed = d.prepare("UPDATE monitoring_event SET claimed_at = ?, claimed_by = ? WHERE id = ? AND claimed_at IS NULL")
      .run(now, workerId, row.id);
    if (claimed.changes !== 1) return null; // race: another worker beat us

    return { id: row.id, companyId: row.company_id, eventType: row.event_type };
  });
}

/**
 * Coalesce the company's other *due* events into this run, so a burst of edits
 * produces one reassessment of the final state rather than one run per edit.
 *
 * A future `scheduled` row is deliberately left alone: it is the next tick, not
 * backlog, and claiming it here would consume the schedule without running it.
 */
export function coalesceCompanyEvents(companyId: string, workerId: string): void {
  const now = Date.now();
  db().prepare("UPDATE monitoring_event SET claimed_at = ?, claimed_by = ? WHERE company_id = ? AND claimed_at IS NULL AND created_at <= ?")
    .run(now, workerId, companyId, now);
}

// ----------------------------------------------------------------------- runs

export function createRun(input: {
  companyId: string;
  mandateId: string;
  connectionId: string;
  connectionRevision: number;
  dataVersion: string;
  trigger: string;
}): MonitoringRun {
  const id = randomUUID();
  const now = Date.now();
  db().prepare(`
    INSERT INTO monitoring_run
      (id, company_id, mandate_id, connection_id, connection_revision,
       data_version, status, trigger, started_at)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(id, input.companyId, input.mandateId, input.connectionId, input.connectionRevision, input.dataVersion, input.trigger, now);
  return rowToRun(db().prepare("SELECT * FROM monitoring_run WHERE id = ?").get(id) as unknown as RunRow);
}

export function completeRun(runId: string, result: {
  status: "completed" | "failed" | "stale";
  findings: unknown;
  drafts: unknown;
  toolCalls: unknown;
  provider: string | null;
  model: string | null;
  source: "live_model" | "deterministic" | "failed" | null;
  fallbackReason: string | null;
  errorMessage: string | null;
  toolCallsUsed: number;
}): void {
  db().prepare(`
    UPDATE monitoring_run SET
      status = ?, completed_at = ?, findings_json = ?, drafts_json = ?,
      tool_calls_json = ?, provider = ?, model = ?, source = ?,
      fallback_reason = ?, error_message = ?, tool_calls_used = ?
    WHERE id = ?
  `).run(
    result.status, Date.now(),
    JSON.stringify(result.findings), JSON.stringify(result.drafts),
    JSON.stringify(result.toolCalls),
    result.provider, result.model, result.source,
    result.fallbackReason, result.errorMessage, result.toolCallsUsed,
    runId,
  );
}

export function advanceMandateAfterRun(companyId: string, runId: string): void {
  const mandate = getMandate(companyId);
  if (!mandate) return;
  const now = Date.now();
  const nextRunAt = now + mandate.checkIntervalS * 1000;
  db().prepare(`
    UPDATE monitoring_mandate
    SET runs_executed = runs_executed + 1, last_run_at = ?, next_run_at = ?
    WHERE company_id = ?
  `).run(now, nextRunAt, companyId);
  db().prepare("UPDATE monitoring_event SET run_id = ? WHERE company_id = ? AND claimed_at IS NOT NULL AND run_id IS NULL")
    .run(runId, companyId);

  // Queue next scheduled check if still active and under limits.
  //
  // `created_at` on a 'scheduled' row is its DUE time, not its insert time —
  // that is the convention `claimNextEvent`'s `created_at <= now` filter rests
  // on, and it is what keeps a mandate on its interval instead of running
  // back-to-back. Any earlier unclaimed tick is dropped first so exactly one
  // pending schedule exists per company, re-based on the run that just ended.
  const updated = getMandate(companyId)!;
  if (updated.status === "active" && updated.runsExecuted < updated.maxRunsTotal) {
    if (!updated.endDate || new Date(`${updated.endDate}T00:00:00Z`).getTime() > nextRunAt) {
      db().prepare("DELETE FROM monitoring_event WHERE company_id = ? AND event_type = 'scheduled' AND claimed_at IS NULL")
        .run(companyId);
      db().prepare("INSERT INTO monitoring_event (company_id, event_type, created_at) VALUES (?, 'scheduled', ?)")
        .run(companyId, nextRunAt);
    }
  }
}

export function listRecentRuns(companyId: string, limit = 10): MonitoringRun[] {
  return (db()
    .prepare("SELECT * FROM monitoring_run WHERE company_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(companyId, limit) as unknown as RunRow[]).map(rowToRun);
}

/** Check if the mandate's connection_revision matches a run — for stale-output prevention. */
export function isRunStale(run: MonitoringRun, currentMandate: MonitoringMandate): boolean {
  return run.connectionRevision !== currentMandate.connectionRevision;
}

// ------------------------------------------------------- worker liveness

/**
 * A worker is considered live for three poll intervals after its last beat, so
 * one slow run or a missed tick does not flap the UI to "stopped".
 */
export const WORKER_STALE_AFTER_MS = 35_000;

/** Called by the worker on every poll. */
export function recordWorkerHeartbeat(workerId: string): void {
  const now = Date.now();
  db().prepare(`
    INSERT INTO monitoring_worker (worker_id, started_at, last_seen_at) VALUES (?, ?, ?)
    ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).run(workerId, now, now);
}

/** Newest heartbeat across all workers, or null if none has ever run. */
export function workerStatus(): { online: boolean; lastSeenAt: number | null } {
  const row = db()
    .prepare("SELECT MAX(last_seen_at) AS last FROM monitoring_worker")
    .get() as { last: number | null } | undefined;
  const lastSeenAt = row?.last ?? null;
  return { online: lastSeenAt !== null && Date.now() - lastSeenAt < WORKER_STALE_AFTER_MS, lastSeenAt };
}
