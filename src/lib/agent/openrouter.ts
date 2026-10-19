/**
 * OpenRouter adapter (`AI_PROVIDER=openrouter`).
 *
 *   model     OPENROUTER_MODEL (any OpenRouter model id that supports tool calling)
 *   secret    OPENROUTER_API_KEY, server-only; sent only as the Authorization header
 *   endpoint  OPENROUTER_BASE_URL (default https://openrouter.ai/api/v1) + /chat/completions
 *
 * OpenAI-style function calling, per OpenRouter's tool-calling guide: `tools`
 * goes on every request, the assistant message that carries `tool_calls` is
 * appended to the history as returned (so any `reasoning_details` stay with
 * it), and each call is answered by a `role: "tool"` message with the matching
 * `tool_call_id`. `provider.require_parameters` makes OpenRouter route only to
 * endpoints that honour `tools`; a model with none answers 404 ("No endpoints
 * found that support tool use"), which is reported as `model_incompatible`
 * rather than letting a tool-less model pretend it ran the engine.
 *
 * OpenRouter can also report a failure inside a 200 body (`error`, or a choice
 * with `finish_reason: "error"`), so the body is checked, not just the status.
 * Only the wire format lives here; the loop, bounds, retries and dispatch are
 * shared (`llm.ts`).
 */

import { ProviderError, sanitizeProviderError, type LoopInput, type ModelCall, type ProviderAdapter } from "./llm";

export const DEFAULT_OPENROUTER_MODEL = "z-ai/glm-5.3-flash";
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// Without a cap OpenRouter reserves the model's full output window per request
// (131,072 tokens for some models), which a small credit balance refuses with
// 402 and which is never needed for a briefing. ponytail: fixed cap; make it
// configurable if a reasoning model runs out of room ("empty_response").
const MAX_OUTPUT_TOKENS = 4096;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetch | null = null;

/** Test seam. Pass null to restore the global `fetch`. */
export function setOpenRouterFetch(next: Fetch | null) {
  fetcher = next;
}

interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  [extra: string]: unknown;
}

interface ChatError {
  code?: number | string;
  message?: string;
  metadata?: { error_type?: string };
}

function failure(status: number | null, error: ChatError | undefined, retryAfter: string | null): ProviderError {
  const code = typeof error?.code === "number" ? error.code : status;
  const type = error?.metadata?.error_type;
  const message = sanitizeProviderError(
    `OpenRouter ${code ?? "error"}${type ? ` (${type})` : ""}: ${error?.message ?? "no error message"}`,
  );
  if (code === 404 || /support tool use/i.test(error?.message ?? "")) {
    return new ProviderError(`${message} — OPENROUTER_MODEL must name a model with tool-calling support`, "incompatible");
  }
  if (code !== null && [408, 429, 500, 502, 503, 504].includes(code)) {
    const seconds = Number(retryAfter);
    return new ProviderError(message, "transient", Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
  }
  return new ProviderError(message, "permanent");
}

function parseCall(call: ChatToolCall): ModelCall {
  const name = call.function?.name ?? "";
  const raw = call.function?.arguments ?? "";
  if (raw.trim() === "") return { id: call.id, name, args: {} };
  try {
    return { id: call.id, name, args: JSON.parse(raw) };
  } catch {
    return { id: call.id, name, args: undefined, argsError: "arguments are not valid JSON" };
  }
}

export function openRouterAdapter(
  input: LoopInput & { model: string; apiKey: string; baseUrl: string },
): ProviderAdapter {
  const tools = input.tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const messages: ChatMessage[] = [
    { role: "system", content: input.systemInstruction },
    { role: "user", content: input.question },
  ];
  const url = `${input.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    provider: "openrouter",
    model: input.model,
    async complete(signal) {
      const response = await (fetcher ?? fetch)(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Vantora AI",
        },
        body: JSON.stringify({
          model: input.model,
          messages,
          tools,
          tool_choice: "auto",
          temperature: 0.2,
          max_tokens: MAX_OUTPUT_TOKENS,
          provider: { require_parameters: true },
        }),
        signal,
      });
      const body = (await response.json().catch(() => null)) as {
        error?: ChatError;
        choices?: { message?: ChatMessage; finish_reason?: string; error?: ChatError }[];
      } | null;
      if (!response.ok || body?.error) throw failure(response.status, body?.error, response.headers.get("retry-after"));

      const choice = body?.choices?.[0];
      if (!choice?.message) throw new ProviderError("OpenRouter returned no choice", "malformed");
      if (choice.finish_reason === "error" || choice.error) throw failure(null, choice.error, null);

      const message = choice.message;
      const calls = (message.tool_calls ?? []).map(parseCall);
      if (calls.some((call) => !call.id)) throw new ProviderError("OpenRouter returned a tool call without an id", "malformed");
      if (calls.length) messages.push({ ...message, role: "assistant", content: message.content ?? null });
      return { text: typeof message.content === "string" ? message.content : null, calls };
    },
    respond(results) {
      for (const { call, response } of results) {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(response) });
      }
    },
  };
}
