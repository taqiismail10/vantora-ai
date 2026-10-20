/**
 * Scheduling and worker liveness.
 *
 * The behaviour under test is what keeps an active mandate from running flat
 * out: a 'scheduled' event carries its DUE time in `created_at`, and nothing
 * may claim it before then. Without the due filter the worker claimed the next
 * tick the instant it was written, so a mandate burned its whole run budget —
 * and the owner's real API quota — in a few seconds.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

process.env.AI_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.VANTORA_DB_PATH = ":memory:";

import { createOrReplaceConnection, getConnection } from "../ai-connection";
import {
  advanceMandateAfterRun,
  claimNextEvent,
  coalesceCompanyEvents,
  createMandate,
  createRun,
  queueFinancialChange,
  recordWorkerHeartbeat,
  setMandateStatus,
  workerStatus,
  WORKER_STALE_AFTER_MS,
} from "../monitoring";
import { db } from "../db";

const CO = "sched-test-co";

/** Pending (unclaimed) events for the company, oldest first. */
function pending() {
  return db()
    .prepare("SELECT id, event_type, created_at FROM monitoring_event WHERE company_id = ? AND claimed_at IS NULL ORDER BY created_at")
    .all(CO) as unknown as { id: number; event_type: string; created_at: number }[];
}

beforeAll(() => {
  db().prepare(`INSERT OR IGNORE INTO company (id, name, currency, status, is_demo, onboarding_step, created_at, created_by)
    VALUES (?, 'Schedule Test Co', 'USD', 'active', 0, 'done', ?, 'test')`).run(CO, Date.now());

  createOrReplaceConnection({
    companyId: CO,
    provider: "gemini",
    model: "gemini-2.0-flash",
    apiKey: "sched-key",
    createdBy: "owner",
  });
  db().prepare("UPDATE ai_connection SET tested_at = ?, test_revision = 1 WHERE company_id = ?").run(Date.now(), CO);
  createMandate({ companyId: CO, connectionId: getConnection(CO)!.id, ownerUserId: "owner", checkIntervalS: 3600 });
  setMandateStatus(CO, "active", "owner");
});

beforeEach(() => {
  db().prepare("DELETE FROM monitoring_event WHERE company_id = ?").run(CO);
});

describe("scheduled events are claimed only when due", () => {
  it("does not claim a scheduled event whose due time is in the future", () => {
    const dueLater = Date.now() + 3_600_000;
    db().prepare("INSERT INTO monitoring_event (company_id, event_type, created_at) VALUES (?, 'scheduled', ?)")
      .run(CO, dueLater);

    expect(claimNextEvent("worker-1")).toBeNull();
    expect(pending()).toHaveLength(1); // still queued, untouched
  });

  it("claims a scheduled event once its due time has passed", () => {
    const duePast = Date.now() - 1_000;
    db().prepare("INSERT INTO monitoring_event (company_id, event_type, created_at) VALUES (?, 'scheduled', ?)")
      .run(CO, duePast);

    const claimed = claimNextEvent("worker-1");
    expect(claimed).not.toBeNull();
    expect(claimed!.eventType).toBe("scheduled");
    expect(pending()).toHaveLength(0);
  });

  it("claims a financial change immediately — it is due when it happens", () => {
    queueFinancialChange(CO, "financial_change");
    const claimed = claimNextEvent("worker-1");
    expect(claimed).not.toBeNull();
    expect(claimed!.eventType).toBe("financial_change");
  });
});

describe("coalescing", () => {
  it("absorbs other due events for the company but leaves a future tick queued", () => {
    const now = Date.now();
    queueFinancialChange(CO, "financial_change");
    queueFinancialChange(CO, "financial_change");
    db().prepare("INSERT INTO monitoring_event (company_id, event_type, created_at) VALUES (?, 'scheduled', ?)")
      .run(CO, now + 3_600_000);

    const claimed = claimNextEvent("worker-1");
    expect(claimed).not.toBeNull();
    coalesceCompanyEvents(CO, "worker-1");

    const left = pending();
    expect(left).toHaveLength(1);
    expect(left[0].event_type).toBe("scheduled"); // the next tick survived
  });
});

describe("advanceMandateAfterRun", () => {
  it("leaves exactly one pending scheduled tick, due one interval out", () => {
    const run = createRun({
      companyId: CO,
      mandateId: "m",
      connectionId: getConnection(CO)!.id,
      connectionRevision: 1,
      dataVersion: "v1",
      trigger: "financial_change",
    });

    const before = Date.now();
    advanceMandateAfterRun(CO, run.id);
    advanceMandateAfterRun(CO, run.id); // a second run must not stack a second tick

    const left = pending();
    expect(left).toHaveLength(1);
    expect(left[0].event_type).toBe("scheduled");
    // Due ~1 h out (checkIntervalS = 3600), so not claimable now.
    expect(left[0].created_at).toBeGreaterThan(before + 3_500_000);
    expect(claimNextEvent("worker-1")).toBeNull();
  });
});

describe("worker liveness", () => {
  it("reports offline when no worker has ever reported in", () => {
    db().prepare("DELETE FROM monitoring_worker").run();
    const status = workerStatus();
    expect(status.online).toBe(false);
    expect(status.lastSeenAt).toBeNull();
  });

  it("reports online right after a heartbeat", () => {
    recordWorkerHeartbeat("worker-live");
    const status = workerStatus();
    expect(status.online).toBe(true);
    expect(status.lastSeenAt).not.toBeNull();
  });

  it("reports offline once the last heartbeat is older than the staleness window", () => {
    recordWorkerHeartbeat("worker-live");
    db().prepare("UPDATE monitoring_worker SET last_seen_at = ? WHERE worker_id = ?")
      .run(Date.now() - WORKER_STALE_AFTER_MS - 1_000, "worker-live");
    expect(workerStatus().online).toBe(false);
  });

  it("a repeated heartbeat updates the same row rather than adding one", () => {
    db().prepare("DELETE FROM monitoring_worker").run();
    recordWorkerHeartbeat("worker-same");
    recordWorkerHeartbeat("worker-same");
    const count = db().prepare("SELECT COUNT(*) AS n FROM monitoring_worker").get() as { n: number };
    expect(count.n).toBe(1);
  });
});
