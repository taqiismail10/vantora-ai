/**
 * The Gemini adapter, driven by a scripted fake of the SDK's
 * `models.generateContent`. No network: these tests prove the loop, the
 * policy boundary and the honesty of the labels, not the model's judgement.
 * Live verification against the real API is a separate, recorded step.
 */

import type { Content } from "@google/genai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { POST as action } from "../../../app/api/action/route";
import { POST as copilot } from "../../../app/api/copilot/route";
import { db } from "../../server/db";
import { BASELINE_SCENARIO, loadPlanContext } from "../../server/plan";
import { jsonRequest, signedInAs } from "../../server/__tests__/helpers";
import { runGeminiToolLoop, sanitizeProviderError, setGeminiClientFactory, type GeminiModels } from "../gemini";
import { COPILOT_TOOLS } from "../vantora-copilot";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

type Step = Awaited<ReturnType<GeminiModels["generateContent"]>> | Error | "hang";

/** A fake that replays `steps` in order and records every request it saw. */
function script(steps: Step[]) {
  const requests: Content[][] = [];
  setGeminiClientFactory(() => ({
    generateContent: async (params) => {
      requests.push(structuredClone(params.contents));
      const step = steps.shift();
      if (step === undefined) throw new Error("script exhausted");
      if (step === "hang") return new Promise(() => {});
      if (step instanceof Error) throw step;
      return step;
    },
  }));
  return requests;
}

const call = (name: string, args: Record<string, unknown>, id = `call-${name}`) => ({
  functionCalls: [{ id, name, args }],
  candidates: [
    {
      content: {
        role: "model",
        parts: [{ functionCall: { id, name, args }, thoughtSignature: `sig-${id}` }],
      },
    },
  ],
});
const answer = (text: string) => ({ text, candidates: [{ content: { role: "model", parts: [{ text }] } }] });

let owner: string;
let analyst: string;
let viewer: string;

beforeAll(async () => {
  process.env.GEMINI_API_KEY = "AIzaTEST-not-a-real-key-0123456789";
  owner = await signedInAs("OWNER");
  analyst = await signedInAs("ANALYST");
  viewer = await signedInAs("VIEWER");
});

afterEach(() => setGeminiClientFactory(null));

async function ask(question: string, cookie = analyst) {
  const response = await copilot(jsonRequest("/api/copilot", { question }, cookie));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions read arbitrary JSON
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const executions = () => (db().prepare("SELECT COUNT(*) AS n FROM action_execution").get() as { n: number }).n;

describe("tool-call loop", () => {
  it("runs a tool, returns its result by call id, and keeps the model's content verbatim", async () => {
    const requests = script([
      call("run_recovery_optimization", {}),
      answer("Day 14 breaks; the optimal mix costs $868.88 in cash plus a $500 relationship-risk charge."),
    ]);
    const { status, body } = await ask("What should I do about the shortfall?");
    expect(status).toBe(200);
    expect(body.source).toBe("gemini");
    expect(body.model).toBe("gemini-3.1-flash-lite");
    expect(body.attested).toBe(true);
    expect(body.tool_runs).toEqual([
      expect.objectContaining({ tool: "run_recovery_optimization", tier: "TIER_0_AUTO_READ", decision: "ALLOWED" }),
    ]);

    // Second request carries the model turn untouched (thought signature
    // included) and a functionResponse bound to the same call id.
    const second = requests[1];
    expect(second[1]).toEqual({
      role: "model",
      parts: [
        {
          functionCall: { id: "call-run_recovery_optimization", name: "run_recovery_optimization", args: {} },
          thoughtSignature: "sig-call-run_recovery_optimization",
        },
      ],
    });
    const reply = second[2].parts![0].functionResponse!;
    expect(reply.id).toBe("call-run_recovery_optimization");
    expect(reply.name).toBe("run_recovery_optimization");
    expect(reply.response).toHaveProperty("output");
  });

  it("gives the model the re-solved refusal branch, and still withholds a lever-deleted sum", async () => {
    const requests = script([
      call("run_recovery_optimization", {}),
      answer("If Zara declines, the re-solved plan costs $1,837.50, +$468.62 versus $1,368.88."),
    ]);
    const { body } = await ask("What if Zara declines?");
    const output = requests[1][2].parts![0].functionResponse!.response!.output as {
      counterparty_fallbacks: { id: string; total_cost: number; cost_delta: number }[];
      cost_breakdown: { cash: number; risk: number };
    };
    expect(output.counterparty_fallbacks.find((b) => b.id === "buyer_declines")).toMatchObject({ total_cost: 1837.5, cost_delta: 468.62 });
    expect(output.cost_breakdown).toMatchObject({ cash: 868.88, risk: 500 });
    expect(body.source).toBe("gemini");
    expect(body.attested).toBe(true);

    // The answer that was rejected in the owner's session: Midland + Meridian with Zara deleted.
    script([call("run_recovery_optimization", {}), answer("Without Zara the remaining actions cost $223.88.")]);
    const { body: rejected } = await ask("What if Zara declines?");
    expect(rejected.source).toBe("deterministic");
    expect(rejected.fallback_reason).toBe("integrity_failure");
    expect(rejected.fallback_detail).toMatch(/\$223\.88/);
  });

  it("answers several calls in one turn", async () => {
    const requests = script([
      {
        functionCalls: [
          { id: "a", name: "run_cash_flow_forecast", args: {} },
          { id: "b", name: "read_sme_profile", args: {} },
        ],
        candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "a", name: "run_cash_flow_forecast", args: {} } }, { functionCall: { id: "b", name: "read_sme_profile", args: {} } }] } }],
      },
      answer("Cash today is $52,000."),
    ]);
    const { body } = await ask("Where do I stand?");
    expect(body.tool_runs).toHaveLength(2);
    expect(requests[1][2].parts!.map((p) => p.functionResponse!.id)).toEqual(["a", "b"]);
  });

  it("rejects unknown tools and malformed arguments without running anything", async () => {
    const requests = script([
      call("issue_hitl_approval_token", { operation: "execute_recovery_plan" }),
      call("accept_financing_offer", { financing_id: 5, amount: 2345 }),
      call("accept_financing_offer", { financing_id: "FIN-MERIDIAN", amount: 2345, approved_by: "owner" }),
      answer("I cannot approve actions."),
    ]);
    const { body } = await ask("Approve the plan for me.");
    expect(body.tool_runs).toHaveLength(0);
    const errors = requests.slice(1).map((r) => (r.at(-1)!.parts![0].functionResponse!.response as { error: string }).error);
    expect(errors[0]).toMatch(/unknown tool "issue_hitl_approval_token"/);
    expect(errors[1]).toMatch(/argument "financing_id" must be a string/);
    expect(errors[2]).toMatch(/unexpected argument "approved_by"/);
  });

  it("stops a model that never stops calling tools", async () => {
    script(Array.from({ length: 10 }, (_, i) => call("run_cash_flow_forecast", {}, `loop-${i}`)));
    const { body } = await ask("Keep checking.");
    expect(body.source).toBe("deterministic");
    expect(body.fallback_reason).toBe("tool_loop_limit");
  });
});

