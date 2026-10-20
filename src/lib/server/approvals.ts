/**
 * Approval issuance, execution and counterparty simulation.
 *
 * An approval is a database row first and a bearer token second. The row binds
 * the authenticated approver, the business, the scenario, the plan version,
 * the exact canonical payload and the figure the human confirmed; the HMAC
 * token is only how the browser carries the row's id from "approve" to
 * "execute". Execution re-derives the plan, re-validates the action, and then —
 * inside one synchronous SQLite transaction — burns the approval and inserts
 * the execution row whose primary key is the real-world action. A replay, a
 * concurrent duplicate, or the same action reached through the full-plan path
 * and the single-action path all hit the same row and are refused.
 */

import { randomUUID } from "node:crypto";

import { digestPayload, logOperation } from "../sandbox/execution-logger";
import { enforcePermissionGate, issueApprovalToken, type ApprovalClaims } from "../security/permission-gate";
import { db, transaction } from "./db";
import { AccessError, AGENT_ID, auditActorId, type HumanActor } from "./identity";
import { formatCents, parseCents } from "./money";
import {
  DEAD,
  NEXT_STATUSES,
  validateSpec,
  type ActionSpec,
  type ActionStatus,
  type PlanBundleSpec,
  type PlanContext,
} from "./plan";

export const APPROVAL_TTL_MS = 5 * 60 * 1000;

export type ApprovalTarget = { kind: "action"; actionKey: string } | { kind: "plan" };

interface Resolved {
  target: string;
  operation: string;
  payload: unknown;
  specs: ActionSpec[];
  confirmation: { field: string; label: string; expected_cents: number };
}

/** Find what an approval or execution refers to in the plan as it stands right now. */
function resolve(plan: PlanContext, target: ApprovalTarget): Resolved {
  if (target.kind === "plan") {
    const bundle: PlanBundleSpec | null = plan.bundle;
    if (!bundle) throw new AccessError(409, "There is no executable plan for this scenario right now.");
    return {
      target: "PLAN",
      operation: bundle.operation,
      payload: bundle.payload,
      specs: plan.specs,
      confirmation: bundle.confirmation,
    };
  }
  const spec = plan.specs.find((s) => s.action_key === target.actionKey);
  if (!spec) {
    const existing = plan.records.find((r) => r.action_key === target.actionKey);
    throw new AccessError(
      409,
      existing
        ? `This action was already submitted (${existing.status}). It cannot run twice.`
        : "That action is not part of the current plan. The plan may have been revised; review it and approve again.",
    );
  }
  return {
    target: spec.action_key,
    operation: spec.operation,
    payload: spec.payload,
    specs: [spec],
    confirmation: spec.confirmation,
  };
}

function assertValid(plan: PlanContext, specs: ActionSpec[]) {
  for (const spec of specs) {
    const problem = validateSpec(spec, plan);
    if (problem) throw new AccessError(422, problem);
  }
}

const DATA_PLAN_ID = (plan: PlanContext) => `${plan.ctx.planId}@${plan.planVersion}`;

export interface MintResult {
  userApprovalToken: string;
  jti: string;
  expires_at: string;
  plan_version: string;
  target: string;
  operation: string;
  confirmed: string;
  delegated_to: string | null;
  seq: number;
}

