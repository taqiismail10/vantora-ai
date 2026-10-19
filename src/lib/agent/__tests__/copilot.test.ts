/**
 * Copilot orchestration tests.
 *
 * These append to the same hash-chained log as the security suite rather than
 * resetting it (vitest runs the files serially for exactly that reason), so the
 * chain must still verify end to end once both suites have written to it.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  answerDeterministically,
  askCopilot,
  attestationBundle,
  COPILOT_TOOLS,
  loadCopilotContext,
  runCopilotTool,
  screenInvoiceMemos,
  synthesizeNarrative,
  tier2Payload,
  type CopilotContext,
} from "../vantora-copilot";
import { GENESIS_HASH, readChain, verifyChain } from "../../sandbox/execution-logger";
import {
  classifyOperation,
  issueApprovalToken,
  verifyNumericalIntegrity,
} from "../../security/permission-gate";

let ctx: CopilotContext;
let bundle: unknown;

beforeAll(async () => {
  delete process.env.DATABASE_URL; // in-memory dataset; no Supabase in tests
  delete process.env.ANTHROPIC_API_KEY; // force the deterministic path
  process.env.HITL_SIGNING_SECRET = "test-secret-for-copilot-suite";
  ctx = await loadCopilotContext();
  bundle = attestationBundle(ctx);
});

describe("copilot context", () => {
  it("loads the Smart Jeans crunch from whichever engine is serving", () => {
    expect(ctx.forecast.first_shortfall_day).toBe(14);
    expect(ctx.optimization.crunch_day).toBe(14);
    expect(ctx.optimization.required_cash).toBeGreaterThan(0);
    expect(ctx.planId).toBe("smartjeans-crunch-d14");
  });

  it("proves the optimal plan beats both counterfactuals", () => {
    const o = ctx.optimization;
    expect(o.optimal_plan.total_cost).toBeLessThan(o.naive_borrowing_plan.total_cost);
    expect(o.naive_borrowing_plan.total_cost).toBeLessThan(o.baseline_do_nothing_plan.total_cost);
    expect(o.optimal_plan.meets_buffer).toBe(true);
  });

  it("excludes the raw trajectories from the attested figures", () => {
    const serialised = JSON.stringify(bundle);
    expect(serialised).not.toContain("p10_trajectory");
    expect(serialised).toContain("optimization");
  });
});

describe("deterministic narrative", () => {
  it("quotes only figures the engine attests to", () => {
    const result = verifyNumericalIntegrity(synthesizeNarrative(ctx), bundle);
    expect(result.violations).toEqual([]);
    expect(result.checkedDollarFigures.length).toBeGreaterThan(8);
    expect(result.ok).toBe(true);
  });

  it("keeps every Q&A route attested", () => {
    for (const question of [
      "why did cash break?",
      "what does the plan cost?",
      "which lenders were rejected?",
      "how is this secured?",
      "what should I do next?",
      "anything else?",
    ]) {
      expect(verifyNumericalIntegrity(answerDeterministically(question, ctx), bundle).ok).toBe(true);
    }
  });

  it("still blocks a hallucinated figure and a hallucinated rate", () => {
    const result = verifyNumericalIntegrity(
      "Wire $45,000 to the cleared account and refinance at 6.25% APR.",
      bundle,
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.kind).sort()).toEqual(["dollar", "percentage"]);
  });
});

describe("every tool runs through the permission gate", () => {
  it("registers a tier for all exposed tools", () => {
    for (const tool of COPILOT_TOOLS) {
      expect(classifyOperation(tool.name)).toMatch(/^TIER_[0-3]_/);
    }
  });

  it("allows Tier 0 reads and logs them", async () => {
    const run = await runCopilotTool({ tool: "run_recovery_optimization", input: {}, ctx });
    expect(run.gate.tier).toBe("TIER_0_AUTO_READ");
    expect(run.gate.decision).toBe("ALLOWED");
    expect(run.gate.auditEntry.currentLogHash).toHaveLength(64);
  });

  it("drafts a customer discount offer without executing it", async () => {
    const invoiceId = ctx.optimization.optimal_plan.actions.find((a) => a.kind === "ar_early_discount")!.target_id;
    const run = await runCopilotTool({
      tool: "draft_customer_discount_offer",
      input: { invoice_id: invoiceId },
      ctx,
    });
    expect(run.gate.decision).toBe("DRAFTED");
    expect(run.gate.numericalIntegrity?.ok).toBe(true);
    expect(JSON.stringify(run.output)).toContain("requires_human_send");
  });

  it("drafts a supplier deferral request without sending it", async () => {
    const payableId = ctx.optimization.optimal_plan.actions.find((a) => a.kind === "ap_deferral")!.target_id;
    const run = await runCopilotTool({
      tool: "draft_supplier_deferral_email",
      input: { payable_id: payableId },
      ctx,
    });
    expect(run.gate.decision).toBe("DRAFTED");
    expect(run.gate.numericalIntegrity?.ok).toBe(true);
  });

  it("denies Tier 2 execution with no approval token", async () => {
    const run = await runCopilotTool({
      tool: "execute_recovery_plan",
      input: { plan_id: ctx.planId },
      ctx,
    });
    expect(run.ok).toBe(false);
    expect(run.gate.tier).toBe("TIER_2_HITL_APPROVAL");
    expect(run.gate.decision).toBe("DENIED");
    expect(run.gate.reason).toContain("no userApprovalToken");
  });

  it("denies a token minted for a different operation", async () => {
    const run = await runCopilotTool({
      tool: "execute_recovery_plan",
      input: { plan_id: ctx.planId },
      ctx,
      userApprovalToken: issueApprovalToken({
        operation: "accept_financing_offer",
        planId: ctx.planId,
        actorId: "cfo@apex",
      }),
    });
    expect(run.ok).toBe(false);
    expect(run.gate.reason).toContain("issued for");
  });

  it("executes Tier 2 once a human approves that exact plan", async () => {
    const run = await runCopilotTool({
      tool: "execute_recovery_plan",
      input: { plan_id: ctx.planId },
      ctx,
      userApprovalToken: issueApprovalToken({
        operation: "execute_recovery_plan",
        planId: ctx.planId,
        actorId: "cfo@apex",
        payload: tier2Payload("execute_recovery_plan", { plan_id: ctx.planId }, ctx),
      }),
    });
    expect(run.ok).toBe(true);
    expect(run.gate.decision).toBe("ALLOWED");
    expect(run.gate.tokenVerification?.valid).toBe(true);
    expect(run.output).toMatchObject({ executed_in_sandbox: true, meets_buffer: true });
  });

  it("escalates a memo-carrying read into Tier 3 and denies it", async () => {
    const run = await runCopilotTool({
      tool: "read_sme_profile",
      input: { include_memos: true },
      ctx,
      actorId: "red-team",
    });
    expect(run.ok).toBe(false);
    expect(run.gate.tier).toBe("TIER_3_PROHIBITED");
    expect(run.gate.injection?.injectionDetected).toBe(true);
    expect(run.gate.injection?.severity).toBe("critical");
    // The attack text itself must never reach the log.
    expect(JSON.stringify(run.gate.auditEntry)).not.toContain("998877");
  });

  it("still serves the same read without the memos", async () => {
    const run = await runCopilotTool({ tool: "read_sme_profile", input: {}, ctx });
    expect(run.gate.decision).toBe("ALLOWED");
    expect(JSON.stringify(run.output)).toContain("memo_quarantined");
  });

  it("screens memos on the default read path, quarantining only the poisoned one", async () => {
    const run = await runCopilotTool({ tool: "read_sme_profile", input: {}, ctx });
    const invoices = (run.output as { invoices_ar: { id: string; memo_quarantined: boolean }[] })
      .invoices_ar;
    const quarantined = invoices.filter((i) => i.memo_quarantined).map((i) => i.id);
    // INV-2005 carries the injection; INV-2002's memo is ordinary boilerplate.
    expect(quarantined).toEqual(["INV-2005"]);
  });

  it("records the matched patterns against the invoice at ingestion", () => {
    const screened = screenInvoiceMemos(ctx);
    const poisoned = screened.find((m) => m.invoice_id === "INV-2005")!;
    const clean = screened.find((m) => m.invoice_id === "INV-2002")!;
    expect(poisoned.quarantined).toBe(true);
    expect(poisoned.matched_patterns).toContain("wire_to_external_account");
    expect(clean.quarantined).toBe(false);
    expect(clean.matched_patterns).toEqual([]);
  });

  it("fails closed on an unregistered tool", async () => {
    const run = await runCopilotTool({ tool: "liquidate_everything", input: {}, ctx });
    expect(run.gate.tier).toBe("TIER_2_HITL_APPROVAL");
    expect(run.ok).toBe(false);
  });
});

describe("askCopilot", () => {
  it("answers deterministically and attests the answer when no API key is set", async () => {
    const turn = await askCopilot({ question: "what does the recovery plan cost?", ctx });
    expect(turn.source).toBe("deterministic");
    expect(turn.model).toBeNull();
    expect(turn.numericalIntegrity.ok).toBe(true);
    expect(turn.answer).toContain("$");
  });
});

describe("audit chain", () => {
  it("still verifies after everything above was logged", () => {
    const chain = readChain();
    const verification = verifyChain(chain);
    expect(verification.valid).toBe(true);
    expect(chain[0].prevLogHash).toBe(GENESIS_HASH);
    // This suite's own gate calls. It may run before or after the security
    // suite, so the floor is what it contributes alone — never a total that
    // depends on another file (or a stale log) having run first.
    expect(verification.length).toBeGreaterThanOrEqual(10);
  });
});
