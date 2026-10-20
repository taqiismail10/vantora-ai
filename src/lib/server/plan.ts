/**
 * The canonical, server-side plan.
 *
 * A plan is a pure function of four things, and its version hashes all four:
 *
 *   dataset   the seed ledger (DATASET_VERSION hashes it, so editing the seed
 *             invalidates every outstanding approval automatically)
 *   scenario  preset + stress dials, parsed strictly
 *   position  every sandbox action already submitted and its current status
 *   result    the re-solved actions, in integer cents
 *
 * Executing an action, a counterparty declining, a new dial setting or a seed
 * edit each produce a different version, and an approval minted against one
 * version cannot be spent against another. The client never sends an amount
 * the server trusts: actions are derived here and looked up by key.
 */

import { loadCopilotContext, type CopilotContext } from "../agent/vantora-copilot";
import {
  deferralDays,
  deferralFeePct,
  type ArInvoiceInput,
  type FinancingOptionInput,
  type OptimizationResult,
  type PlanAction,
  type SmeFinancialState,
} from "../quant-client";
import { sha256 } from "../sandbox/execution-logger";
import {
  DEFAULT_SCENARIO_PRESET,
  SCENARIO_PRESETS,
  scenarioState,
  seedSandboxDataset,
  type ScenarioPresetId,
} from "../sandbox/seed-data";
import {
  applyStress,
  BASELINE_STRESS,
  DELAY_SHIFT_STEPS,
  PRIOR_EXTENSION_STEPS,
  RHO_STEPS,
  WORKFORCE_STEPS,
  type StressControls,
} from "../stress-controls";
import { db } from "./db";
import { getCompany } from "./companies";
import { companyDataset } from "./company-state";
import { AccessError, CompanyNotReadyError } from "./identity";
import { formatCents, toCents, type CurrencyCode } from "./money";

// ------------------------------------------------------------------ scenario

export const DATASET_VERSION = sha256(JSON.stringify(SCENARIO_PRESETS)).slice(0, 12);

/**
 * Day 0 of the synthetic ledger. The engines count in days; the UI turns
 * "day 11" into a calendar date from this, so a deadline reads as a date.
 */
export const AS_OF_DATE = "2026-10-19";

export interface ScenarioRef {
  preset: ScenarioPresetId;
  stress: StressControls;
}

export const BASELINE_SCENARIO: ScenarioRef = { preset: DEFAULT_SCENARIO_PRESET, stress: BASELINE_STRESS };

/**
 * Strict at the action boundary. The read-only `/api/state` narrows unknown
 * values to the baseline so a stale link still renders; an approval or an
 * execution must instead refuse, because "silently executed the baseline" is
 * exactly the bug this replaces.
 */
export function parseScenarioRef(raw: unknown): ScenarioRef {
  if (raw === undefined || raw === null) return BASELINE_SCENARIO;
  if (typeof raw !== "object") throw new AccessError(400, "scenario must be an object");
  const { profile, stress } = raw as { profile?: unknown; stress?: unknown };
  let preset: ScenarioPresetId = DEFAULT_SCENARIO_PRESET;
  if (profile !== undefined) {
    if (typeof profile !== "string" || !Object.hasOwn(SCENARIO_PRESETS, profile)) {
      throw new AccessError(400, `unknown scenario preset "${String(profile).slice(0, 40)}"`);
    }
    preset = profile as ScenarioPresetId;
  }
  const dials = (stress ?? {}) as Record<string, unknown>;
  const dial = (name: keyof StressControls, allowed: number[]) => {
    const value = dials[name];
    if (value === undefined) return BASELINE_STRESS[name];
    if (typeof value !== "number" || !allowed.includes(value)) {
      throw new AccessError(400, `stress.${name} must be one of ${allowed.join(", ")}`);
    }
    return value;
  };
  return {
    preset,
    stress: {
      delayShift: dial("delayShift", DELAY_SHIFT_STEPS),
      workforce: dial("workforce", WORKFORCE_STEPS),
      rho: dial("rho", RHO_STEPS),
      priorExtensions: dial("priorExtensions", PRIOR_EXTENSION_STEPS),
    },
  };
}

