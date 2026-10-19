/** Thin fetch helpers for the dashboard. One place that knows the route shapes. */

import type {
  ActionResult,
  ApprovalResult,
  CopilotTurnResponse,
  DashboardState,
  RedTeamResult,
} from "@/lib/dashboard-state";

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error ?? `${url} failed with ${response.status}`);
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
  if (!response.ok) throw new Error(`/api/state failed with ${response.status}`);
  return (await response.json()) as DashboardState;
}

export const runTool = (tool: string, input: Record<string, unknown> = {}, userApprovalToken?: string) =>
  post<ActionResult>("/api/action", {
    action: userApprovalToken ? "execute" : "draft",
    tool,
    input,
    userApprovalToken,
  });

/**
 * The input must match the one the execute call sends: the minted token
 * commits to a digest of the payload built from it.
 */
export const requestApproval = (
  operation: string,
  input: Record<string, unknown> = {},
  confirmedAmount?: number,
) => post<ApprovalResult>("/api/action", { action: "approve", operation, input, confirmedAmount });

export const runRedTeamDrill = () => post<RedTeamResult>("/api/action", { action: "red_team" });

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

export const askCopilotQuestion = (question: string) =>
  post<CopilotTurnResponse>("/api/copilot", { question });
