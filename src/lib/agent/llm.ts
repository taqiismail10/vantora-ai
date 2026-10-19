/**
 * The provider-neutral copilot tool loop.
 *
 * Every provider (`gemini.ts`, `openrouter.ts`) is a thin adapter that only
 * translates wire formats: it keeps its own conversation state, turns one
 * model reply into text plus tool calls, and appends tool results the way its
 * API requires. Everything that decides whether something happens lives here
 * and is shared: the turn and call bounds, the per-request timeout, transient
 * retries, argument validation against the declared schema, unknown-tool
 * refusal, and handing each call to `dispatch` — which applies the same policy
 * as a direct API request. The model never sees an approval secret or an
 * approver identity; it can only name a tool and supply arguments.
 *
 * Retries are safe because they repeat a *model request*, never a tool: a tool
 * runs only from a reply this loop has already received and answered, and a
 * failed request produced no reply. Tier 2 execution is still deduplicated by
 * the approval service.
 */

import type { ToolDeclaration } from "./vantora-copilot";

export type ProviderId = "gemini" | "openrouter";

export const PROVIDER_LABEL: Record<ProviderId, string> = { gemini: "Gemini", openrouter: "OpenRouter" };

export type FallbackReason =
  | "not_configured"
  | "invalid_configuration"
  | "provider_error"
  | "model_incompatible"
  | "timeout"
  | "empty_response"
  | "malformed_response"
  | "tool_loop_limit"
  | "integrity_failure";

export interface DispatchResult {
  ok: boolean;
  output: unknown;
}

export type ToolDispatch = (name: string, args: Record<string, unknown>) => Promise<DispatchResult>;

/** One tool call as the model asked for it. `argsError` is set when the arguments did not even parse. */
export interface ModelCall {
  id: string | undefined;
  name: string;
  args: unknown;
  argsError?: string;
}

export interface ModelTurn {
  text: string | null;
  calls: ModelCall[];
}

export interface ToolResult {
  call: ModelCall;
  response: { output: unknown } | { error: unknown };
}

/** One conversation with one provider. Created per question; holds that provider's history. */
export interface ProviderAdapter {
  provider: ProviderId;
  model: string;
  /** Send the conversation so far and return the model's reply. Must honour `signal`. */
  complete(signal: AbortSignal): Promise<ModelTurn>;
  /** Append the answers to the calls of the last reply, matched by call id. */
  respond(results: ToolResult[]): void;
}

export interface LoopInput {
  question: string;
  systemInstruction: string;
  tools: ToolDeclaration[];
}

export type ModelRun =
  | { ok: true; text: string; provider: ProviderId; model: string; calls: number }
  | { ok: false; reason: FallbackReason; detail: string; calls: number };

/** A provider failure the adapter has already classified. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "transient" | "permanent" | "incompatible" | "malformed",
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const TIMEOUT_MS = 20_000;
const MAX_TURNS = 5;
const MAX_CALLS_PER_TURN = 6;
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 5_000;
let retryDelaysMs = [500, 1500];

/** Test seam: the backoff between attempts (its length is the number of retries). */
export function setRetryDelays(delays: number[] | null) {
  retryDelaysMs = delays ?? [500, 1500];
}

/** Map anything an SDK or `fetch` threw onto the three outcomes the loop cares about. */
export function classifyError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : null;
  const message = sanitizeProviderError(error);
  if (status !== null) {
    if (TRANSIENT_STATUS.has(status)) return new ProviderError(message, "transient");
    if (status === 404 || /function calling|tool use|tools? (are|is) not supported/i.test(message)) {
      return new ProviderError(message, "incompatible");
    }
    return new ProviderError(message, "permanent");
  }
  // Network failures (DNS, reset, refused) reach us as TypeError from fetch or a coded Error.
  const code = (error as { code?: unknown; cause?: { code?: unknown } })?.code ?? (error as { cause?: { code?: unknown } })?.cause?.code;
  if (error instanceof TypeError || (typeof code === "string" && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR)/.test(code))) {
    return new ProviderError(message, "transient");
  }
  return new ProviderError(message, "permanent");
}

