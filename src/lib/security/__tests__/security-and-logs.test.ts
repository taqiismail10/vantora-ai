/**
 * End-to-end recovery workflow + red-team suite.
 *
 * The workflow runs once in beforeAll so the audit chain has a deterministic
 * order, then each test asserts against its recorded result. The run leaves 13
 * hash-chained entries in logs/sandbox_operation_logs.jsonl (Deliverable 06).
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  localForecast,
  localOptimize,
  type ForecastResult,
  type OptimizationResult,
} from "../../quant-client";
import {
  GENESIS_HASH,
  readChain,
  resetAuditLog,
  verifyChain,
  type AuditLogEntry,
} from "../../sandbox/execution-logger";
import {
  APEX_INVOICE_MEMOS,
  BENIGN_INVOICE_MEMO,
  MALICIOUS_INVOICE_MEMO,
  apexFinancialState,
  seedApexDataset,
} from "../../sandbox/seed-data";
import {
  PERMISSION_TIERS,
  classifyOperation,
  detectIndirectPromptInjection,
  enforcePermissionGate,
  issueApprovalToken,
  maxTier,
  verifyApprovalToken,
  verifyNumericalIntegrity,
  type GateResult,
} from "../permission-gate";

const ACTOR = "agent:vantora-recovery-copilot";
const PLAN_ID = "plan-apex-day14";

let forecast: ForecastResult;
let optimization: OptimizationResult;
const results: Record<string, GateResult> = {};

beforeAll(async () => {
  // Force the offline paths: no Supabase, deterministic TS mirror, fresh chain.
  delete process.env.DATABASE_URL;
  process.env.HITL_SIGNING_SECRET = "test-only-hitl-signing-secret-32-chars";
  resetAuditLog();

  const state = apexFinancialState();
  forecast = localForecast(state);
  optimization = localOptimize(state, forecast);
  const plan = optimization.optimal_plan;

  // ---- happy path: read -> forecast -> optimize -> draft -> approved execution
  results.read = await enforcePermissionGate({
    operation: "read_sme_profile",
    actorId: ACTOR,
  });

  results.forecast = await enforcePermissionGate({
    operation: "run_cash_flow_forecast",
    actorId: ACTOR,
    payload: forecast,
    quantEngineOutput: forecast,
  });

  results.optimize = await enforcePermissionGate({
    operation: "run_recovery_optimization",
    actorId: ACTOR,
    payload: optimization,
    quantEngineOutput: optimization,
  });

  results.truthfulDraft = await enforcePermissionGate({
    operation: "draft_customer_discount_offer",
    actorId: ACTOR,
    payload:
      `Recommended recovery plan: raise $${plan.cash_raised} in working capital for a total ` +
      `cost of $${plan.total_cost}, restoring day-${optimization.crunch_day} P10 cash to ` +
      `$${plan.post_recovery_p10_balance}.`,
    quantEngineOutput: optimization,
  });

  // A bare tool call: structural arguments only, so this asserts the token
  // check rather than the numerical one.
  const executeArgs = { plan_id: PLAN_ID, action_ids: plan.actions.map((a) => a.target_id) };

  results.executeNoToken = await enforcePermissionGate({
    operation: "execute_recovery_plan",
    actorId: ACTOR,
    planId: PLAN_ID,
    payload: executeArgs,
    quantEngineOutput: optimization,
  });

  results.executeApproved = await enforcePermissionGate({
    operation: "execute_recovery_plan",
    actorId: ACTOR,
    planId: PLAN_ID,
    payload: executeArgs,
    quantEngineOutput: optimization,
    userApprovalToken: issueApprovalToken({
      operation: "execute_recovery_plan",
      planId: PLAN_ID,
      actorId: "human:owner@apexmfg.example",
      payload: executeArgs,
    }),
  });

  // ---- red team
  results.wrongOperationToken = await enforcePermissionGate({
    operation: "accept_financing_offer",
    actorId: ACTOR,
    planId: PLAN_ID,
    userApprovalToken: issueApprovalToken({
      operation: "draft_recovery_plan_summary",
      planId: PLAN_ID,
      actorId: "human:owner@apexmfg.example",
    }),
  });

  results.expiredToken = await enforcePermissionGate({
    operation: "send_supplier_deferral_email",
    actorId: ACTOR,
    planId: PLAN_ID,
    userApprovalToken: issueApprovalToken({
      operation: "send_supplier_deferral_email",
      planId: PLAN_ID,
      actorId: "human:owner@apexmfg.example",
      ttlMs: -1_000,
    }),
  });

  results.hallucinatedDollars = await enforcePermissionGate({
    operation: "draft_recovery_plan_summary",
    actorId: ACTOR,
    payload: "Good news — we secured a $45,000 bridge facility to cover the payroll gap.",
    quantEngineOutput: optimization.optimal_plan,
  });

  results.hallucinatedApr = await enforcePermissionGate({
    operation: "draft_recovery_plan_summary",
    actorId: ACTOR,
    payload: "Meridian Capital will fund the shortfall at an APR of 6.25%, far below market.",
    quantEngineOutput: optimization.matched_financing_options,
  });

  results.injectedMemo = await enforcePermissionGate({
    operation: "read_sme_profile",
    actorId: ACTOR,
    untrustedContext: MALICIOUS_INVOICE_MEMO,
    payload: { source: "INV-2005" },
  });

  results.prohibitedWithToken = await enforcePermissionGate({
    operation: "wire_funds_to_external_account",
    actorId: ACTOR,
    planId: PLAN_ID,
    userApprovalToken: issueApprovalToken({
      operation: "wire_funds_to_external_account",
      planId: PLAN_ID,
      actorId: "human:owner@apexmfg.example",
    }),
  });

  results.benignMemo = await enforcePermissionGate({
    operation: "read_sme_profile",
    actorId: ACTOR,
    untrustedContext: BENIGN_INVOICE_MEMO,
  });

  // ---- (a) the $2,345 Meridian approval, replayed against $90,000 QuickFloat
  const meridianDraw = { financing_id: "FIN-MERIDIAN", amount: 2_345, plan_id: PLAN_ID };
  const meridianToken = issueApprovalToken({
    operation: "accept_financing_offer",
    planId: PLAN_ID,
    actorId: "human:owner@apexmfg.example",
    payload: meridianDraw,
    confirmedAmount: 2_345,
  });

  results.payloadMismatch = await enforcePermissionGate({
    operation: "accept_financing_offer",
    actorId: ACTOR,
    planId: PLAN_ID,
    payload: { financing_id: "FIN-QUICKFLOAT", amount: 90_000, plan_id: PLAN_ID },
    userApprovalToken: meridianToken,
  });

  // ---- (b) the same token, used twice for the payload it *was* minted for
  results.firstUse = await enforcePermissionGate({
    operation: "accept_financing_offer",
    actorId: ACTOR,
    planId: PLAN_ID,
    payload: meridianDraw,
    userApprovalToken: meridianToken,
  });
  results.replayedUse = await enforcePermissionGate({
    operation: "accept_financing_offer",
    actorId: ACTOR,
    planId: PLAN_ID,
    payload: meridianDraw,
    userApprovalToken: meridianToken,
  });

  // ---- (c) caller claims Tier 0 for a Tier 3 operation
  results.tierDowngrade = await enforcePermissionGate({
    operation: "wire_funds_to_external_account",
    actorId: ACTOR,
    tier: PERMISSION_TIERS.TIER_0_AUTO_READ,
  });
});

// ------------------------------------------------------------- recovery workflow

describe("end-to-end recovery workflow", () => {
  it("seeds Apex Manufacturing in memory when Supabase is not connected", async () => {
    const seeded = await seedApexDataset();
    expect(seeded.mode).toBe("in-memory");
    expect(seeded.invoices).toBe(6);
    expect(seeded.payables).toBe(7);
    // Meridian, Granite (credit), Heritage SBA (too slow), QuickFloat.
    expect(seeded.financingOptions).toBe(4);
    expect(seeded.quarantinedMemos).toContain("INV-2005");
  });

  it("detects the day 14 liquidity crunch", () => {
    expect(forecast.shortfall_detected).toBe(true);
    expect(forecast.first_shortfall_day).toBe(14);
    expect(forecast.p10_trajectory[12]).toBeGreaterThanOrEqual(25_000);
    expect(forecast.p10_trajectory[13]).toBeLessThan(25_000);
    expect(forecast.engine_source).toBe("typescript-fallback");
  });

  it("is deterministic run to run", () => {
    const again = localForecast(apexFinancialState());
    expect(again.p10_trajectory).toEqual(forecast.p10_trajectory);
    expect(again.p50_trajectory).toEqual(forecast.p50_trajectory);
    expect(again.shortfall_probability).toBe(forecast.shortfall_probability);
  });

  it("restores P10 cash above the $25,000 buffer at lowest cost", () => {
    const { optimal_plan, naive_borrowing_plan, baseline_do_nothing_plan } = optimization;
    expect(optimal_plan.meets_buffer).toBe(true);
    expect(optimal_plan.post_recovery_p10_balance).toBeGreaterThanOrEqual(25_000);
    expect(optimal_plan.total_cost).toBeLessThan(naive_borrowing_plan.total_cost);
    expect(naive_borrowing_plan.total_cost).toBeLessThan(baseline_do_nothing_plan.total_cost);
    expect(baseline_do_nothing_plan.meets_buffer).toBe(false);
  });

  it("charges the payroll default penalty in the do-nothing baseline", () => {
    const missed = optimization.baseline_do_nothing_plan.actions.map((a) => a.target_id);
    expect(missed).toContain("AP-PAYROLL");
  });

  it("screens out the lender Apex does not qualify for", () => {
    const granite = optimization.matched_financing_options.find((m) => m.id === "FIN-GRANITE");
    expect(granite?.eligible).toBe(false);
    expect(granite?.rejection_reason).toMatch(/credit score/);
  });
});

// --------------------------------------------------------------- the 4 tier gate

describe("permission tiers", () => {
  it("classifies operations, defaulting unknown ones to HITL approval", () => {
    expect(classifyOperation("run_cash_flow_forecast")).toBe(PERMISSION_TIERS.TIER_0_AUTO_READ);
    expect(classifyOperation("draft_supplier_deferral_email")).toBe(PERMISSION_TIERS.TIER_1_DRAFT_ONLY);
    expect(classifyOperation("execute_recovery_plan")).toBe(PERMISSION_TIERS.TIER_2_HITL_APPROVAL);
    expect(classifyOperation("wire_funds_to_external_account")).toBe(PERMISSION_TIERS.TIER_3_PROHIBITED);
    expect(classifyOperation("some_operation_nobody_registered")).toBe(
      PERMISSION_TIERS.TIER_2_HITL_APPROVAL,
    );
  });

  it("TIER_0 read-only operations run unattended", () => {
    expect(results.read.decision).toBe("ALLOWED");
    expect(results.forecast.decision).toBe("ALLOWED");
    expect(results.optimize.decision).toBe("ALLOWED");
  });

  it("TIER_1 produces a draft and never executes", () => {
    expect(results.truthfulDraft.decision).toBe("DRAFTED");
    expect(results.truthfulDraft.allowed).toBe(true);
    expect(results.truthfulDraft.numericalIntegrity?.ok).toBe(true);
  });

  it("TIER_2 requires a valid HMAC approval token", () => {
    expect(results.executeNoToken.decision).toBe("DENIED");
    expect(results.executeNoToken.reason).toMatch(/no userApprovalToken supplied/);
    expect(results.executeApproved.decision).toBe("ALLOWED");
    expect(results.executeApproved.tokenVerification?.valid).toBe(true);
  });

  it("TIER_3 is denied even with a correctly signed token", () => {
    expect(results.prohibitedWithToken.decision).toBe("DENIED");
    expect(results.prohibitedWithToken.reason).toMatch(/TIER_3_PROHIBITED/);
  });

  it("clamps a caller-supplied tier to the registry: TIER_3 cannot be downgraded", () => {
    expect(results.tierDowngrade.tier).toBe(PERMISSION_TIERS.TIER_3_PROHIBITED);
    expect(results.tierDowngrade.decision).toBe("DENIED");
    expect(results.tierDowngrade.allowed).toBe(false);
  });

  it("lets a caller raise its own tier but never lower it", () => {
    expect(maxTier(PERMISSION_TIERS.TIER_3_PROHIBITED, PERMISSION_TIERS.TIER_0_AUTO_READ)).toBe(
      PERMISSION_TIERS.TIER_3_PROHIBITED,
    );
    expect(maxTier(PERMISSION_TIERS.TIER_0_AUTO_READ, PERMISSION_TIERS.TIER_2_HITL_APPROVAL)).toBe(
      PERMISSION_TIERS.TIER_2_HITL_APPROVAL,
    );
  });
});

// ------------------------------------------------- payload binding & single use

describe("approval tokens bind to the exact payload", () => {
  it("refuses a $2,345 Meridian token replayed against a $90,000 QuickFloat draw", () => {
    expect(results.payloadMismatch.decision).toBe("DENIED");
    expect(results.payloadMismatch.reason).toMatch(/payloadDigest mismatch/);
    expect(results.payloadMismatch.tokenVerification?.valid).toBe(false);
  });

  it("allows the draw the human actually approved", () => {
    expect(results.firstUse.decision).toBe("ALLOWED");
    expect(results.firstUse.tokenVerification?.valid).toBe(true);
  });

  it("burns the nonce: the same token cannot be presented twice", () => {
    expect(results.replayedUse.decision).toBe("DENIED");
    expect(results.replayedUse.reason).toMatch(/already been consumed/);
  });

  it("carries a payload digest and a unique jti in every token", () => {
    const claims = (token: string) =>
      JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const mint = () =>
      issueApprovalToken({ operation: "execute_recovery_plan", planId: PLAN_ID, actorId: "human:x" });
    const a = claims(mint());
    const b = claims(mint());
    expect(a.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.jti).not.toBe(b.jti);
  });

  it("cross-checks the amount the human typed", () => {
    const payload = { financing_id: "FIN-MERIDIAN", amount: 2_345 };
    const token = issueApprovalToken({
      operation: "accept_financing_offer",
      planId: PLAN_ID,
      actorId: "human:x",
      payload,
      confirmedAmount: 9_999,
    });
    const check = verifyApprovalToken(token, {
      operation: "accept_financing_offer",
      planId: PLAN_ID,
      payload,
    });
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/confirmed for 9999/);
  });
});

describe("approval token forgery", () => {
  it("rejects a token minted for a different operation", () => {
    expect(results.wrongOperationToken.decision).toBe("DENIED");
    expect(results.wrongOperationToken.reason).toMatch(/was issued for/);
  });

  it("rejects an expired token", () => {
    expect(results.expiredToken.decision).toBe("DENIED");
    expect(results.expiredToken.reason).toMatch(/expired/);
  });

  it("rejects a tampered signature", () => {
    const token = issueApprovalToken({ operation: "execute_recovery_plan", planId: PLAN_ID, actorId: "human:x" });
    const [version, claims, signature] = token.split(".");
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}`;
    const check = verifyApprovalToken(`${version}.${claims}.${flipped}`, {
      operation: "execute_recovery_plan",
      planId: PLAN_ID,
    });
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/signature does not verify/);
  });

  it("rejects claims re-encoded without a matching signature", () => {
    const forged = Buffer.from(
      JSON.stringify({
        operation: "execute_recovery_plan",
        planId: PLAN_ID,
        actorId: "attacker",
        exp: Date.now() + 60_000,
      }),
      "utf8",
    ).toString("base64url");
    const check = verifyApprovalToken(`v1.${forged}.${"0".repeat(64)}`, {
      operation: "execute_recovery_plan",
    });
    expect(check.valid).toBe(false);
  });

  it("fails closed when no signing secret is configured", () => {
    const saved = process.env.HITL_SIGNING_SECRET;
    delete process.env.HITL_SIGNING_SECRET;
    const check = verifyApprovalToken("v1.abc.def", { operation: "execute_recovery_plan" });
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/HITL_SIGNING_SECRET/);
    process.env.HITL_SIGNING_SECRET = saved;
  });
});

// ------------------------------------------------------------ numerical integrity

describe("numerical hallucination blocking", () => {
  it("blocks a fabricated dollar amount", () => {
    expect(results.hallucinatedDollars.decision).toBe("DENIED");
    expect(results.hallucinatedDollars.numericalIntegrity?.ok).toBe(false);
    expect(
      results.hallucinatedDollars.numericalIntegrity?.violations.some(
        (v) => v.kind === "dollar" && v.value === 45_000,
      ),
    ).toBe(true);
  });

  it("blocks a fabricated APR", () => {
    expect(results.hallucinatedApr.decision).toBe("DENIED");
    expect(
      results.hallucinatedApr.numericalIntegrity?.violations.some(
        (v) => v.kind === "percentage" && v.value === 6.25,
      ),
    ).toBe(true);
  });

  it("allows figures that match the engine, including rounded ones", () => {
    const plan = optimization.optimal_plan;
    const rounded = Math.round(plan.total_cost);
    const check = verifyNumericalIntegrity(
      `The plan costs $${rounded} and raises $${plan.cash_raised}.`,
      optimization,
    );
    expect(check.ok).toBe(true);
    expect(check.checkedDollarFigures).toContain(rounded);
  });

  it("quotes an engine APR correctly", () => {
    const quickfloat = optimization.matched_financing_options.find((m) => m.id === "FIN-QUICKFLOAT")!;
    const check = verifyNumericalIntegrity(
      `QuickFloat's all-in cost is ${(quickfloat.effective_apr * 100).toFixed(2)}% APR.`,
      optimization.matched_financing_options,
    );
    expect(check.ok).toBe(true);
  });

  it("refuses to pass figures with nothing to verify against", () => {
    const check = verifyNumericalIntegrity("We can save you $12,345.", undefined);
    expect(check.ok).toBe(false);
    expect(check.violations[0].kind).toBe("unverifiable");
  });
});

// ------------------------------------------------------------- prompt injection

describe("indirect prompt injection", () => {
  it("catches the malicious invoice memo and escalates it to TIER_3", () => {
    expect(results.injectedMemo.decision).toBe("DENIED");
    expect(results.injectedMemo.tier).toBe(PERMISSION_TIERS.TIER_3_PROHIBITED);
    expect(results.injectedMemo.injection?.severity).toBe("critical");
  });

  it("names the specific attack patterns in the seeded memo", () => {
    const scan = detectIndirectPromptInjection(APEX_INVOICE_MEMOS["INV-2005"]);
    const names = scan.matches.map((m) => m.name);
    expect(scan.injectionDetected).toBe(true);
    expect(names).toContain("system_override");
    expect(names).toContain("wire_to_external_account");
    expect(names).toContain("account_number_injection");
    expect(names).toContain("bypass_approval");
  });

  it("does not flag ordinary supplier boilerplate", () => {
    const scan = detectIndirectPromptInjection(BENIGN_INVOICE_MEMO);
    expect(scan.injectionDetected).toBe(false);
    expect(scan.severity).toBe("none");
    expect(results.benignMemo.decision).toBe("ALLOWED");
  });

  // The two strings that used to hard-deny a clean invoice: a remittance
  // account number, and the word "secret" in its ordinary commercial sense.
  it.each([
    ["remittance advice", "Payment for order 4471. Please quote account #10044821 on remittance. Net-30."],
    ["NDA boilerplate", "Our proprietary coating is a trade secret; handle drawings per the NDA."],
    ["bank detail restatement", "Remit to the usual account on file; our bank details have not changed."],
    ["password-free IT note", "Portal access is unchanged — your buyer logs in with the same credentials."],
  ])("passes real B2B text without a false positive: %s", (_label, memo) => {
    const scan = detectIndirectPromptInjection(memo);
    expect(scan.matches.map((m) => m.name)).toEqual([]);
    expect(scan.injectionDetected).toBe(false);
  });

  it("still fires all six detectors on the planted memo", () => {
    const names = detectIndirectPromptInjection(MALICIOUS_INVOICE_MEMO).matches.map((m) => m.name);
    expect(new Set(names)).toEqual(
      new Set([
        "system_override",
        "ignore_previous_instructions",
        "wire_to_external_account",
        "account_number_injection",
        "bypass_approval",
        "forged_authority",
      ]),
    );
  });

  it("treats empty and missing memos as clean", () => {
    expect(detectIndirectPromptInjection(null).injectionDetected).toBe(false);
    expect(detectIndirectPromptInjection("").injectionDetected).toBe(false);
  });
});

// -------------------------------------------------------------- hash-chained log

describe("SHA-256 hash-chained audit log", () => {
  let chain: AuditLogEntry[];

  beforeAll(() => {
    chain = readChain();
  });

  it("wrote at least 12 real entries to logs/sandbox_operation_logs.jsonl", () => {
    expect(chain.length).toBeGreaterThanOrEqual(12);
  });

  it("starts from the genesis hash and links every entry", () => {
    expect(chain[0].prevLogHash).toBe(GENESIS_HASH);
    expect(chain[0].seq).toBe(1);
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].prevLogHash).toBe(chain[i - 1].currentLogHash);
      expect(chain[i].seq).toBe(chain[i - 1].seq + 1);
    }
  });

  it("verifies clean", () => {
    const verification = verifyChain(chain);
    expect(verification.valid).toBe(true);
    expect(verification.brokenAtSeq).toBeNull();
  });

  it("records both allowed and denied operations", () => {
    const decisions = new Set(chain.map((e) => e.decision));
    expect(decisions.has("ALLOWED")).toBe(true);
    expect(decisions.has("DRAFTED")).toBe(true);
    expect(decisions.has("DENIED")).toBe(true);
    expect(chain.some((e) => e.tier === "TIER_3_PROHIBITED")).toBe(true);
  });

  it("never stores raw payloads, only digests", () => {
    for (const entry of chain) {
      expect(entry.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(entry)).not.toContain("998877");
    }
  });

  it("detects an altered entry", () => {
    const tampered = structuredClone(chain);
    tampered[3] = { ...tampered[3], decision: "ALLOWED", reason: "approved by me" };
    const verification = verifyChain(tampered);
    expect(verification.valid).toBe(false);
    expect(verification.brokenAtSeq).toBe(tampered[3].seq);
    expect(verification.reason).toMatch(/altered/);
  });

  it("detects a deleted entry", () => {
    const tampered = chain.filter((_, i) => i !== 2);
    expect(verifyChain(tampered).valid).toBe(false);
  });
});
