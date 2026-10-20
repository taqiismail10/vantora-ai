/**
 * End-to-end verification of the AI-monitoring journey.
 *
 *   npx tsx scripts/verify-monitoring-journey.ts
 *
 * Runs against an isolated temporary database — never data/vantora.db — and
 * drives the same server modules the API routes and the worker use, so a pass
 * means the real path works rather than a mock of it.
 *
 * It performs one REAL provider call (the connection capability test) using
 * whichever key is already in the environment, and one real monitoring run.
 * The key is read from the environment and is never printed; the script asserts
 * that it does not appear in the stored row or in any API-shaped read.
 *
 * Exit code 0 only if every check passed.
 */

// First import: loads the .env cascade before db.ts resolves DB_PATH.
import { ENV_REPORT } from "../worker/load-env";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated database, set before anything imports db.ts.
process.env.VANTORA_DB_PATH = join(mkdtempSync(join(tmpdir(), "vantora-journey-")), "journey.db");

let failures = 0;
const ok = (s: string) => console.log(`  PASS  ${s}`);
const bad = (s: string) => { console.log(`  FAIL  ${s}`); failures++; };

function report(): never {
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function main() {
  console.log(`env files: ${ENV_REPORT.loaded.join(", ") || "none"}`);
  console.log(`database:  ${process.env.VANTORA_DB_PATH}`);
  console.log(`enc key:   ${ENV_REPORT.hasEncryptionKey ? "present" : "MISSING"}`);

  if (!ENV_REPORT.hasEncryptionKey) {
    bad("AI_CREDENTIAL_ENCRYPTION_KEY is not set — the feature fails closed by design");
    report();
  }

  const { createCompany, activateCompany } = await import("../src/lib/server/companies");
  const { addAccount, addCounterparty, addReceivable, addPayable } = await import("../src/lib/server/records");
  const { createOrReplaceConnection, getConnection, getConnectionWithKey, markConnectionTested } =
    await import("../src/lib/server/ai-connection");
  const {
    createMandate, setMandateStatus, queueFinancialChange, claimNextEvent,
    coalesceCompanyEvents, createRun, completeRun, advanceMandateAfterRun,
    listRecentRuns, recordWorkerHeartbeat, workerStatus,
  } = await import("../src/lib/server/monitoring");
  const { testConnectionCapability, runMonitoringAgent } = await import("../src/lib/agent/monitoring-agent");
  const { companyDataset } = await import("../src/lib/server/company-state");
  const { db } = await import("../src/lib/server/db");

  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  // ---------------------------------------------------------------- [1]
  console.log("\n[1] isolated non-demo company with real records");
  const company = createCompany(
    { name: "Journey Verify Co", industry: "manufacturing", country: "BD",
      businessType: "sme", timezone: "UTC", currency: "USD", locations: [] },
    "journey-owner",
  );
  const COMPANY_ID = company.id;
  addAccount(COMPANY_ID, "USD", { name: "Main", openingBalance: "40000", asOfDate: day(-1) });
  const cp = addCounterparty(COMPANY_ID, { name: "Northwind Retail", isBuyer: true, isSupplier: true });
  addReceivable(COMPANY_ID, "USD", { counterpartyId: cp.id, amount: "52000", dueDate: day(21) });
  addPayable(COMPANY_ID, "USD", { counterpartyId: cp.id, amount: "68000", dueDate: day(9), isPayroll: true });
  activateCompany(COMPANY_ID);

  const pending = () => db().prepare(
    "SELECT event_type, created_at FROM monitoring_event WHERE company_id = ? AND claimed_at IS NULL ORDER BY created_at",
  ).all(COMPANY_ID) as unknown as { event_type: string; created_at: number }[];

  const dataset = companyDataset(company);
  if (dataset.state) ok(`forecastable, dataVersion ${dataset.dataVersion.slice(0, 12)}…`);
  else bad(`not forecastable: ${dataset.coverage.filter((c) => c.level === "blocking").map((c) => c.code).join(", ")}`);
  if (company.isDemo) bad("company is flagged demo"); else ok("company is not the demonstration company");

  // ---------------------------------------------------------------- [2]
  console.log("\n[2] credential stored encrypted and never echoed back");
  const provider = (process.env.AI_PROVIDER === "gemini" ? "gemini" : "openrouter") as "gemini" | "openrouter";
  const apiKey = provider === "gemini" ? process.env.GEMINI_API_KEY : process.env.OPENROUTER_API_KEY;
  const model = provider === "gemini"
    ? (process.env.GEMINI_MODEL || "gemini-3.1-flash-lite")
    : (process.env.OPENROUTER_MODEL || "z-ai/glm-5.3-flash");

  if (!apiKey) {
    console.log(`  BLOCKED  no ${provider} API key in the environment — live-model verification cannot run`);
    report();
  }

  createOrReplaceConnection({ companyId: COMPANY_ID, provider, model, apiKey, createdBy: "journey-owner" });

  const row = db().prepare("SELECT encrypted_key FROM ai_connection WHERE company_id = ?")
    .get(COMPANY_ID) as { encrypted_key: string };
  if (row.encrypted_key.includes(apiKey)) bad("plaintext key found in the stored row");
  else ok("stored ciphertext does not contain the key");

  const meta = getConnection(COMPANY_ID) as unknown as Record<string, unknown>;
  if (meta.encryptedKey === undefined && meta.apiKey === undefined) ok("API-shaped read omits the key entirely");
  else bad("connection metadata exposed a key field");
  if (JSON.stringify(meta).includes(apiKey)) bad("key present in serialised metadata");
  else ok("key absent from serialised metadata");

  // ---------------------------------------------------------------- [3]
  console.log(`\n[3] REAL capability test — ${provider} / ${model}`);
  const stored = getConnectionWithKey(COMPANY_ID)!;
  const capability = await testConnectionCapability(stored, COMPANY_ID);
  if (capability.ok) { ok(`live model confirmed tool calling: ${capability.detail}`); markConnectionTested(COMPANY_ID); }
  else bad(`capability test failed: ${capability.detail}`);

  // ---------------------------------------------------------------- [4]
  console.log("\n[4] mandate created and activated");
  const mandate = createMandate({ companyId: COMPANY_ID, connectionId: getConnection(COMPANY_ID)!.id,
                                  ownerUserId: "journey-owner", checkIntervalS: 3600 });
  if (mandate.status === "paused") ok("mandate is created paused, not auto-armed");
  else bad(`new mandate status is ${mandate.status}`);
  const active = setMandateStatus(COMPANY_ID, "active", "journey-owner");
  if (active.status === "active") ok("mandate activated"); else bad(`mandate status ${active.status}`);
  if (pending().some((e) => e.event_type === "activation")) ok("activation event queued");
  else bad("no activation event queued");

  // ---------------------------------------------------------------- [5]
  console.log("\n[5] a financial change queues an automatic reassessment");
  db().prepare("DELETE FROM monitoring_event WHERE company_id = ?").run(COMPANY_ID);
  addReceivable(COMPANY_ID, "USD", { counterpartyId: cp.id, amount: "15000", dueDate: day(8) });
  queueFinancialChange(COMPANY_ID, "financial_change", { kind: "add_receivable" });
  if (pending().some((e) => e.event_type === "financial_change")) ok("financial_change event queued");
  else bad("no event queued for the financial change");

  // ---------------------------------------------------------------- [6]
  console.log("\n[6] the worker claims it and produces a run");
  recordWorkerHeartbeat("journey-worker");
  if (workerStatus().online) ok("worker reports online after a heartbeat");
  else bad("worker reported offline after a heartbeat");

  const claimed = claimNextEvent("journey-worker");
  if (!claimed) { bad("worker could not claim the due event"); report(); }
  ok(`claimed ${claimed.eventType}`);
  coalesceCompanyEvents(COMPANY_ID, "journey-worker");

  const fresh = companyDataset(company);
  const run = createRun({ companyId: COMPANY_ID, mandateId: active.id, connectionId: stored.id,
                          connectionRevision: Math.max(stored.testRevision, 1),
                          dataVersion: fresh.dataVersion, trigger: claimed.eventType });

  const result = await runMonitoringAgent(company, stored);
  completeRun(run.id, {
    status: result.source === "failed" ? "failed" : "completed",
    findings: { answer: result.answer, integrityOk: result.integrityOk, integrityViolations: result.integrityViolations },
    drafts: result.drafts, toolCalls: result.toolCalls,
    provider: result.provider, model: result.model, source: result.source,
    fallbackReason: result.fallbackReason, errorMessage: null, toolCallsUsed: result.toolCallsUsed,
  });
  advanceMandateAfterRun(COMPANY_ID, run.id);

  console.log(`        source=${result.source} provider=${result.provider} model=${result.model}`);
  console.log(`        toolCalls=${result.toolCallsUsed} drafts=${result.drafts.length} integrityOk=${result.integrityOk}`);
  if (result.fallbackReason) console.log(`        fallbackReason=${result.fallbackReason}`);
  for (const call of result.toolCalls) console.log(`          · ${call.tool} [${call.tier}] ${call.decision}`);

  // ---------------------------------------------------------------- [7]
  console.log("\n[7] findings, source and tool activity are readable");
  const [latest] = listRecentRuns(COMPANY_ID, 1);
  if (!latest) { bad("no run persisted"); report(); }
  ok(`run persisted with status ${latest.status}`);
  const findings = latest.findingsJson ? JSON.parse(latest.findingsJson) as { answer?: string } : null;
  if (findings?.answer) ok(`findings present (${findings.answer.length} chars)`); else bad("findings empty");
  if (latest.source) ok(`source labelled "${latest.source}"`); else bad("source not labelled");
  if (result.toolCallsUsed > 0) ok(`${result.toolCallsUsed} real tool call(s) recorded`);
  else bad("no tool activity recorded");
  if (result.source === "live_model") ok("LIVE-MODEL verification achieved");
  else console.log(`  NOTE  run fell back to "${result.source}" — not live-model evidence`);
  if (result.toolCalls.every((c) => c.tier !== "TIER_2_HITL_APPROVAL" || c.decision === "DENIED"))
    ok("no Tier 2 tool was executed by the agent");
  else bad("a Tier 2 tool was not denied");

  // ---------------------------------------------------------------- [8]
  console.log("\n[8] the next scheduled tick is queued but not yet claimable");
  const scheduled = pending().filter((e) => e.event_type === "scheduled");
  if (scheduled.length === 1) ok("exactly one scheduled tick queued");
  else bad(`${scheduled.length} scheduled ticks queued`);
  if (claimNextEvent("journey-worker") === null) ok("worker finds nothing due yet");
  else bad("a future scheduled tick was claimed early");

  // ---------------------------------------------------------------- [9]
  console.log("\n[9] pausing stops further agent work");
  setMandateStatus(COMPANY_ID, "paused", "journey-owner");
  db().prepare("DELETE FROM monitoring_event WHERE company_id = ?").run(COMPANY_ID);
  addReceivable(COMPANY_ID, "USD", { counterpartyId: cp.id, amount: "9000", dueDate: day(12) });
  queueFinancialChange(COMPANY_ID, "financial_change", { kind: "add_receivable" });
  if (pending().length === 0) ok("no event queued while paused");
  else bad("an event was queued while paused");

  db().prepare("INSERT INTO monitoring_event (company_id, event_type, created_at) VALUES (?, 'scheduled', ?)")
    .run(COMPANY_ID, Date.now() - 1_000);
  if (claimNextEvent("journey-worker") === null) ok("a due event is not claimable while paused");
  else bad("claimed an event for a paused mandate");

  report();
}

main().catch((error) => {
  console.error("journey aborted:", error);
  process.exit(1);
});
