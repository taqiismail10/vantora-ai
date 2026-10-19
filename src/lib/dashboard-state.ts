/**
 * The shape of `GET /api/state`.
 *
 * The route annotates its response with this type and the dashboard consumes
 * it, so a field renamed on one side fails `tsc` on the other.
 */

import type { AuditLogEntry, ChainVerification } from "./sandbox/execution-logger";
import type {
  EngineSource,
  ForecastResult,
  OptimizationResult,
  ProcrastinationPoint,
  RecoveryPlanResult,
  SmeFinancialState,
} from "./quant-client";
import type { Capability, HumanRole } from "./server/identity";
import type { ActionKind, ActionStatus, ConfirmationField, SandboxAccount } from "./server/plan";
import type { CounterpartyFallback, EchoCheck } from "./recovery-scenarios";
import type { NumericalIntegrityResult, PermissionTier } from "./security/permission-gate";
import type { ScenarioPreset, SeedResult } from "./sandbox/seed-data";
import type { StressControls } from "./stress-controls";

export interface MemoScreen {
  invoice_id: string;
  customer_name: string;
  quarantined: boolean;
  severity: "none" | "suspicious" | "critical";
  matched_patterns: string[];
  matched_text: string[];
  sanitized_excerpt: string;
}

/** One real-world action: proposed by the current plan, or already submitted in the sandbox. */
export interface ActionView {
  action_key: string;
  kind: ActionKind;
  target_id: string;
  counterparty: string;
  label: string;
  operation: string;
  /** PROPOSED / APPROVED come from the plan and pending approvals; the rest from the execution record. */
  status: ActionStatus;
  confirmation: { field: ConfirmationField; label: string; expected_cents: number } | null;
  cash_cost_cents: number;
  risk_charge_cents: number;
  effect: string;
  /** Statuses a simulated counterparty response may move this action to next. */
  next_statuses: ActionStatus[];
  events: { status: ActionStatus; actor: string; note: string; at: number; audit_seq: number | null }[];
  approval_expires_at: number | null;
  delegated_to_agent: boolean;
}