export const scenarioKey = (ref: ScenarioRef) =>
  [
    DATASET_VERSION,
    ref.preset,
    `d${ref.stress.delayShift}`,
    `w${ref.stress.workforce}`,
    `r${ref.stress.rho}`,
    `p${ref.stress.priorExtensions}`,
  ].join("|");

// ------------------------------------------------------------------ position

export type ActionStatus =
  | "PROPOSED"
  | "APPROVED"
  | "SUBMITTED"
  | "AWAITING_COUNTERPARTY"
  | "ACCEPTED"
  | "SETTLED"
  | "DECLINED"
  | "FAILED";

export type ActionKind = "ar_early_discount" | "ap_deferral" | "bridge_draw";

/** The statuses each kind can reach after submission. A deferral never "settles": it moves a date. */
export const NEXT_STATUSES: Record<ActionKind, Partial<Record<ActionStatus, ActionStatus[]>>> = {
  ar_early_discount: { AWAITING_COUNTERPARTY: ["ACCEPTED", "DECLINED", "FAILED"], ACCEPTED: ["SETTLED"] },
  ap_deferral: { AWAITING_COUNTERPARTY: ["ACCEPTED", "DECLINED", "FAILED"] },
  bridge_draw: { AWAITING_COUNTERPARTY: ["ACCEPTED", "DECLINED", "FAILED"], ACCEPTED: ["SETTLED"] },
};

const IN_FLIGHT = new Set<ActionStatus>(["SUBMITTED", "AWAITING_COUNTERPARTY", "ACCEPTED"]);
export const DEAD = new Set<ActionStatus>(["DECLINED", "FAILED"]);

export interface ActionRecord {
  action_key: string;
  kind: ActionKind;
  target_id: string;
  ordinal: number;
  payload: CanonicalPayload;
  status: ActionStatus;
  approval_jti: string;
  submitted_by: string;
  created_at: number;
  updated_at: number;
  events: { status: ActionStatus; actor: string; note: string; at: number; audit_seq: number | null }[];
}

export function listActions(businessId: string, key: string): ActionRecord[] {
  const rows = db()
    .prepare(
      "SELECT * FROM action_execution WHERE business_id = ? AND scenario_key = ? ORDER BY created_at, action_key",
    )
    .all(businessId, key) as unknown as (Omit<ActionRecord, "payload" | "events"> & { payload_json: string })[];
  const events = db().prepare("SELECT status, actor, note, at, audit_seq FROM action_event WHERE action_key = ? ORDER BY id");
  // node:sqlite returns null-prototype rows; the spreads make plain objects,
  // which React requires to pass a row from a Server to a Client Component.
  return rows.map(({ payload_json, ...row }) => ({
    ...row,
    payload: JSON.parse(payload_json) as CanonicalPayload,
    events: (events.all(row.action_key) as unknown as ActionRecord["events"]).map((event) => ({ ...event })),
  }));
}

export interface CashMovement {
  action_key: string;
  amount_cents: number;
  description: string;
  at: number;
}

export function listMovements(businessId: string, key: string): CashMovement[] {
  return db()
    .prepare(
      "SELECT action_key, amount_cents, description, at FROM cash_movement WHERE business_id = ? AND scenario_key = ? ORDER BY id",
    )
    .all(businessId, key)
    .map((row) => ({ ...row })) as unknown as CashMovement[];
}

/**
 * Apply the sandbox position to the scenario ledger before re-solving.
 *
 * In-flight actions become *forecast* effects — a deterministic inflow or a
 * moved due date — and only SETTLED ones touch `current_cash`. A request that
 * has been sent is never treated as money received.
 *
 * Deterministic inflows are written with `due_day = arrival - 1`: the
 * forecaster draws a vanishingly small positive delay and takes the ceiling,
 * so an inflow due on day N lands on day N + 1.
 */
