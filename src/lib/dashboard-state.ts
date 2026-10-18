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
  SmeFinancialState,
} from "./quant-client";
import type { NumericalIntegrityResult, PermissionTier } from "./security/permission-gate";
import type { SeedResult } from "./sandbox/seed-data";

export interface MemoScreen {
  invoice_id: string;
  customer_name: string;
  quarantined: boolean;
  severity: "none" | "suspicious" | "critical";
  matched_patterns: string[];
  sanitized_excerpt: string;
}

export interface DashboardState {
  company_name?: string;
  plan_id: string;
  seed: SeedResult & { source: string };
  engine: {
    python_engine_up: boolean;
    forecast_source: EngineSource;
    optimization_source: EngineSource;
    solver_status: string;
  };
  copilot: {
    anthropic_key_present: boolean;
    model: string | null;
    tools: { name: string; tier: PermissionTier; description?: string }[];
    narrative: string;
    narrative_integrity: NumericalIntegrityResult;
  };
  state: SmeFinancialState;
  forecast: ForecastResult;
  optimization: OptimizationResult;
  post_recovery_p10_trajectory: number[];
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
  operation: string;
  tier: PermissionTier;
  plan_id: string;
  userApprovalToken: string;
  verification: { valid: boolean; reason: string | null };
  seq: number;
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
  source: "claude" | "deterministic" | "deterministic-after-integrity-failure";
  model: string | null;
  attested: boolean;
  numericalIntegrity: NumericalIntegrityResult;
  tool_runs: { tool: string; tier: PermissionTier; decision: string; reason: string; seq: number }[];
  plan_id: string;
}
