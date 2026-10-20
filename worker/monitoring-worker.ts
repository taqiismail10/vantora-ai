/**
 * Vantora persistent monitoring worker.
 *
 * Run alongside the Next.js server:
 *   tsx worker/monitoring-worker.ts
 *
 * Or via npm:
 *   npm run worker
 *
 * The worker polls monitoring_event for unclaimed events belonging to active
 * mandates, claims them atomically, runs the monitoring agent for the company,
 * and writes results to monitoring_run. One active run per company at a time.
 *
 * Startup: reads VANTORA_DB_PATH (defaults to data/vantora.db) from the
 * environment, which must be the same file the Next.js server uses.
 *
 * Graceful shutdown: SIGTERM / SIGINT — completes the current run then exits.
 *
 * AI_CREDENTIAL_ENCRYPTION_KEY must match the running server's value.
 */

// MUST stay the first import: it loads the .env cascade as a side effect, and
// `db.ts` resolves DB_PATH when it is evaluated. Moving this below the imports
// that reach the database would silently restore the bug it fixes.
import { ENV_REPORT } from "./load-env";

import { randomUUID } from "node:crypto";

import { claimNextEvent, coalesceCompanyEvents, createRun, getMandate, advanceMandateAfterRun, completeRun, recordWorkerHeartbeat } from "../src/lib/server/monitoring";
import { getConnectionWithKey } from "../src/lib/server/ai-connection";
import { getCompany } from "../src/lib/server/companies";
import { runMonitoringAgent } from "../src/lib/agent/monitoring-agent";
import { companyDataset } from "../src/lib/server/company-state";

const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = 10_000; // poll every 10 s when idle
const MAX_CONSECUTIVE_ERRORS = 10;

let running = true;
let consecutiveErrors = 0;

process.on("SIGTERM", () => { running = false; });
process.on("SIGINT",  () => { running = false; });

// Resolved configuration, so a mismatch with the server is visible at startup
// rather than as "my mandate never runs" an hour later. The encryption key is
// reported as present/absent only — never its value.
console.log(`[monitoring-worker] ${WORKER_ID} started`);
console.log(`[monitoring-worker] env files loaded: ${ENV_REPORT.loaded.join(", ") || "none"}`);
console.log(`[monitoring-worker] database: ${ENV_REPORT.dbPath}`);

if (!ENV_REPORT.hasEncryptionKey) {
  console.error(
    "[monitoring-worker] AI_CREDENTIAL_ENCRYPTION_KEY is not set — stored AI credentials cannot be decrypted.\n" +
    "[monitoring-worker] Set it in .env.local (or .env) to the SAME value the Next.js server uses, then restart both.\n" +
    "[monitoring-worker] Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
  process.exit(1);
}

async function processEvent(companyId: string, eventType: string): Promise<void> {
  const mandate = getMandate(companyId);
  if (!mandate || mandate.status !== "active") return;

  const connection = getConnectionWithKey(companyId);
  if (!connection) {
    console.warn(`[monitoring-worker] company ${companyId}: no AI connection, skipping`);
    return;
  }

  const company = getCompany(companyId);
  if (!company) {
    console.warn(`[monitoring-worker] company ${companyId}: company row missing, skipping`);
    return;
  }

  // Build dataset to get dataVersion before the run
  const dataset = companyDataset(company);

  // Check connection_revision is current
  if (connection.testRevision < 1) {
    console.warn(`[monitoring-worker] company ${companyId}: connection not tested, skipping`);
    return;
  }

  const run = createRun({
    companyId,
    mandateId: mandate.id,
    connectionId: connection.id,
    connectionRevision: connection.testRevision,
    dataVersion: dataset.dataVersion,
    trigger: eventType,
  });

  console.log(`[monitoring-worker] ${WORKER_ID} run ${run.id} company=${companyId} trigger=${eventType}`);

  try {
    const result = await runMonitoringAgent(company, connection);

    // Stale check: if dataVersion changed mid-run (another financial mutation arrived), mark stale
    const freshDataset = companyDataset(company);
    const isStale = freshDataset.dataVersion !== result.dataVersion;

    completeRun(run.id, {
      status: isStale ? "stale" : result.source === "failed" ? "failed" : "completed",
      findings: { answer: result.answer, integrityOk: result.integrityOk, integrityViolations: result.integrityViolations },
      drafts: result.drafts,
      toolCalls: result.toolCalls,
      provider: result.provider,
      model: result.model,
      source: result.source,
      fallbackReason: result.fallbackReason,
      errorMessage: null,
      toolCallsUsed: result.toolCallsUsed,
    });

    advanceMandateAfterRun(companyId, run.id);
    console.log(`[monitoring-worker] run ${run.id} ${isStale ? "stale" : result.source} toolCalls=${result.toolCallsUsed}`);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    completeRun(run.id, {
      status: "failed",
      findings: null,
      drafts: null,
      toolCalls: null,
      provider: connection.provider,
      model: connection.model,
      source: "failed",
      fallbackReason: null,
      errorMessage: message,
      toolCallsUsed: 0,
    });
    advanceMandateAfterRun(companyId, run.id);
    console.error(`[monitoring-worker] run ${run.id} failed: ${message}`);
    throw err; // re-throw so consecutive error counter increments
  }
}

async function tick(): Promise<boolean> {
  const event = claimNextEvent(WORKER_ID);
  if (!event) return false;

  // Coalesce any other pending events for the same company — process once
  coalesceCompanyEvents(event.companyId, WORKER_ID);

  await processEvent(event.companyId, event.eventType);
  return true;
}

async function loop(): Promise<void> {
  while (running) {
    try {
      const didWork = await tick();
      consecutiveErrors = 0;
      if (!didWork) await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      consecutiveErrors++;
      console.error(`[monitoring-worker] error #${consecutiveErrors}:`, err instanceof Error ? err.message : err);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[monitoring-worker] ${MAX_CONSECUTIVE_ERRORS} consecutive errors — exiting`);
        process.exit(1);
      }
      await sleep(Math.min(consecutiveErrors * 5_000, 60_000));
    }
  }
  console.log(`[monitoring-worker] ${WORKER_ID} stopped`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Liveness runs on its own timer rather than inside the loop: a single agent
// run can outlast the staleness window, and a worker busy doing exactly what it
// was asked to do must not be reported as stopped.
recordWorkerHeartbeat(WORKER_ID);
const heartbeat = setInterval(() => recordWorkerHeartbeat(WORKER_ID), POLL_INTERVAL_MS / 2);

loop()
  .catch((err) => {
    console.error("[monitoring-worker] fatal:", err);
    process.exit(1);
  })
  .finally(() => clearInterval(heartbeat));
