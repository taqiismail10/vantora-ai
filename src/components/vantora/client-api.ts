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

export async function fetchDashboardState(): Promise<DashboardState> {
  const response = await fetch("/api/state", { cache: "no-store" });
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

export const requestApproval = (operation: string) =>
  post<ApprovalResult>("/api/action", { action: "approve", operation });

export const runRedTeamDrill = () => post<RedTeamResult>("/api/action", { action: "red_team" });

export const verifyAuditChain = () =>
  post<{ verification: DashboardState["audit"]["verification"]; entries: DashboardState["audit"]["entries"] }>(
    "/api/action",
    { action: "verify_chain" },
  );

export const askCopilotQuestion = (question: string) =>
  post<CopilotTurnResponse>("/api/copilot", { question });
