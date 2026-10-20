/**
 * Which model provider answers the copilot, from server-side environment only.
 *
 *   AI_PROVIDER=gemini      (default when unset)  GEMINI_API_KEY, GEMINI_MODEL
 *   AI_PROVIDER=openrouter                        OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_BASE_URL
 *
 * Only the selected provider's settings are validated; the other provider's
 * key may be present or absent. An unsupported AI_PROVIDER is a configuration
 * error the copilot reports (it answers from the labelled deterministic
 * fallback); it never falls through to another provider. The environment is
 * read per request, so a restart after editing `.env` is all a switch needs.
 */

import { DEFAULT_GEMINI_MODEL, geminiAdapter } from "./gemini";
import { PROVIDER_LABEL, runToolLoop, type LoopInput, type ModelRun, type ProviderId, type ToolDispatch } from "./llm";
import { DEFAULT_OPENROUTER_BASE_URL, DEFAULT_OPENROUTER_MODEL, openRouterAdapter } from "./openrouter";

export { PROVIDER_LABEL, type ProviderId };

export interface AiConfig {
  /** Null only when AI_PROVIDER names something unsupported. */
  provider: ProviderId | null;
  model: string | null;
  /** The selected provider has what it needs to be called. */
  configured: boolean;
  /** Why the copilot cannot call a model, in words the owner can act on. Never contains a secret. */
  problem: { reason: "not_configured" | "invalid_configuration"; message: string } | null;
}

type Env = Record<string, string | undefined>;

const value = (env: Env, name: string) => env[name]?.trim() || "";

function validBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return url.protocol === "https:" || (url.protocol === "http:" && local);
  } catch {
    return false;
  }
}

export function aiConfig(env: Env = process.env): AiConfig {
  const selected = value(env, "AI_PROVIDER").toLowerCase() || "gemini";

  if (selected === "gemini") {
    const model = value(env, "GEMINI_MODEL") || DEFAULT_GEMINI_MODEL;
    const key = value(env, "GEMINI_API_KEY");
    return {
      provider: "gemini",
      model,
      configured: Boolean(key),
      problem: key ? null : { reason: "not_configured", message: "GEMINI_API_KEY is not set on the server" },
    };
  }

  if (selected === "openrouter") {
    const model = value(env, "OPENROUTER_MODEL") || DEFAULT_OPENROUTER_MODEL;
    const baseUrl = value(env, "OPENROUTER_BASE_URL") || DEFAULT_OPENROUTER_BASE_URL;
    if (!validBaseUrl(baseUrl)) {
      return {
        provider: "openrouter",
        model,
        configured: false,
        problem: {
          reason: "invalid_configuration",
          message: "OPENROUTER_BASE_URL must be an https URL (http is allowed only for localhost)",
        },
      };
    }
    const key = value(env, "OPENROUTER_API_KEY");
    return {
      provider: "openrouter",
      model,
      configured: Boolean(key),
      problem: key ? null : { reason: "not_configured", message: "OPENROUTER_API_KEY is not set on the server" },
    };
  }

  return {
    provider: null,
    model: null,
    configured: false,
    problem: {
      reason: "invalid_configuration",
      message: `AI_PROVIDER="${selected.slice(0, 40)}" is not supported; set it to "gemini" or "openrouter"`,
    },
  };
}

/** Run the copilot loop on the configured provider. Callers check `aiConfig().configured` first. */
export function runCopilotModel(options: LoopInput & { dispatch: ToolDispatch; timeoutMs?: number }): Promise<ModelRun> {
  const config = aiConfig();
  if (!config.configured || !config.provider || !config.model) {
    return Promise.resolve({
      ok: false,
      reason: config.problem?.reason ?? "not_configured",
      detail: config.problem?.message ?? "no AI provider is configured",
      calls: 0,
    });
  }
  const adapter =
    config.provider === "gemini"
      ? geminiAdapter({ ...options, model: config.model, apiKey: value(process.env, "GEMINI_API_KEY") })
      : openRouterAdapter({
          ...options,
          model: config.model,
          apiKey: value(process.env, "OPENROUTER_API_KEY"),
          baseUrl: value(process.env, "OPENROUTER_BASE_URL") || DEFAULT_OPENROUTER_BASE_URL,
        });
  return runToolLoop(adapter, options);
}

/** "Gemini · gemini-3.1-flash-lite" — for logs and labels. */
export function providerLabel(config: AiConfig): string {
  return config.provider ? `${PROVIDER_LABEL[config.provider]} · ${config.model}` : "no provider";
}
