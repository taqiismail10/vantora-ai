/** Thin fetch helpers for the dashboard. One place that knows the route shapes. */

import type {
  ActionResult,
  ApprovalResult,
  CopilotTurnResponse,
  DashboardState,
  ExecutionResult,
  RedTeamResult,
} from "@/lib/dashboard-state";
import type { StressControls } from "@/lib/stress-controls";

/** Thrown on 401 so the shell can show "session expired" instead of a raw error. */
export class SessionExpiredError extends Error {
  constructor() {
    super("Your session has expired. Sign in again to continue.");
  }
}

/** The scenario every write must carry, exactly as the payload reported it. */
export interface ScenarioInput {
  profile: string;
  stress: StressControls;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (response.status === 401) throw new SessionExpiredError();
  const payload = await response.json().catch(() => ({}));
  // Execution refusals come back as 403 with a full gate decision; the caller
  // shows the decision rather than treating it as a transport failure.
  if (!response.ok && !(payload && typeof payload === "object" && "decision" in payload)) {
    throw new Error(payload?.error ?? `${url} failed with ${response.status}`);
  }
  return payload as T;
}

/**
 * `profile` picks the scenario preset; the other four are the live stress
 * controls. Baseline values are left off the query string so the canonical URL
 * stays `/api/state`.
 */
export async function fetchDashboardState(
  options: {
    profile?: string;
    delayShift?: number;
    workforce?: number;
    rho?: number;
    priorExtensions?: number;
  } = {},
): Promise<DashboardState> {
  const query = new URLSearchParams();
  if (options.profile) query.set("profile", options.profile);
  if (options.delayShift) query.set("delayShift", String(options.delayShift));
  if (options.workforce && options.workforce !== 100) query.set("workforce", String(options.workforce));
  if (options.rho) query.set("rho", String(options.rho));
  if (options.priorExtensions) query.set("priorExtensions", String(options.priorExtensions));
  const suffix = query.size ? `?${query}` : "";
  const response = await fetch(`/api/state${suffix}`, { cache: "no-store" });
  if (response.status === 401) throw new SessionExpiredError();
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error ?? `/api/state failed with ${response.status}`);
  }
  return (await response.json()) as DashboardState;
}

export const scenarioOf = (data: DashboardState): ScenarioInput => ({
  profile: data.scenario.profile,
  stress: data.scenario.stress,
});

/** Tier 0 / Tier 1 only. Tier 2 goes through approve → execute. */
export const runTool = (scenario: ScenarioInput, tool: string, input: Record<string, unknown> = {}) =>
  post<ActionResult>("/api/action", { action: "draft", tool, input, scenario });

export type Target = { kind: "plan" } | { kind: "action"; actionKey: string };

export const requestApproval = (
  scenario: ScenarioInput,
  target: Target,
  confirmation: string,
  delegateToAgent = false,
) => post<ApprovalResult>("/api/action", { action: "approve", target, confirmation, delegateToAgent, scenario });

export const executeApproved = (scenario: ScenarioInput, target: Target, userApprovalToken: string) =>
  post<ExecutionResult>("/api/action", { action: "execute", target, userApprovalToken, scenario });

export const simulateResponse = (scenario: ScenarioInput, actionKey: string, response: string) =>
  post<{ action: "simulate"; status: string; revoked_approvals: number; seq: number; plan_version: string }>(
    "/api/action",
    { action: "simulate", actionKey, response, scenario },
  );

export const runRedTeamDrill = (scenario: ScenarioInput) =>
  post<RedTeamResult>("/api/action", { action: "red_team", scenario });

/** One read-only run of both security screens over caller-supplied text. */
export interface SecurityProbeResult {
  action: "custom_security_probe";
  memo: {
    quarantined: boolean;
    severity: "none" | "suspicious" | "critical";
    tier: string;
    matched_patterns: string[];
    matched_text: string[];
    sanitized_excerpt: string;
    truncated: boolean;
  } | null;
  numbers: {
    ok: boolean;
    checkedDollarFigures: number[];
    checkedPercentages: number[];
    violations: { kind: string; value: number; nearestEngineValue: number | null; message: string }[];
    truncated: boolean;
  } | null;
  plan_id: string;
}

/** Appends nothing to the audit chain: the probe is pure analysis. */
export const probeSecurity = (input: { customMemo?: string; customDraftText?: string }) =>
  post<SecurityProbeResult>("/api/action", { action: "custom_security_probe", ...input });

export const verifyAuditChain = () =>
  post<{ verification: DashboardState["audit"]["verification"]; entries: DashboardState["audit"]["entries"] }>(
    "/api/action",
    { action: "verify_chain" },
  );

export const askCopilotQuestion = (scenario: ScenarioInput, question: string) =>
  post<CopilotTurnResponse>("/api/copilot", { question, scenario });