export interface DashboardState {
  company_name?: string;
  plan_id: string;
  /** Who is looking, as the server resolved them. Display only: every route re-checks. */
  viewer: {
    email: string;
    name: string;
    role: HumanRole;
    capabilities: Capability[];
    session_expires_at: string;
  };
  /** The exact scenario this payload was computed for; actions must send it back. */
  scenario: {
    profile: string;
    stress: StressControls;
    key: string;
    dataset_version: string;
    /** Calendar date of day 0 in the synthetic ledger. */
    as_of_date: string;
  };
  /** Hash of dataset + scenario + sandbox position + re-solved actions. */
  plan_version: string;
  /** The optimal plan's cost split into cash and the solver's priced relationship risk. */
  cost_breakdown: { cash_cents: number; risk_cents: number; total_cents: number };
  execution: {
    actions: ActionView[];
    /** The not-yet-submitted remainder of the plan, approvable as one decision. */
    bundle: { action_keys: string[]; cash_cost_cents: number; confirmation_label: string } | null;
    /** The plan re-solved with the sandbox position applied. */
    current_plan: RecoveryPlanResult;
    /** Projected day-of-crunch P10 if every in-flight counterparty accepts. */
    projected_p10_at_crunch: number | null;
    /** First buffer breach of the re-solved position (may be a later day than the original crunch). */
    current_crunch_day: number;
    current_required_cash: number;
    settled_movements: { action_key: string; amount_cents: number; description: string; at: number }[];
    account: SandboxAccount;
    has_position: boolean;
    revised_after_decline: boolean;
  };
  ai: { provider: "gemini" | "openrouter" | null; model: string | null; configured: boolean; problem: string | null };
  benchmark: {
    scenarios: number;
    identical: number;
    milp_cheaper: number;
    greedy_cheaper: number;
    both_infeasible: number;
    feasibility_disagree: number;
    run_at: string;
  } | null;
  /** Which scenario preset is loaded, and the band its dataset is shaped to produce. */
  profile: Pick<ScenarioPreset, "id" | "industry" | "alert_band" | "headline"> & {
    available: Pick<ScenarioPreset, "id" | "alert_band" | "headline" | "label">[];
  };
  /** Where the four supply-chain stress controls were set for this payload. */
  stress: StressControls;
  /** False once any control has moved: the canonical figures no longer apply. */
  stress_is_baseline: boolean;
  /** The systemic delay correlation this payload was forecast under. */
  correlation_rho: number;
  seed: SeedResult & { source: string };
  /** Which company this payload is for, and whether it is the demonstration one. */
  company: {
    id: string;
    name: string;
    currency: string;
    is_demo: boolean;
    status: string;
  };
  /**
   * What this forecast does and does not rest on. Empty for the demonstration
   * company, whose dataset is complete by construction.
   */
  coverage: { level: "blocking" | "warning" | "info"; code: string; message: string }[];
  engine: {
    python_engine_up: boolean;
    forecast_source: EngineSource;
    optimization_source: EngineSource;
    solver_status: string;
  };
  copilot: {
    tools: { name: string; tier: PermissionTier; description?: string }[];
    narrative: string;
    narrative_integrity: NumericalIntegrityResult;
  };
  state: SmeFinancialState;
  forecast: ForecastResult;
  optimization: OptimizationResult;
  post_recovery_p10_trajectory: number[];
  /** What the same plan costs at each decision horizon before the crunch. */
  procrastination_curve: ProcrastinationPoint[];
  /** Plan B for each key counterparty refusing. Empty when the plan has no offers in it. */
  counterparty_fallbacks: CounterpartyFallback[];
  /** Does the day-14 fix become a day-31 problem? Null when there is no plan. */
  post_crunch_echo_check: EchoCheck | null;
  memos: MemoScreen[];
  audit: { entries: AuditLogEntry[]; verification: ChainVerification };
}

/** `POST /api/action` — one gate decision, as the dashboard reads it. */
export interface ActionResult {
  action?: string;
  tool: string;
  ok: boolean;
  tier: PermissionTier;
  decision: "ALLOWED" | "DRAFTED" | "DENIED";
  reason: string;
  seq: number;
  currentLogHash: string;
  numericalIntegrity: NumericalIntegrityResult | null;
  injection: { injectionDetected: boolean; severity: string; matches: { name: string }[] } | null;
  tokenVerification: { valid: boolean; reason: string | null } | null;
  output: unknown;
  plan_id?: string;
}

export interface ApprovalResult {
  action: "approve";
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

export interface ExecutionResult {
  action: "execute";
  ok: boolean;
  decision: "ALLOWED" | "DRAFTED" | "DENIED";
  tier: PermissionTier;
  reason: string;
  seq: number;
  currentLogHash: string;
  action_keys: string[];
  operation: string;
  plan_version: string;
}

export interface RedTeamResult {
  action: "red_team";
  attacks: { name: string; expectation: string; result: ActionResult }[];
  control: { name: string; expectation: string; result: ActionResult };
  summary: {
    attacks_run: number;
    attacks_blocked: number;
    all_blocked: boolean;
    control_allowed: boolean;
    passed: boolean;
  };
  memos_screened: number;
}

export interface CopilotTurnResponse {
  question: string;
  answer: string;
  source: "gemini" | "openrouter" | "deterministic";
  /** Set only when that provider's model actually produced the answer. */
  model: string | null;
  /** The configured provider, whether or not it answered. */
  provider: "gemini" | "openrouter" | null;
  /** Why the deterministic synthesiser answered instead, when it did. */
  fallback_reason: string | null;
  attested: boolean;
  numericalIntegrity: NumericalIntegrityResult;
  tool_runs: { tool: string; tier: PermissionTier; decision: string; reason: string; seq: number }[];
  plan_id: string;
}