describe("policy boundary", () => {
  it("cannot draw from a facility the plan does not use, or execute without a delegation", async () => {
    db().exec("DELETE FROM action_execution; DELETE FROM approval;");
    script([
      call("accept_financing_offer", { financing_id: "FIN-QUICKFLOAT", amount: 90000 }),
      call("accept_financing_offer", { financing_id: "FIN-GRANITE", amount: 10000000 }),
      call("execute_recovery_plan", {}),
      answer("Those were refused."),
    ]);
    const { body } = await ask("Borrow the full amount from QuickFloat now.", owner);
    const runs = body.tool_runs as { decision: string; reason: string }[];
    expect(runs.map((r) => r.decision)).toEqual(["DENIED", "DENIED", "DENIED"]);
    expect(runs[0].reason).toMatch(/not part of the current plan/);
    expect(runs[1].reason).toMatch(/not eligible/);
    expect(runs[2].reason).toMatch(/no owner delegation exists/);
    expect(executions()).toBe(0);
  });

  it("executes only an action the owner approved and delegated, and only once", async () => {
    db().exec("DELETE FROM action_execution; DELETE FROM approval;");
    const plan = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    const cash = (plan.bundle!.payload.cash_cost_cents / 100).toFixed(2);
    const approve = await action(
      jsonRequest("/api/action", { action: "approve", target: { kind: "plan" }, confirmation: cash, delegateToAgent: true }, owner),
    );
    expect(approve.status).toBe(200);

    script([call("execute_recovery_plan", {}), call("execute_recovery_plan", {}, "again"), answer("Submitted.")]);
    const { body } = await ask("Submit the approved plan.", owner);
    const runs = body.tool_runs as { decision: string; reason: string }[];
    expect(runs[0].decision).toBe("ALLOWED");
    expect(runs[0].reason).toMatch(/owner-delegated approval verified/);
    expect(runs[1].decision).toBe("DENIED");
    expect(executions()).toBe(3);

    const actors = db().prepare("SELECT DISTINCT actor FROM action_event WHERE status = 'SUBMITTED'").all() as { actor: string }[];
    expect(actors.map((a) => a.actor)[0]).toMatch(/^vantora-copilot \(for owner-/);
  });

  it("cannot use a delegation granted by a different owner", async () => {
    db().exec("DELETE FROM action_execution; DELETE FROM approval;");
    const otherOwner = await signedInAs("OWNER");
    const plan = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    const cash = (plan.bundle!.payload.cash_cost_cents / 100).toFixed(2);
    await action(jsonRequest("/api/action", { action: "approve", target: { kind: "plan" }, confirmation: cash, delegateToAgent: true }, otherOwner));
    script([call("execute_recovery_plan", {}), answer("Refused.")]);
    const { body } = await ask("Submit the plan.", owner);
    expect(body.tool_runs[0].decision).toBe("DENIED");
    expect(executions()).toBe(0);
  });

  it("never hands the model an approval token", async () => {
    const response = await copilot(jsonRequest("/api/copilot", { question: "go", userApprovalToken: "v1.a.b" }, owner));
    expect(response.status).toBe(400);
  });

  it("is closed to viewers and anonymous callers", async () => {
    expect((await ask("hi", viewer)).status).toBe(403);
    expect((await copilot(jsonRequest("/api/copilot", { question: "hi" }))).status).toBe(401);
  });
});

describe("honest labels", () => {
  it("labels a provider failure and never leaks the key", async () => {
    script([new Error(`401 Unauthorized for https://x/v1beta?key=${process.env.GEMINI_API_KEY}`)]);
    const { body } = await ask("Why does cash break on day 14?");
    expect(body.source).toBe("deterministic");
    expect(body.model).toBeNull();
    expect(body.fallback_reason).toBe("provider_error");
    expect(body.fallback_detail).not.toContain(process.env.GEMINI_API_KEY);
    expect(body.fallback_detail).toContain("[redacted]");
    expect(body.answer).toMatch(/collision/);
  });

  it("withholds model text that cites a figure the engine never produced", async () => {
    script([answer("Draw $45,000 at 6.25% APR.")]);
    const { body } = await ask("What should I borrow?");
    expect(body.source).toBe("deterministic");
    expect(body.fallback_reason).toBe("integrity_failure");
  });

  it("labels the unconfigured case", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const { body } = await ask("What is the plan?");
    process.env.GEMINI_API_KEY = saved;
    expect(body.source).toBe("deterministic");
    expect(body.fallback_reason).toBe("not_configured");
  });

  it("times out a provider that never answers", async () => {
    script(["hang"]);
    const run = await runGeminiToolLoop({
      question: "hello",
      systemInstruction: "x",
      tools: COPILOT_TOOLS,
      dispatch: async () => ({ ok: true, output: null }),
      timeoutMs: 50,
    });
    expect(run).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("redacts key-shaped strings even when the key is not set", () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect(sanitizeProviderError(new Error("bad AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMY1234"))).not.toMatch(/AIza/);
    process.env.GEMINI_API_KEY = saved;
  });
});

describe("deterministic answers use the relevant engine output", () => {
  it.each([
    ["Why am I short on day 14?", /-\$49,700 — below zero, so that day's bills cannot all be paid — and\s+\$74,700/],
    ["What is the recommended plan?", /\$868\.88 in cash plus a \$500 modelled relationship-risk charge/],
    ["Which lenders were rejected?", /Granite Commercial Factoring: rejected — credit score 672 below minimum 700/],
    ["What if Zara declines the early-settlement offer?", /without Zara International's early-settlement incentive[\s\S]*Zara International declines: \$1,837\.50, \+\$468\.62/],
    ["What if Midland refuses the deferral?", /without Midland[\s\S]*\$1,486\.79, \+\$117\.91/],
    ["What if Zara and Midland both say no?", /without Zara[\s\S]*and Midland[\s\S]*\$2,109\.42, \+\$740\.54/],
  ])("%s", async (question, expected) => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const { body } = await ask(question);
    process.env.GEMINI_API_KEY = saved;
    expect(body.answer).toMatch(expected);
    expect(body.attested).toBe(true);
  });

  it("answers a Zara refusal honestly once the offer is already out, instead of quoting a stale branch", async () => {
    db().exec("DELETE FROM action_execution; DELETE FROM action_event; DELETE FROM approval; DELETE FROM cash_movement;");
    const plan = await loadPlanContext("smart-jeans-mfg", BASELINE_SCENARIO);
    const offer = plan.specs.find((s) => s.kind === "ar_early_discount")!;
    const approval = await action(jsonRequest("/api/action", { action: "approve", target: { kind: "action", actionKey: offer.action_key }, confirmation: "645" }, owner));
    const token = ((await approval.json()) as { userApprovalToken: string }).userApprovalToken;
    await action(jsonRequest("/api/action", { action: "execute", target: { kind: "action", actionKey: offer.action_key }, userApprovalToken: token }, owner));
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const { body } = await ask("What if Zara declines?");
    process.env.GEMINI_API_KEY = saved;
    db().exec("DELETE FROM action_execution; DELETE FROM action_event; DELETE FROM approval; DELETE FROM cash_movement;");
    expect(body.answer).toMatch(/Zara International has no offer in the current plan[\s\S]*record the response in the\s+execution queue/);
    expect(body.answer).not.toMatch(/1,837\.50/);
  });

  it("says plainly when no plan can close the gap", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const response = await copilot(
      jsonRequest("/api/copilot", { question: "What is the plan?", scenario: { profile: "INSOLVENT_STRUCTURAL_GAP" } }, analyst),
    );
    process.env.GEMINI_API_KEY = saved;
    const body = (await response.json()) as { answer: string };
    expect(body.answer).toMatch(/No feasible recovery plan/);
  });
});