export function applyPosition(base: SmeFinancialState, records: ActionRecord[]): SmeFinancialState {
  let state: SmeFinancialState = {
    ...base,
    invoices_ar: base.invoices_ar.map((i) => ({ ...i })),
    payables_ap: base.payables_ap.map((p) => ({ ...p })),
    financing_options: base.financing_options.map((f) => ({ ...f })),
  };

  for (const record of records) {
    const p = record.payload;
    if (record.kind === "ar_early_discount") {
      const index = state.invoices_ar.findIndex((i) => i.id === record.target_id);
      if (index < 0) continue;
      if (record.status === "SETTLED") {
        state.invoices_ar.splice(index, 1);
        state = { ...state, current_cash: state.current_cash + p.settlement_cents! / 100 };
      } else if (IN_FLIGHT.has(record.status)) {
        state.invoices_ar[index] = {
          ...state.invoices_ar[index],
          amount: p.settlement_cents! / 100,
          due_day: Math.max(1, p.settles_in_days! - 1),
          expected_delay_days_mean: 0,
          expected_delay_days_std: 0,
          reliability_score: 1,
          early_payment_discount_eligible: false,
        };
      } else {
        state.invoices_ar[index] = { ...state.invoices_ar[index], early_payment_discount_eligible: false };
      }
    } else if (record.kind === "ap_deferral") {
      const index = state.payables_ap.findIndex((ap) => ap.id === record.target_id);
      if (index < 0) continue;
      if (IN_FLIGHT.has(record.status) || record.status === "SETTLED") {
        // Moved past the 30-day horizon: it leaves the forecast here and the
        // post-crunch echo check picks it up on its new date.
        if (p.to_day! > (base.horizon_days ?? 30)) state.payables_ap.splice(index, 1);
        else
          state.payables_ap[index] = {
            ...state.payables_ap[index],
            due_day: p.to_day!,
            amount: (p.deferred_cents! + p.fee_cents!) / 100,
            is_flexible: false,
          };
      } else {
        state.payables_ap[index] = { ...state.payables_ap[index], is_flexible: false };
      }
    } else {
      const index = state.financing_options.findIndex((f) => f.id === record.target_id);
      if (index < 0) continue;
      if (DEAD.has(record.status)) {
        state.financing_options.splice(index, 1);
        continue;
      }
      const facility = state.financing_options[index];
      state.financing_options[index] = {
        ...facility,
        max_amount: Math.max(0, facility.max_amount - p.principal_cents! / 100),
      };
      if (record.status === "SETTLED") {
        state = { ...state, current_cash: state.current_cash + p.principal_cents! / 100 };
      } else {
        const inflow: ArInvoiceInput = {
          id: `FUNDING-${facility.id}-${record.ordinal}`,
          customer_name: `${facility.provider} drawdown (in flight)`,
          amount: p.principal_cents! / 100,
          due_day: Math.max(1, facility.funding_days - 1),
          expected_delay_days_mean: 0,
          expected_delay_days_std: 0,
          reliability_score: 1,
          early_payment_discount_eligible: false,
          inflow_kind: "expected_funding",
        };
        state.invoices_ar.push(inflow);
      }
    }
  }
  return state;
}

// ------------------------------------------------------------------- actions

export interface CanonicalPayload {
  v: 1;
  action_key: string;
  kind: ActionKind;
  target_id: string;
  scenario_key: string;
  currency: CurrencyCode;
  // ar_early_discount
  face_cents?: number;
  discount_cents?: number;
  settlement_cents?: number;
  settles_in_days?: number;
  // ap_deferral
  deferred_cents?: number;
  fee_cents?: number;
  from_day?: number;
  to_day?: number;
  // bridge_draw
  principal_cents?: number;
  cost_cents?: number;
  apr?: number;
  funding_days?: number;
}

export type ConfirmationField = "discount_cents" | "deferred_cents" | "principal_cents" | "cash_cost_cents";

export interface ActionSpec {
  action_key: string;
  kind: ActionKind;
  target_id: string;
  ordinal: number;
  operation: "issue_early_payment_discount" | "send_supplier_deferral_email" | "accept_financing_offer";
  counterparty: string;
  label: string;
  plan_action: PlanAction;
  payload: CanonicalPayload;
  confirmation: { field: ConfirmationField; label: string; expected_cents: number };
  /** What the action costs in cash, and what the solver priced as relationship risk. */
  cash_cost_cents: number;
  risk_charge_cents: number;
  effect: string;
}