/** Minimal JSON-Schema check for the flat schemas Vantora's tools declare. */
export function validateToolArgs(declaration: ToolDeclaration, args: unknown): string | null {
  if (args === undefined) args = {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const record = args as Record<string, unknown>;
  const properties = declaration.parameters.properties;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(properties, key)) return `unexpected argument "${key}"`;
  }
  for (const key of declaration.parameters.required ?? []) {
    if (record[key] === undefined) return `missing required argument "${key}"`;
  }
  for (const [key, value] of Object.entries(record)) {
    const type = properties[key].type;
    const ok =
      type === "array"
        ? Array.isArray(value)
        : type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : typeof value === type;
    if (!ok) return `argument "${key}" must be a ${type}`;
  }
  return null;
}

/** Provider errors can echo request details; keep the class and status, drop anything key-like. */
export function sanitizeProviderError(error: unknown): string {
  let text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const key of [process.env.GEMINI_API_KEY, process.env.OPENROUTER_API_KEY]) {
    if (key) text = text.split(key).join("[redacted]");
  }
  text = text
    .replace(/([?&]key=)[^&\s"]+/gi, "$1[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/sk-or-[0-9A-Za-z_-]{10,}/g, "[redacted]")
    .replace(/(Bearer\s+)[^\s"]+/gi, "$1[redacted]");
  return text.slice(0, 300);
}

class Timeout extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function completeOnce(adapter: ProviderAdapter, timeoutMs: number): Promise<ModelTurn> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    adapter.complete(controller.signal),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Timeout(`no response within ${timeoutMs} ms`));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** One model request, retried only on transient failures. A timeout is final: it bounds latency. */
async function complete(adapter: ProviderAdapter, timeoutMs: number): Promise<ModelTurn> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await completeOnce(adapter, timeoutMs);
    } catch (error) {
      if (error instanceof Timeout) throw error;
      const failure = classifyError(error);
      if (failure.kind !== "transient" || attempt >= retryDelaysMs.length) throw failure;
      await sleep(Math.min(failure.retryAfterMs ?? retryDelaysMs[attempt], MAX_RETRY_AFTER_MS));
    }
  }
}

export async function runToolLoop(
  adapter: ProviderAdapter,
  options: LoopInput & { dispatch: ToolDispatch; timeoutMs?: number },
): Promise<ModelRun> {
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  let calls = 0;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const reply = await complete(adapter, timeoutMs);
      if (reply.calls.length === 0) {
        const text = reply.text?.trim();
        return text
          ? { ok: true, text, provider: adapter.provider, model: adapter.model, calls }
          : { ok: false, reason: "empty_response", detail: "the model returned no text", calls };
      }

      const results: ToolResult[] = [];
      for (const [index, call] of reply.calls.entries()) {
        const declaration = byName.get(call.name);
        let response: ToolResult["response"];
        if (index >= MAX_CALLS_PER_TURN) {
          response = { error: `more than ${MAX_CALLS_PER_TURN} tool calls in one turn; this one was not run` };
        } else if (!declaration) {
          response = { error: `unknown tool "${call.name.slice(0, 60)}"` };
        } else {
          const problem = call.argsError ?? validateToolArgs(declaration, call.args);
          if (problem) {
            response = { error: `invalid arguments: ${problem}` };
          } else {
            calls += 1;
            const result = await options.dispatch(call.name, (call.args ?? {}) as Record<string, unknown>);
            response = result.ok ? { output: result.output } : { error: result.output };
          }
        }
        results.push({ call, response });
      }
      adapter.respond(results);
    }
    return { ok: false, reason: "tool_loop_limit", detail: `stopped after ${MAX_TURNS} model turns`, calls };
  } catch (error) {
    if (error instanceof Timeout) return { ok: false, reason: "timeout", detail: error.message, calls };
    const failure = classifyError(error);
    const reason: FallbackReason =
      failure.kind === "incompatible" ? "model_incompatible" : failure.kind === "malformed" ? "malformed_response" : "provider_error";
    return { ok: false, reason, detail: failure.message, calls };
  }
}
