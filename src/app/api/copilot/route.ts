/**
 * POST /api/copilot — interactive Q&A with the Vantora Copilot.
 *
 * `askCopilot` runs the Anthropic tool-use loop when ANTHROPIC_API_KEY is set
 * and the deterministic synthesiser otherwise. Either way the answer is only
 * returned after every dollar figure and percentage in it has been verified
 * against the quant engine's own output.
 */

import { NextResponse } from "next/server";

import { askCopilot, loadCopilotContext } from "@/lib/agent/vantora-copilot";
import { parseScenarioPresetId, seedSandboxDataset } from "@/lib/sandbox/seed-data";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    question?: string;
    actorId?: string;
    userApprovalToken?: string;
    /** Which sandbox SME to answer about. Unrecognised values fall back to Apex. */
    profile?: string;
  };

  const question = (body.question ?? "").trim();
  if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

  const profile = parseScenarioPresetId(body.profile ?? new URL(request.url).searchParams.get("profile"));
  const seed = await seedSandboxDataset(profile);
  const ctx = await loadCopilotContext(undefined, seed.smeProfileId, profile);
  const turn = await askCopilot({
    question,
    ctx,
    actorId: body.actorId ?? "vantora-copilot",
    userApprovalToken: body.userApprovalToken,
  });

  return NextResponse.json({
    question,
    answer: turn.answer,
    source: turn.source,
    model: turn.model,
    // `attested` is what the UI badge reads: the answer cleared the check, it
    // was not merely produced.
    attested: turn.numericalIntegrity.ok,
    numericalIntegrity: turn.numericalIntegrity,
    tool_runs: turn.toolRuns.map((run) => ({
      tool: run.tool,
      tier: run.gate.tier,
      decision: run.gate.decision,
      reason: run.gate.reason,
      seq: run.gate.auditEntry.seq,
    })),
    plan_id: ctx.planId,
  });
}
