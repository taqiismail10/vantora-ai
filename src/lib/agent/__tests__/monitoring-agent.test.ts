/**
 * Monitoring agent: isolation, stale-state detection and mocked-provider behavior.
 *
 * Tests:
 *   - Agent only runs on the company whose connection was resolved (isolation)
 *   - Agent falls back to deterministic when the provider fails
 *   - Fallback is clearly labelled (source: "deterministic")
 *   - Agent cannot approve or execute (Tier 2 tools are blocked)
 *   - Capability test passes when the mock calls the test tool
 *   - Capability test fails when the mock returns text only (no tool call)
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const TEST_KEY = randomBytes(32).toString("hex");
process.env.AI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY;
process.env.VANTORA_DB_PATH = ":memory:";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

import { setGeminiClientFactory } from "../gemini";
import { setOpenRouterFetch } from "../openrouter";
import { testConnectionCapability } from "../monitoring-agent";
import { createOrReplaceConnection, getConnectionWithKey, markConnectionTested } from "../../server/ai-connection";
import { db } from "../../server/db";
import type { AiConnection } from "../../server/ai-connection";

const COMPANY_ID = "monitor-test-co";

beforeAll(() => {
  db().prepare(`INSERT OR IGNORE INTO company (id, name, currency, status, is_demo, onboarding_step, created_at, created_by)
    VALUES (?, 'Monitor Test Co', 'USD', 'active', 0, 'done', ?, 'test')`).run(COMPANY_ID, Date.now());
  db().prepare(`INSERT OR IGNORE INTO company_account (id, company_id, name, opening_cents, as_of_date, created_at)
    VALUES ('acct-1', ?, 'Main', 50000000, ?, ?)`).run(COMPANY_ID, new Date().toISOString().slice(0, 10), Date.now());
});

function makeConnection(provider: "gemini" | "openrouter"): AiConnection & { encryptedKey: string } {
  const conn = createOrReplaceConnection({
    companyId: COMPANY_ID,
    provider,
    model: provider === "gemini" ? "gemini-2.0-flash" : "openai/gpt-4o-mini",
    apiKey: "test-key-xyz",
    createdBy: "owner",
  });
  markConnectionTested(COMPANY_ID);
  return { ...getConnectionWithKey(COMPANY_ID)!, ...conn };
}

describe("capability test", () => {
  it("passes when the mocked model calls the echo_test tool (Gemini)", async () => {
    const conn = makeConnection("gemini");
    let geminiCall = 0;
    setGeminiClientFactory(() => ({
      async generateContent() {
        geminiCall++;
        if (geminiCall === 1) {
          // Turn 1: request tool call. candidates[0].content required for history.
          return {
            functionCalls: [{ id: "call-1", name: "echo_test", args: { value: "capability-check" } }],
            text: undefined,
            candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call-1", name: "echo_test", args: { value: "capability-check" } } }] } }],
          };
        }
        // Turn 2: final text response so the loop exits with ok:true
        return { functionCalls: [], text: "Echoed: capability-check.", candidates: [] };
      },
    }));
    const result = await testConnectionCapability(conn, COMPANY_ID);
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/Tool calling confirmed/);
    setGeminiClientFactory(null);
  });

  it("fails when the mocked model returns text only (no tool call)", async () => {
    const conn = makeConnection("gemini");
    setGeminiClientFactory(() => ({
      async generateContent() {
        return { functionCalls: [], text: "Sure, I'll echo it: capability-check", candidates: [{ content: { role: "model", parts: [{ text: "Sure, I'll echo it: capability-check" }] } }] };
      },
    }));
    const result = await testConnectionCapability(conn, COMPANY_ID);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/without calling a tool/);
    setGeminiClientFactory(null);
  });

  it("passes when the mocked model calls the echo_test tool (OpenRouter)", async () => {
    const conn = makeConnection("openrouter");
    let orCall = 0;
    setOpenRouterFetch(async () => {
      orCall++;
      if (orCall === 1) {
        // Turn 1: request tool call
        const body = {
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call-1", type: "function", function: { name: "echo_test", arguments: JSON.stringify({ value: "capability-check" }) } }],
            },
          }],
        };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Turn 2: final text response so the loop exits with ok:true
      const body = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Echoed: capability-check.", tool_calls: [] } }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await testConnectionCapability(conn, COMPANY_ID);
    expect(result.ok).toBe(true);
    setOpenRouterFetch(null);
  });
});

describe("agent run isolation", () => {
  it("falls back to deterministic when provider fails, labels it clearly", async () => {
    const { runMonitoringAgent } = await import("../monitoring-agent");
    const conn = makeConnection("gemini");
    setGeminiClientFactory(() => ({
      async generateContent() {
        throw new Error("Simulated provider failure");
      },
    }));
    const { getCompany } = await import("../../server/companies");
    const company = getCompany(COMPANY_ID)!;
    const result = await runMonitoringAgent(company, conn);
    expect(result.source).toBe("deterministic");
    expect(result.fallbackReason).toBeTruthy();
    expect(result.answer).toBeTruthy();
    setGeminiClientFactory(null);
  });

  it("carries no demonstration memos into a real company's run", async () => {
    // Regression: the agent used to let loadCopilotContext fall back to the
    // named preset's memos, so a real company was screened against the demo
    // plant's counterparty notes — one of which is the planted injection
    // payload, which made the agent's own read_sme_profile come back
    // TIER_3 DENIED on a company that has no memos at all.
    const { runCopilotTool, loadCopilotContext } = await import("../vantora-copilot");
    const { companyDataset } = await import("../../server/company-state");
    const { getCompany } = await import("../../server/companies");

    const company = getCompany(COMPANY_ID)!;
    const dataset = companyDataset(company);
    const ctx = await loadCopilotContext(dataset.state ?? undefined, company.id, "SOLVABLE_DAY14_CRUNCH", {
      memos: {},
      planSlug: company.id,
      currency: dataset.company.currency,
    });
    expect(ctx.memos).toEqual({});

    // Asking for memos on a company that has none must stay a clean Tier 0 read.
    const result = await runCopilotTool({
      tool: "read_sme_profile",
      input: { include_memos: true },
      ctx,
      actorId: `monitor:${COMPANY_ID}`,
      actorType: "agent",
    });
    expect(result.gate.tier).toBe("TIER_0_AUTO_READ");
    expect(result.gate.decision).toBe("ALLOWED");
  });

  it("agent cannot approve or execute (Tier 2 tools blocked)", async () => {
    const { runCopilotTool, loadCopilotContext } = await import("../vantora-copilot");
    const ctx = await loadCopilotContext(undefined, COMPANY_ID);
    // execute_recovery_plan is Tier 2 — must be denied
    const result = await runCopilotTool({
      tool: "execute_recovery_plan",
      input: {},
      ctx,
      actorId: `monitor:${COMPANY_ID}`,
      actorType: "agent",
    });
    expect(result.ok).toBe(false);
    expect(result.gate.decision).toBe("DENIED");
  });
});