export interface PlanBundleSpec {
  operation: "execute_recovery_plan";
  action_keys: string[];
  payload: {
    v: 1;
    plan_id: string;
    plan_version: string;
    scenario_key: string;
    actions: { action_key: string; digest: string }[];
    cash_cost_cents: number;
  };
  confirmation: { field: "cash_cost_cents"; label: string; expected_cents: number };
}

function ordinalFor(records: ActionRecord[], kind: ActionKind, target: string): number {
  return records.filter((r) => r.kind === kind && r.target_id === target).length + 1;
}

function deriveSpecs(ctx: CopilotContext, key: string, records: ActionRecord[]): ActionSpec[] {
  const specs: ActionSpec[] = [];
  const riskPrice = ctx.state.relationship_risk_price ?? 2000;
  for (const action of ctx.optimization.optimal_plan.actions) {
    if (action.kind !== "ar_early_discount" && action.kind !== "ap_deferral" && action.kind !== "bridge_draw") continue;
    const ordinal = ordinalFor(records, action.kind, action.target_id);
    const actionKey = `${key}#${action.kind}:${action.target_id}:${ordinal}`;
    const base = {
      v: 1 as const,
      action_key: actionKey,
      kind: action.kind,
      target_id: action.target_id,
      scenario_key: key,
      currency: ctx.currency,
    };

    if (action.kind === "ar_early_discount") {
      const invoice = ctx.state.invoices_ar.find((i) => i.id === action.target_id)!;
      const face = toCents(invoice.amount);
      const discount = toCents(invoice.amount * (invoice.early_payment_discount_pct ?? 0));
      specs.push({
        action_key: actionKey,
        kind: action.kind,
        target_id: action.target_id,
        ordinal,
        operation: "issue_early_payment_discount",
        counterparty: invoice.customer_name,
        label: action.label,
        plan_action: action,
        payload: {
          ...base,
          face_cents: face,
          discount_cents: discount,
          settlement_cents: face - discount,
          settles_in_days: invoice.early_payment_settles_in_days ?? 3,
        },
        confirmation: { field: "discount_cents", label: "Discount you give up", expected_cents: discount },
        cash_cost_cents: discount,
        risk_charge_cents: 0,
        effect: `${invoice.customer_name} pays ${formatCents(face - discount, ctx.currency)} instead of ${formatCents(face, ctx.currency)}, within ${
          invoice.early_payment_settles_in_days ?? 3
        } days if accepted.`,
      });
    } else if (action.kind === "ap_deferral") {
      const payable = ctx.state.payables_ap.find((p) => p.id === action.target_id)!;
      const days = deferralDays(payable);
      const fee = toCents(payable.amount * deferralFeePct(payable));
      const risk = toCents((payable.relationship_risk ?? 0) * riskPrice);
      specs.push({
        action_key: actionKey,
        kind: action.kind,
        target_id: action.target_id,
        ordinal,
        operation: "send_supplier_deferral_email",
        counterparty: payable.supplier_name,
        label: action.label,
        plan_action: action,
        payload: {
          ...base,
          deferred_cents: toCents(payable.amount),
          fee_cents: fee,
          from_day: payable.due_day,
          to_day: payable.due_day + days,
        },
        confirmation: { field: "deferred_cents", label: "Bill being moved", expected_cents: toCents(payable.amount) },
        cash_cost_cents: fee,
        risk_charge_cents: risk,
        effect: `${formatCents(toCents(payable.amount), ctx.currency)} moves from day ${payable.due_day} to day ${
          payable.due_day + days
        } for a ${formatCents(fee, ctx.currency)} fee, if ${payable.supplier_name} agrees.`,
      });
    } else {
      const facility = ctx.state.financing_options.find((f) => f.id === action.target_id)!;
      const principal = toCents(action.cash_impact);
      const cost = toCents(action.cost);
      specs.push({
        action_key: actionKey,
        kind: action.kind,
        target_id: action.target_id,
        ordinal,
        operation: "accept_financing_offer",
        counterparty: facility.provider,
        label: action.label,
        plan_action: action,
        payload: {
          ...base,
          principal_cents: principal,
          cost_cents: cost,
          apr: facility.apr,
          funding_days: facility.funding_days,
        },
        confirmation: { field: "principal_cents", label: "Principal you draw", expected_cents: principal },
        cash_cost_cents: cost,
        risk_charge_cents: 0,
        effect: `${formatCents(principal, ctx.currency)} arrives in ${facility.funding_days} days if ${facility.provider} funds it; ${formatCents(
          principal + cost,
          ctx.currency,
        )} is repaid 30 days later.`,
      });
    }
  }
  return specs;
}

