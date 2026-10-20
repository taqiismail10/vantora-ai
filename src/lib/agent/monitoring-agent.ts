/**
 * Monitoring agent execution.
 *
 * Runs the bounded copilot tool loop using a company's own AI connection
 * (stored credentials, not process.env) against that company's live financial
 * state. Produces findings and Tier 0/1 drafts only — Tier 2 tools are blocked
 * by the existing runCopilotTool guard.
 *
 * The deterministic fallback is clearly labelled. A fallback run does not count
 * as live-model task completion for demo purposes.
 */

import { verifyNumericalIntegrity } from "../security/permission-gate";
import { DEFAULT_GEMINI_MODEL, geminiAdapter } from "./gemini";
import { runToolLoop } from "./llm";
import { DEFAULT_OPENROUTER_BASE_URL, DEFAULT_OPENROUTER_MODEL, openRouterAdapter } from "./openrouter";
import { answerDeterministically, attestationBundle, loadCopilotContext, COPILOT_SYSTEM_PROMPT, COPILOT_TOOLS } from "./vantora-copilot";
import { plainCopilotText } from "./ask";
import { decryptApiKey } from "../server/ai-connection";
import { companyDataset } from "../server/company-state";
import type { AiConnection } from "../server/ai-connection";
import type { Company } from "../server/companies";

const MONITORING_QUESTION =
  "Monitor this company's cash position. Reassess the financial state, " +
  "investigate any forecast buffer breach, compare feasible recovery options " +
  "and prepare counterparty requests for the owner's review. " +
  "Report the current situation, any breach found, the recommended recovery " +
  "actions, and any draft communications you prepared.";

/**
 * Per-model-request budget for a background run.
 *
 * The shared loop defaults to 20 s, which is the right answer when a person is
 * watching a chat reply. Nobody is waiting on a monitoring run, and it is the
 * harder request: the full ten-tool catalogue, a multi-turn loop, and whichever
 * model the owner chose — which may be a slow or free-tier one. At 20 s these
 * runs reached the deterministic fallback on timeout even though the same
 * credential passed its capability check, so the mandate produced fallback
 * output indefinitely while looking correctly configured.
 *
 * With MAX_TURNS = 5 in the shared loop this bounds a run at ~5 minutes.
 */
const MONITORING_TIMEOUT_MS = 60_000;

export interface MonitoringAgentResult {
  answer: string;
  source: "live_model" | "deterministic" | "failed";
  provider: string | null;
  model: string | null;
  fallbackReason: string | null;
  toolCallsUsed: number;
  toolCalls: { tool: string; tier: string; decision: string; seq: number }[];
  drafts: { tool: string; invoiceId?: string; payableId?: string; text: string }[];
  integrityOk: boolean;
  integrityViolations: string[];
  dataVersion: string;
}