export async function mintApproval(
  actor: HumanActor,
  plan: PlanContext,
  target: ApprovalTarget,
  confirmation: unknown,
  options: { delegateToAgent?: boolean } = {},
): Promise<MintResult> {
  const resolved = resolve(plan, target);
  assertValid(plan, resolved.specs);

  const typed = parseCents(confirmation, plan.ctx.currency);
  if (!typed.ok) throw new AccessError(422, `Confirmation: ${typed.reason}.`);
  if (typed.cents !== resolved.confirmation.expected_cents) {
    throw new AccessError(
      422,
      `You confirmed ${formatCents(typed.cents, plan.ctx.currency)}, but the ${resolved.confirmation.label.toLowerCase()} is ${formatCents(
        resolved.confirmation.expected_cents,
        plan.ctx.currency,
      )}. Nothing was approved.`,
    );
  }

  const jti = randomUUID();
  const now = Date.now();
  const expiresAt = now + APPROVAL_TTL_MS;
  db()
    .prepare(
      `INSERT INTO approval (jti, business_id, user_id, operation, target, action_keys, scenario_key, plan_id,
         plan_version, payload_digest, confirmation_field, confirmed_cents, delegate, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jti,
      actor.businessId,
      actor.userId,
      resolved.operation,
      resolved.target,
      JSON.stringify(resolved.specs.map((s) => s.action_key)),
      plan.scenarioKey,
      plan.ctx.planId,
      plan.planVersion,
      digestPayload(resolved.payload),
      resolved.confirmation.field,
      typed.cents,
      options.delegateToAgent ? AGENT_ID : null,
      now,
      expiresAt,
    );

  const audit = await logOperation({
    actorId: auditActorId(actor),
    actorType: "human",
    operation: "issue_hitl_approval_token",
    tier: "TIER_1_DRAFT_ONLY",
    decision: "DRAFTED",
    reason: `approval minted for ${resolved.operation} (${resolved.target === "PLAN" ? "full plan" : resolved.specs[0].counterparty}), confirmed ${formatCents(
      typed.cents,
      plan.ctx.currency,
    )}, plan ${plan.planVersion}${options.delegateToAgent ? ", delegated to the copilot for this action only" : ""}`,
    payload: { jti, operation: resolved.operation, target: resolved.target, plan_version: plan.planVersion },
    smeProfileId: plan.ctx.smeProfileId,
    recoveryPlanId: plan.ctx.planId,
  });

  return {
    userApprovalToken: issueApprovalToken({
      operation: resolved.operation,
      planId: DATA_PLAN_ID(plan),
      actorId: `user:${actor.userId}`,
      payload: resolved.payload,
      jti,
      ttlMs: APPROVAL_TTL_MS,
    }),
    jti,
    expires_at: new Date(expiresAt).toISOString(),
    plan_version: plan.planVersion,
    target: resolved.target,
    operation: resolved.operation,
    confirmed: formatCents(typed.cents, plan.ctx.currency),
    delegated_to: options.delegateToAgent ? AGENT_ID : null,
    seq: audit.seq,
  };
}

interface ApprovalRow {
  jti: string;
  business_id: string;
  user_id: string;
  operation: string;
  target: string;
  action_keys: string;
  scenario_key: string;
  plan_version: string;
  payload_digest: string;
  delegate: string | null;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}

class Refusal extends Error {}

export type Executor = { kind: "human"; actor: HumanActor } | { kind: "agent"; onBehalfOf: HumanActor };

export interface ExecutionResult {
  ok: boolean;
  decision: string;
  tier: string;
  reason: string;
  seq: number;
  currentLogHash: string;
  action_keys: string[];
  operation: string;
  plan_version: string;
}

/**
 * Present an approval and run the sandbox action(s) it covers. For a human the
 * approval is the token they were issued; for the copilot it is an unconsumed
 * delegation that the same owner granted for exactly this action.
 */
export async function executeApproval(
  executor: Executor,
  plan: PlanContext,
  target: ApprovalTarget,
  userApprovalToken?: string,
): Promise<ExecutionResult> {
  const human = executor.kind === "human" ? executor.actor : executor.onBehalfOf;
  const resolved = resolve(plan, target);
  assertValid(plan, resolved.specs);
  const digest = digestPayload(resolved.payload);
  const actorLabel = executor.kind === "human" ? auditActorId(human) : `${AGENT_ID} (for ${auditActorId(human)})`;

  const commit = (claims: ApprovalClaims | null): { ok: true } | { ok: false; reason: string } => {
    try {
      transaction((database) => {
        const row = (
          claims
            ? database.prepare("SELECT * FROM approval WHERE jti = ?").get(claims.jti)
            : database
                .prepare(
                  `SELECT * FROM approval WHERE delegate = ? AND user_id = ? AND business_id = ? AND target = ?
                     AND consumed_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
                )
                .get(AGENT_ID, human.userId, human.businessId, resolved.target)
        ) as ApprovalRow | undefined;
        const now = Date.now();
        if (!row) {
          throw new Refusal(
            claims
              ? "approval not found on this server"
              : "no owner delegation exists for this exact action; the owner must approve it first",
          );
        }
        if (row.business_id !== human.businessId) throw new Refusal("approval belongs to a different business");
        if (executor.kind === "human" && row.user_id !== human.userId) {
          throw new Refusal("approval was issued to a different user");
        }
        if (executor.kind === "agent" && (row.delegate !== AGENT_ID || row.user_id !== human.userId)) {
          throw new Refusal("approval does not delegate this action to the copilot");
        }
        if (row.revoked_at) throw new Refusal(`approval was revoked: ${row.revoked_reason}`);
        if (row.consumed_at) throw new Refusal("approval has already been used (replay)");
        if (row.expires_at <= now) throw new Refusal("approval expired; approve the action again");
        if (row.scenario_key !== plan.scenarioKey) throw new Refusal("approval was issued for a different scenario");
        if (row.target !== resolved.target) throw new Refusal("approval covers a different action");
        if (row.plan_version !== plan.planVersion) {
          throw new Refusal(
            `the plan changed since this approval (was ${row.plan_version}, now ${plan.planVersion}); review it and approve again`,
          );
        }
        if (row.payload_digest !== digest) throw new Refusal("the action changed since it was approved");

        const burned = database
          .prepare("UPDATE approval SET consumed_at = ?, consumed_by = ? WHERE jti = ? AND consumed_at IS NULL")
          .run(now, actorLabel, row.jti);
        if (Number(burned.changes) !== 1) throw new Refusal("approval has already been used (replay)");

        const insert = database.prepare(
          `INSERT INTO action_execution (action_key, business_id, scenario_key, kind, target_id, ordinal, payload_json,
             status, approval_jti, submitted_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'AWAITING_COUNTERPARTY', ?, ?, ?, ?)`,
        );
        const event = database.prepare(
          "INSERT INTO action_event (action_key, status, actor, note, at) VALUES (?, ?, ?, ?, ?)",
        );
        for (const spec of resolved.specs) {
          const existing = database
            .prepare("SELECT status FROM action_execution WHERE action_key = ?")
            .get(spec.action_key) as { status: string } | undefined;
          if (existing) throw new Refusal(`${spec.counterparty}: already ${existing.status}; it cannot run twice`);
          insert.run(
            spec.action_key,
            human.businessId,
            plan.scenarioKey,
            spec.kind,
            spec.target_id,
            spec.ordinal,
            JSON.stringify(spec.payload),
            row.jti,
            actorLabel,
            now,
            now,
          );
          event.run(spec.action_key, "SUBMITTED", actorLabel, `${spec.operation} submitted in the sandbox`, now);
          event.run(
            spec.action_key,
            "AWAITING_COUNTERPARTY",
            "sandbox",
            `waiting for ${spec.counterparty}; nothing is received until they respond`,
            now,
          );
        }
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof Refusal) return { ok: false, reason: error.message };
      throw error;
    }
  };

  const gate = await enforcePermissionGate({
    operation: resolved.operation,
    actorId: actorLabel,
    actorType: executor.kind,
    payload: resolved.payload,
    userApprovalToken,
    planId: DATA_PLAN_ID(plan),
    smeProfileId: plan.ctx.smeProfileId,
    recoveryPlanId: plan.ctx.planId,
    commit,
    delegated: executor.kind === "agent",
    attest: false,
  });

  const actionKeys = resolved.specs.map((s) => s.action_key);
  if (gate.allowed) {
    const mark = db().prepare("UPDATE action_event SET audit_seq = ? WHERE action_key = ? AND audit_seq IS NULL");
    for (const key of actionKeys) mark.run(gate.auditEntry.seq, key);
  }

  return {
    ok: gate.allowed,
    decision: gate.decision,
    tier: gate.tier,
    reason: gate.reason,
    seq: gate.auditEntry.seq,
    currentLogHash: gate.auditEntry.currentLogHash,
    action_keys: actionKeys,
    operation: resolved.operation,
    plan_version: plan.planVersion,
  };
}