// --------------------------------------------------------------------- plan

export interface PlanContext {
  businessId: string;
  ref: ScenarioRef;
  scenarioKey: string;
  /** The scenario ledger before any sandbox action. */
  base: CopilotContext;
  /** The ledger with the sandbox position applied, re-forecast and re-solved. */
  ctx: CopilotContext;
  planVersion: string;
  records: ActionRecord[];
  movements: CashMovement[];
  specs: ActionSpec[];
  bundle: PlanBundleSpec | null;
}

/**
 * A real company's own dataset, supplied instead of the demonstration seed.
 *
 * `dataVersion` takes the place of `DATASET_VERSION` in the plan version, so
 * one company's edits invalidate only that company's outstanding approvals.
 */
export interface DatasetOverride {
  state: SmeFinancialState;
  profileId: string;
  dataVersion: string;
  /** Prefixes the plan id, so no customer's plan reads "smartjeans". */
  planSlug: string;
  /** The company's own books currency — never the demo's hardcoded USD. */
  currency: CurrencyCode;
}

/**
 * The dataset a business forecasts from.
 *
 * Resolved here rather than at each call site: the copilot, every `/api/action`
 * branch and the dashboard all route through `loadPlanContext`, so deciding it
 * in one place is what keeps a real company's plan, drafts, approvals and
 * copilot answers on its own figures instead of the demonstration seed.
 *
 * Returns undefined for the demonstration company, which keeps the seeded
 * dataset and every recorded figure that rests on it.
 */
function companyDatasetOverride(businessId: string): DatasetOverride | undefined {
  const company = getCompany(businessId);
  if (!company || company.isDemo) return undefined;
  const dataset = companyDataset(company);
  if (!dataset.state) {
    const blocking = dataset.coverage.find((note) => note.level === "blocking");
    throw new CompanyNotReadyError(blocking?.message ?? "This company has no financial data yet.");
  }
  return {
    state: dataset.state,
    profileId: company.id,
    dataVersion: dataset.dataVersion,
    planSlug: company.id,
    currency: company.currency,
  };
}

export async function loadPlanContext(
  businessId: string,
  requestedRef: ScenarioRef,
  override?: DatasetOverride,
): Promise<PlanContext> {
  const resolved = override ?? companyDatasetOverride(businessId);
  // The workforce dial rewrites payroll with the demonstration plant's
  // per-head figure, so it is held at rest for a real company's data.
  const ref: ScenarioRef = resolved
    ? { ...requestedRef, stress: { ...requestedRef.stress, workforce: BASELINE_STRESS.workforce } }
    : requestedRef;
  const key = scenarioKey(ref);
  const profileId = resolved ? resolved.profileId : (await seedSandboxDataset(ref.preset)).smeProfileId;
  const baseState = resolved ? applyStress(resolved.state, ref.stress) : scenarioState(ref.preset, ref.stress);
  const records = listActions(businessId, key);
  // A real company carries no demonstration memos and its own plan slug.
  const options = resolved ? { memos: {}, planSlug: resolved.planSlug, currency: resolved.currency } : {};
  const base = await loadCopilotContext(baseState, profileId, ref.preset, options);
  const ctx = records.length
    ? await loadCopilotContext(applyPosition(baseState, records), profileId, ref.preset, options)
    : base;
  const specs = deriveSpecs(ctx, key, records);

  const plan = ctx.optimization.optimal_plan;
  const planVersion = sha256(
    JSON.stringify({
      dataset: resolved ? resolved.dataVersion : DATASET_VERSION,
      scenario: key,
      position: records.map((r) => [r.action_key, r.status]),
      feasible: plan.feasible,
      total_cost_cents: toCents(plan.total_cost),
      actions: specs.map((s) => s.payload),
    }),
  ).slice(0, 16);

  const bundle: PlanBundleSpec | null =
    plan.feasible && specs.length
      ? {
          operation: "execute_recovery_plan",
          action_keys: specs.map((s) => s.action_key),
          payload: {
            v: 1,
            plan_id: ctx.planId,
            plan_version: planVersion,
            scenario_key: key,
            actions: specs.map((s) => ({ action_key: s.action_key, digest: sha256(JSON.stringify(s.payload)) })),
            cash_cost_cents: specs.reduce((sum, s) => sum + s.cash_cost_cents, 0),
          },
          confirmation: {
            field: "cash_cost_cents",
            label: "Cash cost of the plan",
            expected_cents: specs.reduce((sum, s) => sum + s.cash_cost_cents, 0),
          },
        }
      : null;

  return {
    businessId,
    ref,
    scenarioKey: key,
    base,
    ctx,
    planVersion,
    records,
    movements: listMovements(businessId, key),
    specs,
    bundle,
  };
}