export async function runMonitoringAgent(
  company: Company,
  connection: AiConnection & { encryptedKey: string },
): Promise<MonitoringAgentResult> {
  const dataset = companyDataset(company);
  if (!dataset.state) {
    return {
      answer: `Cannot assess ${company.name}: ${dataset.coverage.find((c) => c.level === "blocking")?.message ?? "insufficient data"}`,
      source: "failed",
      provider: null,
      model: null,
      fallbackReason: "insufficient_data",
      toolCallsUsed: 0,
      toolCalls: [],
      drafts: [],
      integrityOk: true,
      integrityViolations: [],
      dataVersion: dataset.dataVersion,
    };
  }

  // `memos: {}` is load-bearing, not tidiness. Without it `loadCopilotContext`
  // falls back to the named preset's memos, so a real company's monitoring run
  // would be screening — and reasoning over — the demonstration plant's
  // counterparty notes. One of those seeded memos is the planted
  // prompt-injection payload used by the red-team playground, so the fallback
  // also made the agent's own `read_sme_profile` call come back TIER_3 DENIED
  // on a company that has no memos at all. This mirrors `loadPlanContext`,
  // which passes the same empty map for exactly this reason.
  const ctx = await loadCopilotContext(
    dataset.state,
    company.id,
    "SOLVABLE_DAY14_CRUNCH", // preset for plan-id generation; real data is from dataset.state
    { memos: {}, planSlug: company.id, currency: dataset.company.currency },
  );
  const bundle = attestationBundle(ctx);

  const toolCalls: MonitoringAgentResult["toolCalls"] = [];
  const drafts: MonitoringAgentResult["drafts"] = [];

  // Dynamic import avoids circular dep on vantora-copilot at module load
  const { runCopilotTool } = await import("./vantora-copilot");

  const dispatch = async (name: string, args: Record<string, unknown>) => {
    const result = await runCopilotTool({ tool: name, input: args, ctx, actorId: `monitor:${company.id}`, actorType: "agent" });
    const seq = toolCalls.length + 1;
    toolCalls.push({ tool: name, tier: result.gate.tier, decision: result.gate.decision, seq });
    // Capture any Tier 1 draft text
    if (result.gate.decision === "DRAFTED" && result.ok) {
      const text = typeof result.output === "string" ? result.output :
        typeof (result.output as { draft?: string })?.draft === "string"
          ? (result.output as { draft: string }).draft
          : JSON.stringify(result.output);
      drafts.push({
        tool: name,
        invoiceId: typeof args.invoice_id === "string" ? args.invoice_id : undefined,
        payableId: typeof args.payable_id === "string" ? args.payable_id : undefined,
        text,
      });
    }
    return { ok: result.ok, output: result.output };
  };

  // Decrypt the API key for this request only; never stored in a variable that outlives this scope
  let apiKey: string;
  try {
    apiKey = decryptApiKey(connection.encryptedKey, company.id, connection.id);
  } catch {
    return {
      answer: "AI connection credentials could not be decrypted. Reconfigure the AI connection.",
      source: "failed",
      provider: connection.provider,
      model: connection.model,
      fallbackReason: "credential_error",
      toolCallsUsed: 0,
      toolCalls: [],
      drafts: [],
      integrityOk: true,
      integrityViolations: [],
      dataVersion: dataset.dataVersion,
    };
  }

  const baseUrl = connection.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL;
  const model = connection.model || (connection.provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENROUTER_MODEL);

  const adapter =
    connection.provider === "gemini"
      ? geminiAdapter({ question: MONITORING_QUESTION, systemInstruction: COPILOT_SYSTEM_PROMPT, tools: COPILOT_TOOLS, model, apiKey })
      : openRouterAdapter({ question: MONITORING_QUESTION, systemInstruction: COPILOT_SYSTEM_PROMPT, tools: COPILOT_TOOLS, model, apiKey, baseUrl });

  const run = await runToolLoop(adapter, {
    question: MONITORING_QUESTION,
    systemInstruction: COPILOT_SYSTEM_PROMPT,
    tools: COPILOT_TOOLS,
    dispatch,
    timeoutMs: MONITORING_TIMEOUT_MS,
  });

  if (!run.ok) {
    const fallback = plainCopilotText(answerDeterministically(MONITORING_QUESTION, ctx));
    const integrity = verifyNumericalIntegrity(fallback, bundle);
    return {
      answer: fallback,
      source: "deterministic",
      provider: connection.provider,
      model,
      fallbackReason: run.reason,
      toolCallsUsed: run.calls,
      toolCalls,
      drafts,
      integrityOk: integrity.ok,
      integrityViolations: integrity.violations.map((v) => v.message),
      dataVersion: dataset.dataVersion,
    };
  }

  const text = plainCopilotText(run.text);
  const integrity = verifyNumericalIntegrity(text, bundle);

  if (!integrity.ok) {
    // Withheld: fall back to deterministic with integrity violation noted
    const fallback = plainCopilotText(answerDeterministically(MONITORING_QUESTION, ctx));
    return {
      answer: fallback,
      source: "deterministic",
      provider: connection.provider,
      model: run.model,
      fallbackReason: "integrity_failure",
      toolCallsUsed: run.calls,
      toolCalls,
      drafts,
      integrityOk: false,
      integrityViolations: integrity.violations.map((v) => v.message),
      dataVersion: dataset.dataVersion,
    };
  }

  return {
    answer: text,
    source: "live_model",
    provider: run.provider,
    model: run.model,
    fallbackReason: null,
    toolCallsUsed: run.calls,
    toolCalls,
    drafts,
    integrityOk: true,
    integrityViolations: [],
    dataVersion: dataset.dataVersion,
  };
}

// ----------------------------------------------------------------- capability test

/**
 * Verify that the connection supports tool calling with a small synthetic
 * round trip containing no company financial data.
 * A plain text response (no tool call) is not sufficient.
 */
export async function testConnectionCapability(connection: AiConnection & { encryptedKey: string }, companyId: string): Promise<{ ok: boolean; detail: string }> {
  let apiKey: string;
  try {
    apiKey = decryptApiKey(connection.encryptedKey, companyId, connection.id);
  } catch {
    return { ok: false, detail: "Credential decryption failed" };
  }

  const TEST_TOOL = [{
    name: "echo_test",
    description: "TEST ONLY. Return the received value unchanged.",
    parameters: {
      type: "object" as const,
      properties: { value: { type: "string", description: "Value to echo" } },
      required: ["value"],
    },
  }];

  const toolCalled: { name: string; args: unknown }[] = [];
  const dispatch = async (name: string, args: Record<string, unknown>) => {
    toolCalled.push({ name, args });
    return { ok: true, output: { echoed: args.value } };
  };

  const baseUrl = connection.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL;
  const model = connection.model;

  const adapter =
    connection.provider === "gemini"
      ? geminiAdapter({ question: "Call echo_test with value='capability-check'.", systemInstruction: "You are a capability-check agent.", tools: TEST_TOOL, model, apiKey })
      : openRouterAdapter({ question: "Call echo_test with value='capability-check'.", systemInstruction: "You are a capability-check agent.", tools: TEST_TOOL, model, apiKey, baseUrl });

  try {
    const run = await runToolLoop(adapter, {
      question: "Call echo_test with value='capability-check'.",
      systemInstruction: "You are a capability-check agent.",
      tools: TEST_TOOL,
      dispatch,
    });

    if (!run.ok) return { ok: false, detail: run.detail.slice(0, 300) };
    if (toolCalled.length === 0) return { ok: false, detail: "Model responded without calling a tool — tool calling is not confirmed for this model" };
    return { ok: true, detail: `Tool calling confirmed (${toolCalled.length} call${toolCalled.length > 1 ? "s" : ""})` };
  } catch (err) {
    return { ok: false, detail: String(err instanceof Error ? err.message : err).slice(0, 300) };
  }
}
