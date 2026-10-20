/**
 * Provider selection and the OpenRouter adapter, driven through the real
 * `/api/copilot` route with a real session. No request leaves the process:
 * OpenRouter is a scripted `fetch`, Gemini a scripted client.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

import { POST as copilot } from "../../../app/api/copilot/route";
import { jsonRequest, signedInAs } from "../../server/__tests__/helpers";
import { setGeminiClientFactory } from "../gemini";
import { setRetryDelays } from "../llm";
import { setOpenRouterFetch } from "../openrouter";
import { aiConfig } from "../providers";

const OR_KEY = "sk-or-v1-TESTONLY0123456789abcdef";
const GEMINI_KEY = "AIzaTEST-not-a-real-key-0123456789";

let analyst: string;

beforeAll(async () => {
  analyst = await signedInAs("ANALYST");
});

const ENV_NAMES = ["AI_PROVIDER", "GEMINI_API_KEY", "GEMINI_MODEL", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENROUTER_BASE_URL"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  setRetryDelays([0, 0]);
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  setOpenRouterFetch(null);
  setGeminiClientFactory(null);
  setRetryDelays(null);
});

function useOpenRouter(model = "z-ai/glm-5.3-flash") {
  process.env.AI_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = OR_KEY;
  process.env.OPENROUTER_MODEL = model;
}

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

/** A fake OpenRouter that replays `replies` and records every request body and header set. */
function scriptOpenRouter(replies: Reply[]) {
  const requests: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  setOpenRouterFetch(async (url, init) => {
    requests.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const reply = replies.shift();
    if (!reply) throw new Error("script exhausted");
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers });
  });
  return requests;
}

const toolCall = (name: string, args: string, id = `call_${name}`): Reply => ({
  body: {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
          reasoning_details: [{ type: "reasoning.text", text: "kept verbatim" }],
        },
      },
    ],
  },
});
const text = (content: string): Reply => ({
  body: { choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] },
});

async function ask(question: string, extra: Record<string, unknown> = {}) {
  const response = await copilot(jsonRequest("/api/copilot", { question, ...extra }, analyst));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions read arbitrary JSON
  return (await response.json()) as Record<string, any>;
}

describe("provider configuration", () => {
  it("keeps Gemini as the default when AI_PROVIDER is absent", () => {
    expect(aiConfig({ GEMINI_API_KEY: "k" })).toMatchObject({ provider: "gemini", model: "gemini-3.1-flash-lite", configured: true, problem: null });
    expect(aiConfig({})).toMatchObject({ provider: "gemini", configured: false, problem: { reason: "not_configured" } });
  });

  it("validates only the selected provider, so the inactive key may be absent", () => {
    expect(aiConfig({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" })).toMatchObject({
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      configured: true,
    });
    expect(aiConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-x" })).toMatchObject({
      provider: "gemini",
      model: "gemini-x",
      configured: true,
    });
    expect(aiConfig({ AI_PROVIDER: " OpenRouter ", OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "openai/gpt-x" }).model).toBe("openai/gpt-x");
  });

  it("rejects an unsupported provider and an unsafe base URL with a clear message", () => {
    expect(aiConfig({ AI_PROVIDER: "anthropic", GEMINI_API_KEY: "k" })).toMatchObject({
      provider: null,
      configured: false,
      problem: { reason: "invalid_configuration", message: expect.stringMatching(/"gemini" or "openrouter"/) },
    });
    for (const url of ["http://openrouter.ai/api/v1", "not a url", "ftp://x"]) {
      expect(aiConfig({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: url }).problem?.reason).toBe(
        "invalid_configuration",
      );
    }
    expect(aiConfig({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: "http://localhost:4010/v1" }).configured).toBe(true);
  });

  it("never switches to the other provider: OpenRouter selected without its key is not configured, even with a Gemini key", async () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    setGeminiClientFactory(() => {
      throw new Error("Gemini must not be called");
    });
    const body = await ask("What if Zara declines?");
    expect(body).toMatchObject({ source: "deterministic", provider: "openrouter", fallback_reason: "not_configured" });
    expect(body.fallback_detail).toMatch(/OPENROUTER_API_KEY/);
  });

  it("answers from the labelled fallback when AI_PROVIDER is invalid", async () => {
    process.env.AI_PROVIDER = "claude";
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    const body = await ask("What if Zara declines?");
    expect(body).toMatchObject({ source: "deterministic", provider: null, fallback_reason: "invalid_configuration", attested: true });
  });
});