/**
 * The simulated account after settled actions, with conditional effects kept
 * apart. Settled: cash received, the receivable it cleared, the discount given
 * up, the facility balance now owed. Agreed: bills whose due date moved.
 * Pending: what lands only if a counterparty still says yes. Built from the
 * execution rows and settled movements alone, so it cannot count a settlement
 * twice: `cash_movement` holds at most one row per action.
 */
export interface SandboxAccount {
  opening_cash_cents: number;
  cash_cents: number;
  receivables_opening_cents: number;
  receivables_cents: number;
  discounts_given_cents: number;
  facility_owed: { target_id: string; principal_cents: number; cost_cents: number; repay_day: number }[];
  moved_obligations: { target_id: string; amount_cents: number; from_day: number; to_day: number }[];
  pending_inflows: { action_key: string; target_id: string; status: ActionStatus; amount_cents: number; day: number }[];
}

export function sandboxAccount(plan: PlanContext): SandboxAccount {
  const base = plan.base.state;
  const settledKeys = new Set(plan.movements.map((m) => m.action_key));
  const settled = plan.records.filter((r) => r.status === "SETTLED" && settledKeys.has(r.action_key));
  const receivablesOpening = base.invoices_ar.reduce((sum, i) => sum + toCents(i.amount), 0);
  const cleared = settled.filter((r) => r.kind === "ar_early_discount");
  const crunch = plan.base.optimization.crunch_day ?? 0;
  return {
    opening_cash_cents: toCents(base.current_cash),
    cash_cents: toCents(base.current_cash) + plan.movements.reduce((sum, m) => sum + m.amount_cents, 0),
    receivables_opening_cents: receivablesOpening,
    receivables_cents: receivablesOpening - cleared.reduce((sum, r) => sum + r.payload.face_cents!, 0),
    discounts_given_cents: cleared.reduce((sum, r) => sum + r.payload.discount_cents!, 0),
    facility_owed: settled
      .filter((r) => r.kind === "bridge_draw")
      .map((r) => ({
        target_id: r.target_id,
        principal_cents: r.payload.principal_cents!,
        cost_cents: r.payload.cost_cents!,
        // Same 30-day term the echo check uses for plan-created repayments.
        repay_day: crunch + 30,
      })),
    moved_obligations: plan.records
      .filter((r) => r.kind === "ap_deferral" && r.status === "ACCEPTED")
      .map((r) => ({
        target_id: r.target_id,
        amount_cents: r.payload.deferred_cents! + r.payload.fee_cents!,
        from_day: r.payload.from_day!,
        to_day: r.payload.to_day!,
      })),
    pending_inflows: plan.records
      .filter((r) => r.kind !== "ap_deferral" && IN_FLIGHT.has(r.status))
      .map((r) => ({
        action_key: r.action_key,
        target_id: r.target_id,
        status: r.status,
        amount_cents: r.kind === "bridge_draw" ? r.payload.principal_cents! : r.payload.settlement_cents!,
        day: r.kind === "bridge_draw" ? r.payload.funding_days! : r.payload.settles_in_days!,
      })),
  };
}

