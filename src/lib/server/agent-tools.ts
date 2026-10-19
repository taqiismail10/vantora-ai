/**
 * What happens when the model asks for a tool.
 *
 * The copilot acts as the service identity `vantora-copilot`, on behalf of the
 * signed-in human it is answering. It holds at most `AGENT_CAPABILITIES`
 * (read, analyze, draft) intersected with that human's role, so it can never
 * approve anything. A Tier 2 tool runs only through `executeApproval` with an
 * agent executor, which succeeds only if the same owner already minted an
 * approval for exactly that action and delegated it to the copilot.
 */

import type { ToolRunSummary } from "../agent/ask";
import { runCopilotTool } from "../agent/vantora-copilot";
import { logOperation } from "../sandbox/execution-logger";
import { classifyOperation, PERMISSION_TIERS } from "../security/permission-gate";
import { executeApproval, type ApprovalTarget } from "./approvals";
import { AccessError, AGENT_CAPABILITIES, AGENT_ID, auditActorId, can, type Capability, type HumanActor } from "./identity";
import { parseCents } from "./money";
import { loadPlanContext, matchProposal, type PlanContext } from "./plan";

const TIER_CAPABILITY: Record<string, Capability> = {
  [PERMISSION_TIERS.TIER_0_AUTO_READ]: "analyze",
  [PERMISSION_TIERS.TIER_1_DRAFT_ONLY]: "draft",
};

export function agentDispatcher(actor: HumanActor, initial: PlanContext) {
  let plan = initial;
  const label = `${AGENT_ID} (for ${auditActorId(actor)})`;

  const refuse = async (tool: string, tier: string, reason: string) => {
    const entry = await logOperation({
      actorId: label,
      actorType: "agent",
      operation: tool,
      tier: tier as never,
      decision: "DENIED",
      reason,
      payload: { tool },
      smeProfileId: plan.ctx.smeProfileId,
      recoveryPlanId: plan.ctx.planId,
    });
    return {
      ok: false,
      output: reason,
      summary: { tool, tier, decision: "DENIED", reason, seq: entry.seq } satisfies ToolRunSummary,
    };
  };

  return async (tool: string, args: Record<string, unknown>) => {
    const tier = classifyOperation(tool);

    if (tier === PERMISSION_TIERS.TIER_2_HITL_APPROVAL) {
      let target: ApprovalTarget;
      if (tool === "execute_recovery_plan") {
        target = { kind: "plan" };
      } else {
        const match = matchProposal(plan, tool, args, parseCents);
        if ("error" in match) return refuse(tool, tier, `copilot request refused: ${match.error}`);
        target = { kind: "action", actionKey: match.spec.action_key };
      }
      try {
        const result = await executeApproval({ kind: "agent", onBehalfOf: actor }, plan, target);
        if (result.ok) plan = await loadPlanContext(plan.businessId, plan.ref);
        return {
          ok: result.ok,
          output: { decision: result.decision, reason: result.reason, seq: result.seq },
          summary: { tool, tier: result.tier, decision: result.decision, reason: result.reason, seq: result.seq },
        };
      } catch (error) {
        if (error instanceof AccessError) return refuse(tool, tier, `copilot request refused: ${error.message}`);
        throw error;
      }
    }

    const needed = TIER_CAPABILITY[tier];
    if (needed && (!AGENT_CAPABILITIES.has(needed) || !can(actor, needed))) {
      return refuse(tool, tier, `the copilot cannot ${needed} for a ${actor.role}`);
    }

    // Tier 0, Tier 1, Tier 3 and unknown tools: the gate decides and logs.
    const run = await runCopilotTool({ tool, input: args, ctx: plan.ctx, actorId: label, actorType: "agent" });
    return {
      ok: run.ok,
      output: run.output,
      summary: {
        tool,
        tier: run.gate.tier,
        decision: run.gate.decision,
        reason: run.gate.reason,
        seq: run.gate.auditEntry.seq,
      },
    };
  };
}