describe("OpenRouter tool-call loop", () => {
  it("runs a tool through the gate, matches the result by tool_call_id, and labels the provider and model", async () => {
    useOpenRouter("z-ai/glm-5.3-flash");
    const requests = scriptOpenRouter([
      toolCall("run_recovery_optimization", "{}"),
      text("If Zara declines, the re-solved plan costs $1,837.50, +$468.62 versus $1,368.88."),
    ]);
    const body = await ask("What if Zara declines?");

    expect(body).toMatchObject({ source: "openrouter", provider: "openrouter", model: "z-ai/glm-5.3-flash", attested: true });
    expect(body.tool_runs).toEqual([expect.objectContaining({ tool: "run_recovery_optimization", tier: "TIER_0_AUTO_READ", decision: "ALLOWED" })]);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(request.headers.Authorization).toBe(`Bearer ${OR_KEY}`);
      expect(request.body).toMatchObject({ model: "z-ai/glm-5.3-flash", tool_choice: "auto", max_tokens: 4096, provider: { require_parameters: true } });
      expect((request.body.tools as unknown[]).length).toBeGreaterThan(5);
    }
    const history = requests[1].body.messages as Record<string, unknown>[];
    expect(history[2]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_run_recovery_optimization" }], reasoning_details: [{ text: "kept verbatim" }] });
    expect(history[3]).toMatchObject({ role: "tool", tool_call_id: "call_run_recovery_optimization" });
    // The Zara-refusal fix holds on this adapter too: the branch reached the model as engine output.
    const output = JSON.parse(String(history[3].content)).output;
    expect(output.counterparty_fallbacks.find((b: { id: string }) => b.id === "buyer_declines")).toMatchObject({ total_cost: 1837.5, cost_delta: 468.62 });
  });

  it("withholds the unsupported lever-deleted $223.88 answer", async () => {
    useOpenRouter();
    scriptOpenRouter([toolCall("run_recovery_optimization", "{}"), text("Without Zara the remaining actions cost $223.88.")]);
    const body = await ask("What if Zara declines?");
    expect(body).toMatchObject({ source: "deterministic", provider: "openrouter", fallback_reason: "integrity_failure", attested: true });
    expect(body.fallback_detail).toMatch(/\$223\.88/);
    expect(body.answer).not.toMatch(/223\.88/);
  });

  it("refuses malformed arguments and unknown tools without running anything", async () => {
    useOpenRouter();
    const requests = scriptOpenRouter([
      toolCall("draft_customer_discount_offer", "{not json"),
      toolCall("wire_money_anywhere", "{}"),
      text("Nothing ran."),
    ]);
    const body = await ask("Draft the Zara offer");
    expect(body.tool_runs).toEqual([]);
    const tools = (n: number) => (requests[n].body.messages as { role: string; content: string }[]).filter((m) => m.role === "tool");
    expect(tools(1)[0].content).toMatch(/not valid JSON/);
    expect(tools(2)[1].content).toMatch(/unknown tool/);
  });

  it("reports a model without tool support as incompatible instead of pretending the tools ran", async () => {
    useOpenRouter("some/model-without-tools");
    scriptOpenRouter([
      { status: 404, body: { error: { code: 404, message: "No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing" } } },
    ]);
    const body = await ask("What if Zara declines?");
    expect(body).toMatchObject({ source: "deterministic", fallback_reason: "model_incompatible", model: null });
    expect(body.fallback_detail).toMatch(/tool-calling support/);
    expect(body.tool_runs).toEqual([]);
  });

  it("retries a transient failure, but not an authentication error, and never leaks the key", async () => {
    useOpenRouter();
    const transient = scriptOpenRouter([
      { status: 503, body: { error: { code: 503, message: "provider overloaded" } }, headers: { "retry-after": "0" } },
      text("Cash today is $52,000."),
    ]);
    expect(await ask("Where do I stand?")).toMatchObject({ source: "openrouter", attested: true });
    expect(transient).toHaveLength(2);

    const denied = scriptOpenRouter([{ status: 401, body: { error: { code: 401, message: `Invalid credentials for ${OR_KEY}` } } }]);
    const body = await ask("Where do I stand?");
    expect(denied).toHaveLength(1);
    expect(body).toMatchObject({ source: "deterministic", fallback_reason: "provider_error" });
    expect(JSON.stringify(body)).not.toContain(OR_KEY);
  });

  it("treats an error inside a 200 body as a provider error", async () => {
    useOpenRouter();
    scriptOpenRouter([{ body: { error: { code: 400, message: "invalid_prompt" } } }]);
    expect(await ask("Where do I stand?")).toMatchObject({ source: "deterministic", fallback_reason: "provider_error" });
  });
});

describe("Gemini through the shared loop", () => {
  it("retries a transient 503 and labels the answer Gemini", async () => {
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    let calls = 0;
    setGeminiClientFactory(() => ({
      generateContent: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("This model is currently experiencing high demand"), { status: 503 });
        return { text: "Cash today is $52,000.", candidates: [{ content: { role: "model", parts: [{ text: "Cash today is $52,000." }] } }] };
      },
    }));
    expect(await ask("Where do I stand?")).toMatchObject({ source: "gemini", provider: "gemini", model: "gemini-3.1-flash-lite" });
    expect(calls).toBe(2);
  });
});

describe("refusal answers come from the engine, per scenario", () => {
  it("does not reuse the baseline Zara figures under a stressed scenario", async () => {
    const stressed = await ask("What if Zara declines?", {
      scenario: { profile: "SOLVABLE_DAY14_CRUNCH", stress: { delayShift: 0, workforce: 150, rho: 0, priorExtensions: 0 } },
    });
    expect(stressed).toMatchObject({ source: "deterministic", attested: true });
    // A real Zara branch, re-solved for this scenario, not the baseline figures.
    expect(stressed.answer).toMatch(/Zara International declines: \$[\d,.]+, \+\$[\d,.]+/);
    expect(stressed.answer).not.toMatch(/1,837\.50|468\.62/);
    const baseline = await ask("What if Zara declines?");
    expect(baseline.answer).toMatch(/\$1,837\.50, \+\$468\.62/);
  });
});