/** The plan as it stands with everything already committed folded back in, for the echo walk. */
export function effectiveOptimization(plan: PlanContext): OptimizationResult {
  if (!plan.records.length) return plan.base.optimization;
  const committed = plan.records.filter((r) => !DEAD.has(r.status)).map((r) => recordPlanAction(r, plan));
  const current = plan.ctx.optimization.optimal_plan;
  const crunch = plan.base.optimization.crunch_day;
  const p10AtCrunch = crunch ? plan.ctx.forecast.p10_trajectory[crunch - 1] : current.post_recovery_p10_balance;
  return {
    ...plan.base.optimization,
    optimal_plan: {
      ...current,
      actions: [...committed, ...current.actions],
      feasible: current.feasible,
      post_recovery_p10_balance: current.actions.length ? current.post_recovery_p10_balance : p10AtCrunch,
    },
  };
}

function recordPlanAction(record: ActionRecord, plan: PlanContext): PlanAction {
  const p = record.payload;
  if (record.kind === "bridge_draw") {
    const facility = plan.base.state.financing_options.find((f) => f.id === record.target_id);
    return {
      kind: "bridge_draw",
      target_id: record.target_id,
      label: `Draw ${formatCents(p.principal_cents!, plan.ctx.currency).replace(/\.00$/, "")} from ${facility?.provider ?? record.target_id}`,
      cash_impact: p.principal_cents! / 100,
      cost: p.cost_cents! / 100,
      detail: "committed in the sandbox",
    };
  }
  if (record.kind === "ap_deferral") {
    return {
      kind: "ap_deferral",
      target_id: record.target_id,
      label: "committed deferral",
      cash_impact: p.deferred_cents! / 100,
      cost: p.fee_cents! / 100,
      detail: "committed in the sandbox",
    };
  }
  return {
    kind: "ar_early_discount",
    target_id: record.target_id,
    label: "committed early-pay offer",
    cash_impact: p.settlement_cents! / 100,
    cost: p.discount_cents! / 100,
    detail: "committed in the sandbox",
  };
}

// --------------------------------------------------------------- validation

/**
 * Re-check an action against the ledger it will act on. Run at approval time
 * and again inside execution: the spec was derived from the plan, but the plan
 * came from an optimiser, and the boundary does not trust its own optimiser.
 */
export function validateSpec(spec: ActionSpec, plan: PlanContext): string | null {
  const { ctx } = plan;
  const p = spec.payload;
  if (!ctx.optimization.optimal_plan.feasible) return "the current plan is infeasible; nothing in it can be executed";
  if (p.currency !== plan.ctx.currency) return `payload currency does not match this plan`;
  const money = [p.face_cents, p.discount_cents, p.settlement_cents, p.deferred_cents, p.fee_cents, p.principal_cents, p.cost_cents]
    .filter((v): v is number => v !== undefined);
  if (money.some((v) => !Number.isSafeInteger(v) || v < 0)) return "amounts must be non-negative whole cents";

  if (spec.kind === "ar_early_discount") {
    const invoice = ctx.state.invoices_ar.find((i) => i.id === spec.target_id);
    if (!invoice || (invoice.inflow_kind ?? "invoice") !== "invoice") return `${spec.target_id} is not a receivable on this ledger`;
    if (invoice.match_status === "QTY_VARIANCE" || invoice.match_status === "PRICE_VARIANCE") {
      return `${spec.target_id} is blocked in the buyer's 3-way match queue and cannot be discounted`;
    }
    if (!invoice.early_payment_discount_eligible) return `${spec.target_id} is not eligible for an early-payment discount`;
    if (toCents(invoice.amount) !== p.face_cents) return `${spec.target_id} face value changed`;
    if (p.discount_cents! <= 0 || p.discount_cents! >= p.face_cents!) return "discount must be between zero and the face value";
  } else if (spec.kind === "ap_deferral") {
    const payable = ctx.state.payables_ap.find((ap) => ap.id === spec.target_id);
    if (!payable) return `${spec.target_id} is not a payable on this ledger`;
    if (payable.is_payroll) return "payroll is never deferred";
    if (!payable.is_flexible) return `${payable.supplier_name} does not accept deferrals`;
    if (p.to_day! - p.from_day! > Math.min(payable.max_deferral_days ?? 0, payable.insurance_revocation_day_cap ?? 30)) {
      return "deferral exceeds the supplier's window or the trade-credit insurance cap";
    }
  } else {
    const facility = ctx.state.financing_options.find((f) => f.id === spec.target_id);
    if (!facility) return `${spec.target_id} is not a facility on this ledger`;
    const screened = ctx.optimization.matched_financing_options.find((m) => m.id === spec.target_id);
    if (!screened?.eligible) return `${facility.provider} is not eligible: ${screened?.rejection_reason ?? "failed screening"}`;
    if (p.principal_cents! <= 0) return "principal must be greater than zero";
    if (p.principal_cents! > toCents(Math.min(facility.max_amount, screened.max_available))) {
      return `${formatCents(p.principal_cents!, ctx.currency)} exceeds the ${formatCents(toCents(screened.max_available), ctx.currency)} available on ${facility.provider}`;
    }
    if (facility.funding_days >= (ctx.optimization.crunch_day || Infinity)) {
      return `${facility.provider} funds in ${facility.funding_days} days, after the crunch`;
    }
  }
  return null;
}

