/**
 * POST /api/copilot — one question to the Vantora Copilot. ANALYST or OWNER.
 *
 * Gemini answers when GEMINI_API_KEY is configured and the call succeeds; the
 * deterministic synthesiser answers otherwise, and the response says which
 * (`source`, `model`, `fallback_reason`). Every model-requested tool runs
 * through `agentDispatcher` under the signed-in human's authority, capped at
 * the copilot's own service capabilities.
 */

import { NextResponse } from "next/server";

import { askCopilot } from "@/lib/agent/ask";
import { agentDispatcher } from "@/lib/server/agent-tools";
import {
  AccessError,
  AGENT_ID,
  assertSameOrigin,
  auditActorId,
  rejectIdentityFields,
  requireActor,
} from "@/lib/server/identity";
import { loadPlanContext, parseScenarioRef } from "@/lib/server/plan";

const MAX_QUESTION = 1_000;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    rejectIdentityFields(body);
    if (body.userApprovalToken !== undefined) {
      throw new AccessError(400, "the copilot never receives approval tokens");
    }
    const question = typeof body.question === "string" ? body.question.trim().slice(0, MAX_QUESTION) : "";
    if (!question) throw new AccessError(400, "question is required");

    const actor = await requireActor(request, "analyze");
    const plan = await loadPlanContext(actor.businessId, parseScenarioRef(body.scenario));
    const turn = await askCopilot({
      question,
      ctx: plan.ctx,
      dispatch: agentDispatcher(actor, plan),
      actorLabel: `${AGENT_ID} (for ${auditActorId(actor)})`,
    });

    return NextResponse.json({
      question,
      answer: turn.answer,
      source: turn.source,
      model: turn.model,
      provider: turn.provider,
      fallback_reason: turn.fallback_reason,
      fallback_detail: turn.fallback_detail,
      // `attested` is what the UI badge reads: the answer cleared the check, it
      // was not merely produced.
      attested: turn.numericalIntegrity.ok,
      numericalIntegrity: turn.numericalIntegrity,
      tool_runs: turn.toolRuns,
      plan_id: plan.ctx.planId,
      plan_version: plan.planVersion,
    });
  } catch (error) {
    if (error instanceof AccessError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