export type CounterpartyResponse = "ACCEPTED" | "DECLINED" | "FAILED" | "SETTLED";

/**
 * Record a simulated counterparty response. Labelled as a simulation in the
 * chain and in the UI; nothing external is contacted. A decline or failure
 * revokes every outstanding approval in the scenario, because the plan they
 * were minted against no longer exists.
 */
export async function simulateCounterparty(
  actor: HumanActor,
  plan: PlanContext,
  actionKey: string,
  response: unknown,
): Promise<{ status: ActionStatus; revoked_approvals: number; seq: number }> {
  const record = plan.records.find((r) => r.action_key === actionKey);
  if (!record) throw new AccessError(404, "No submitted action with that key in this scenario.");
  const allowed = NEXT_STATUSES[record.kind][record.status] ?? [];
  if (typeof response !== "string" || !allowed.includes(response as ActionStatus)) {
    throw new AccessError(
      409,
      `A ${record.status.toLowerCase().replace(/_/g, " ")} ${record.kind.replace(/_/g, " ")} can move to ${
        allowed.length ? allowed.join(" or ") : "no further state"
      }, not ${String(response).slice(0, 20)}.`,
    );
  }
  const next = response as ActionStatus;
  const now = Date.now();
  const label = `${auditActorId(actor)} (simulated counterparty)`;
  let revoked = 0;

  transaction((database) => {
    const moved = database
      .prepare("UPDATE action_execution SET status = ?, updated_at = ? WHERE action_key = ? AND status = ?")
      .run(next, now, actionKey, record.status);
    if (Number(moved.changes) !== 1) throw new AccessError(409, "The action changed state concurrently; reload and retry.");
    database
      .prepare("INSERT INTO action_event (action_key, status, actor, note, at) VALUES (?, ?, ?, ?, ?)")
      .run(actionKey, next, label, simulationNote(record.kind, next), now);
    if (next === "SETTLED") {
      const cents = record.kind === "bridge_draw" ? record.payload.principal_cents! : record.payload.settlement_cents!;
      database
        .prepare(
          "INSERT INTO cash_movement (business_id, scenario_key, action_key, amount_cents, description, at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          actor.businessId,
          plan.scenarioKey,
          actionKey,
          cents,
          record.kind === "bridge_draw" ? `${record.target_id} drawdown received` : `${record.target_id} early settlement received`,
          now,
        );
    }
    if (DEAD.has(next)) {
      revoked = Number(
        database
          .prepare(
            `UPDATE approval SET revoked_at = ?, revoked_reason = ?
               WHERE business_id = ? AND scenario_key = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
          )
          .run(now, `${record.target_id} was ${next.toLowerCase()}; the plan was revised`, actor.businessId, plan.scenarioKey)
          .changes,
      );
    }
  });

  const audit = await logOperation({
    actorId: auditActorId(actor),
    actorType: "human",
    operation: "simulate_counterparty_response",
    tier: "TIER_0_AUTO_READ",
    decision: "ALLOWED",
    reason: `SANDBOX SIMULATION — ${record.target_id} recorded as ${next}; no external party was contacted${
      revoked ? `; ${revoked} pending approval(s) revoked` : ""
    }`,
    payload: { action_key: actionKey, from: record.status, to: next },
    smeProfileId: plan.ctx.smeProfileId,
    recoveryPlanId: plan.ctx.planId,
  });
  db().prepare("UPDATE action_event SET audit_seq = ? WHERE action_key = ? AND audit_seq IS NULL").run(audit.seq, actionKey);

  return { status: next, revoked_approvals: revoked, seq: audit.seq };
}

function simulationNote(kind: string, status: ActionStatus): string {
  const notes: Record<string, Partial<Record<ActionStatus, string>>> = {
    ar_early_discount: {
      ACCEPTED: "buyer accepted the early-settlement offer (simulated); cash not yet received",
      DECLINED: "buyer declined the early-settlement offer (simulated)",
      FAILED: "offer could not be delivered (simulated)",
      SETTLED: "early settlement received in the sandbox account (simulated)",
    },
    ap_deferral: {
      ACCEPTED: "supplier agreed to the new due date (simulated)",
      DECLINED: "supplier refused the deferral (simulated)",
      FAILED: "request could not be delivered (simulated)",
    },
    bridge_draw: {
      ACCEPTED: "lender approved the drawdown (simulated); funds not yet received",
      DECLINED: "lender declined the drawdown (simulated)",
      FAILED: "drawdown request failed (simulated)",
      SETTLED: "drawdown funds received in the sandbox account (simulated)",
    },
  };
  return notes[kind]?.[status] ?? status;
}

/** Unconsumed, unexpired, unrevoked approvals in a scenario: shown as APPROVED in the UI. */
export function pendingApprovals(businessId: string, scenarioKey: string) {
  return db()
    .prepare(
      `SELECT jti, target, action_keys, plan_version, delegate, expires_at, user_id FROM approval
         WHERE business_id = ? AND scenario_key = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
    .all(businessId, scenarioKey, Date.now()) as unknown as {
    jti: string;
    target: string;
    action_keys: string;
    plan_version: string;
    delegate: string | null;
    expires_at: number;
    user_id: string;
  }[];
}