/**
 * Map a free-form request (an old-style API call, or arguments the model
 * produced) onto an action of the current plan — or explain exactly why not.
 */
export function matchProposal(
  plan: PlanContext,
  tool: string,
  input: Record<string, unknown>,
  parseAmount: (value: unknown) => { ok: true; cents: number } | { ok: false; reason: string },
): { spec: ActionSpec } | { error: string } {
  const { ctx } = plan;
  if (tool === "accept_financing_offer") {
    const id = typeof input.financing_id === "string" ? input.financing_id : "";
    const facility: FinancingOptionInput | undefined = ctx.state.financing_options.find((f) => f.id === id);
    if (!facility) return { error: `${id || "(none)"} is not a facility on this ledger` };
    const screened = ctx.optimization.matched_financing_options.find((m) => m.id === id);
    if (!screened?.eligible) return { error: `${facility.provider} is not eligible: ${screened?.rejection_reason ?? "failed screening"}` };
    const amount = parseAmount(input.amount);
    if (!amount.ok) return { error: amount.reason };
    if (amount.cents > toCents(screened.max_available)) {
      return { error: `${formatCents(amount.cents, ctx.currency)} exceeds the ${formatCents(toCents(screened.max_available), ctx.currency)} available on ${facility.provider}` };
    }
    const spec = plan.specs.find((s) => s.kind === "bridge_draw" && s.target_id === id);
    if (!spec) {
      const planned = plan.specs.find((s) => s.kind === "bridge_draw");
      return {
        error: `${facility.provider} is not part of the current plan${
          planned ? `; the plan draws ${formatCents(planned.payload.principal_cents!, ctx.currency)} from ${planned.counterparty}` : ""
        }`,
      };
    }
    if (spec.payload.principal_cents !== amount.cents) {
      return { error: `amount must equal the planned draw of ${formatCents(spec.payload.principal_cents!, ctx.currency)}` };
    }
    return { spec };
  }
  if (tool === "send_supplier_deferral_email") {
    const id = typeof input.payable_id === "string" ? input.payable_id : "";
    const spec = plan.specs.find((s) => s.kind === "ap_deferral" && s.target_id === id);
    return spec ? { spec } : { error: `${id || "(none)"} is not a deferral in the current plan` };
  }
  if (tool === "issue_early_payment_discount") {
    const id = typeof input.invoice_id === "string" ? input.invoice_id : "";
    const spec = plan.specs.find((s) => s.kind === "ar_early_discount" && s.target_id === id);
    return spec ? { spec } : { error: `${id || "(none)"} is not an early-payment offer in the current plan` };
  }
  return { error: `${tool} is not an executable action` };
}
