/**
 * One copilot question, end to end.
 *
 * The configured provider (`AI_PROVIDER`: Gemini or OpenRouter) answers when it
 * is configured and succeeds; otherwise the deterministic synthesiser does, and
 * the turn says which and why. A failure never switches to another provider or
 * model. Whatever
 * produced the text, it leaves here only after `verifyNumericalIntegrity` has
 * matched every dollar figure and percentage against the engine output.
 */

import { enforcePermissionGate, verifyNumericalIntegrity, type NumericalIntegrityResult } from "../security/permission-gate";
import { sanitizeProviderError, type FallbackReason, type ProviderId, type ToolDispatch } from "./llm";
import { aiConfig, providerLabel, runCopilotModel } from "./providers";
import {
  answerDeterministically,
  attestationBundle,
  COPILOT_SYSTEM_PROMPT,
  COPILOT_TOOLS,
  type CopilotContext,
} from "./vantora-copilot";

export interface ToolRunSummary {
  tool: string;
  tier: string;
  decision: string;
  reason: string;
  seq: number | null;
}

export interface CopilotTurn {
  answer: string;
  /** The provider that produced the answer, or "deterministic". */
  source: ProviderId | "deterministic";
  /** Set only when that provider's model actually produced the answer. */
  model: string | null;
  /** The configured provider, whether or not it answered (null when AI_PROVIDER is invalid). */
  provider: ProviderId | null;
  fallback_reason: FallbackReason | null;
  /** Sanitised provider detail when the model was unavailable; never contains the key. */
  fallback_detail: string | null;
  numericalIntegrity: NumericalIntegrityResult;
  toolRuns: ToolRunSummary[];
}

export async function askCopilot(options: {
  question: string;
  ctx: CopilotContext;
  /** Runs one model-requested tool under the caller's authority. */
  dispatch: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; output: unknown; summary: ToolRunSummary }>;
  actorLabel: string;
}): Promise<CopilotTurn> {
  const { question, ctx } = options;
  const bundle = attestationBundle(ctx);
  const toolRuns: ToolRunSummary[] = [];
  const config = aiConfig();

  const deterministic = (reason: FallbackReason, detail: string | null): CopilotTurn => {
    const answer = plainCopilotText(answerDeterministically(question, ctx));
    return {
      answer,
      source: "deterministic",
      model: null,
      provider: config.provider,
      fallback_reason: reason,
      fallback_detail: detail,
      numericalIntegrity: verifyNumericalIntegrity(answer, bundle),
      toolRuns,
    };
  };

  if (config.problem) {
    if (config.problem.reason === "invalid_configuration") console.error(`[copilot] configuration: ${config.problem.message}`);
    return deterministic(config.problem.reason, config.problem.message);
  }

  const dispatch: ToolDispatch = async (name, args) => {
    const run = await options.dispatch(name, args);
    toolRuns.push(run.summary);
    return { ok: run.ok, output: run.output };
  };

  const run = await runCopilotModel({
    question,
    systemInstruction: COPILOT_SYSTEM_PROMPT,
    tools: COPILOT_TOOLS,
    dispatch,
  });

  if (!run.ok) {
    console.warn(`[copilot] ${providerLabel(config)} unavailable (${run.reason}): ${run.detail}`);
    return deterministic(run.reason, run.detail);
  }

  // The answer is fought over here once: it is stripped of markdown markers
  // before the integrity check, so what is verified is exactly what is shown.
  // The withheld raw text below still carries the markers — it is evidence,
  // never displayed.
  const text = plainCopilotText(run.text);
  const integrity = verifyNumericalIntegrity(text, bundle);
  if (!integrity.ok) {
    // The chain keeps only a digest of the withheld text; the server log keeps
    // enough to diagnose it: each rejected figure in its sentence, and the tools
    // the model saw. Key-shaped strings are redacted.
    console.warn(
      `[copilot] ${providerLabel(config)} answer withheld (integrity_failure); tools: ${
        toolRuns.map((t) => t.tool).join(", ") || "none"
      }`,
    );
    for (const violation of integrity.violations) {
      console.warn(`[copilot]   ${violation.message} — "…${sanitizeProviderError(figureContext(run.text, violation.value))}…"`);
    }
    // The model's text is withheld, and the refusal is evidence in the chain.
    await enforcePermissionGate({
      operation: "draft_recovery_plan_summary",
      actorId: options.actorLabel,
      actorType: "agent",
      payload: run.text,
      quantEngineOutput: bundle,
      smeProfileId: ctx.smeProfileId,
      recoveryPlanId: ctx.planId,
    });
    return deterministic(
      "integrity_failure",
      integrity.violations.map((v) => v.message).join("; ").slice(0, 300),
    );
  }

  return {
    answer: text,
    source: run.provider,
    model: run.model,
    provider: run.provider,
    fallback_reason: null,
    fallback_detail: null,
    numericalIntegrity: integrity,
    toolRuns,
  };
}

/** The text around the first occurrence of a figure ("1,234.5" or "1234.5"), for the server log. */
export function figureContext(text: string, value: number | undefined, radius = 120): string {
  if (value === undefined) return text.slice(0, radius * 2);
  const plain = String(Math.abs(value));
  const [int, frac] = plain.split(".");
  const grouped = Number(int).toLocaleString("en-US") + (frac ? `.${frac}` : "");
  const at = [grouped, plain].map((form) => text.indexOf(form)).find((i) => i >= 0) ?? 0;
  return text.slice(Math.max(0, at - radius), at + radius).replace(/\s+/g, " ");
}

/**
 * Every surface that shows a copilot answer renders plain text — the draft
 * bodies are emails sent by people — but models still decorate like a chat
 * app: "### Heading", "**bold**", fenced code blocks. Rendered literally,
 * those markers are junk in a CFO briefing and an outbound email.
 *
 * Markdown syntax is therefore removed before `verifyNumericalIntegrity` and
 * display, so the verified text and the displayed text are the same string.
 * Only wrapping markers are removed — heading hashes, emphasis stars, code
 * ticks — never wording, figures, line breaks or underscores (tool names like
 * `run_recovery_optimization` contain real underscores and must survive).
 * A leading "#12" reference is safe: the pattern needs the hash run followed
 * by whitespace, so "#12 " does not match. Idempotent, and a no-op on the
 * already-plain deterministic answers.
 */
export function plainCopilotText(text: string): string {
  return text
    .replace(/^#{1,6}(?:\s+|$)/gm, "") // "### Summary" -> "Summary"; stray fence-like "#" line dropped
    .replace(/^`{3,}[\w-]*[ \t]*\n?/gm, "") // code-fence lines (```…```) removed, block content kept
    .replace(/\*{2,}([^*\n]+?)\*{2,}/g, "$1") // "**Plan cost**" -> "Plan cost"
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, "$1$2") // "*see below*" -> "see below"; a*2 stays
    .replace(/^([ \t]*)\*(?=\s)/gm, "$1-") // "* item" -> "- item", keeping the indent
    .replace(/`([^`\n]+?)`/g, "$1"); // `run_recovery_optimization` -> run_recovery_optimization
}
