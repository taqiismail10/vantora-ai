/**
 * Google Gemini adapter (`AI_PROVIDER=gemini`, the default).
 *
 *   model     GEMINI_MODEL (default gemini-3.1-flash-lite)
 *   secret    GEMINI_API_KEY, server-only; never sent to the browser or a log
 *
 * Only the wire format lives here; the loop, bounds, retries and dispatch are
 * shared (`llm.ts`). The model's own content is appended to the history
 * verbatim on every turn, which keeps Gemini's thought signatures attached to
 * the function calls they belong to. Each call is answered with a
 * `functionResponse` that carries the call's `id` and `name`.
 */

import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";

import { ProviderError, runToolLoop, type LoopInput, type ModelRun, type ProviderAdapter, type ToolDispatch } from "./llm";

export { sanitizeProviderError, validateToolArgs, type FallbackReason, type ToolDispatch } from "./llm";

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

/** The slice of the SDK this module uses, so tests can drive it without a network. */
export interface GeminiModels {
  generateContent(params: {
    model: string;
    contents: Content[];
    config: {
      systemInstruction: string;
      tools: { functionDeclarations: FunctionDeclaration[] }[];
      temperature: number;
      abortSignal?: AbortSignal;
    };
  }): Promise<{
    functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[];
    text?: string;
    candidates?: { content?: Content }[];
  }>;
}

let factory: (() => GeminiModels) | null = null;

/** Test seam. Pass null to restore the real SDK client. */
export function setGeminiClientFactory(next: (() => GeminiModels) | null) {
  factory = next;
}

function client(apiKey: string): GeminiModels {
  if (factory) return factory();
  // SDK-level retries stay off: the shared loop owns the retry policy.
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 20_000 } });
  return { generateContent: (params) => ai.models.generateContent(params) };
}

export function geminiAdapter(input: LoopInput & { model: string; apiKey: string }): ProviderAdapter {
  const declarations: FunctionDeclaration[] = input.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parameters,
  }));
  const contents: Content[] = [{ role: "user", parts: [{ text: input.question }] }];
  const api = client(input.apiKey);

  return {
    provider: "gemini",
    model: input.model,
    async complete(signal) {
      const response = await api.generateContent({
        model: input.model,
        contents,
        config: {
          systemInstruction: input.systemInstruction,
          tools: [{ functionDeclarations: declarations }],
          temperature: 0.2,
          abortSignal: signal,
        },
      });
      const requested = response.functionCalls ?? [];
      if (requested.length) {
        const modelContent = response.candidates?.[0]?.content;
        if (!modelContent) throw new ProviderError("function calls without model content", "malformed");
        contents.push(modelContent);
      }
      return {
        text: response.text ?? null,
        calls: requested.map((call) => ({ id: call.id, name: call.name ?? "", args: call.args ?? {} })),
      };
    },
    respond(results) {
      const parts: Part[] = results.map(({ call, response }) => ({
        functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: response as Record<string, unknown> },
      }));
      contents.push({ role: "user", parts });
    },
  };
}

/** The Gemini loop on its own, with the model and key from the environment. */
export function runGeminiToolLoop(options: LoopInput & { dispatch: ToolDispatch; timeoutMs?: number }): Promise<ModelRun> {
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  return runToolLoop(geminiAdapter({ ...options, model, apiKey: process.env.GEMINI_API_KEY ?? "" }), options);
}
