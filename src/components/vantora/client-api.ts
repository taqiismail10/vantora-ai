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

/** `profile` switches the sandbox SME; `rho` re-runs the forecast correlated. */
export async function fetchDashboardState(
  options: { profile?: string; rho?: number } = {},
): Promise<DashboardState> {
  const query = new URLSearchParams();
  if (options.profile) query.set("profile", options.profile);
  if (options.rho) query.set("rho", String(options.rho));
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

export const verifyAuditChain = () =>
  post<{ verification: DashboardState["audit"]["verification"]; entries: DashboardState["audit"]["entries"] }>(
    "/api/action",
    { action: "verify_chain" },
  );

export const askCopilotQuestion = (question: string) =>
  post<CopilotTurnResponse>("/api/copilot", { question });
