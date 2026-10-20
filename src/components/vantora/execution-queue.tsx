"use client";

/**
 * Tab 3 — the sandbox execution queue.
 *
 * One row per real-world action, whether the current plan proposes it or it
 * has already been submitted, so the same offer can never appear twice. The
 * row's state comes from the server (`execution.actions`), never from local
 * component state: PROPOSED → APPROVED → SUBMITTED → AWAITING_COUNTERPARTY →
 * ACCEPTED → SETTLED, or DECLINED / FAILED.
 *
 * Buttons follow the signed-in role, but they are a convenience: every route
 * re-checks the role, the scenario, the plan version and the approval.
 */

import { useEffect, useRef, useState } from "react";
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  Clock,
  FlaskConical,
  KeyRound,
  Loader2,
  Lock,
  Send,
  ShieldCheck,
  TriangleAlert,
  Wallet,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ActionView, DashboardState, ExecutionResult } from "@/lib/dashboard-state";
import type { ActionStatus } from "@/lib/server/plan";
import { cn } from "@/lib/utils";

import { executeApproved, requestApproval, scenarioOf, SessionExpiredError, simulateResponse, type Target } from "./client-api";
import { dayDate } from "./dates";
import { confirmationMatches, confirmationTarget } from "./currency";
import { DecisionBadge, SectionHeading, TierBadge, useMoney } from "./primitives";

const STATUS: Record<ActionStatus, { label: string; icon: React.ReactNode; className: string }> = {
  PROPOSED: { label: "Proposed", icon: <CircleDashed className="size-3" />, className: "text-slate-700 dark:text-slate-300" },
  APPROVED: { label: "Approved — not sent", icon: <KeyRound className="size-3" />, className: "text-sky-800 dark:text-sky-300" },
  SUBMITTED: { label: "Submitted", icon: <Send className="size-3" />, className: "text-sky-800 dark:text-sky-300" },
  AWAITING_COUNTERPARTY: { label: "Awaiting counterparty", icon: <Clock className="size-3" />, className: "text-amber-800 dark:text-amber-300" },
  ACCEPTED: { label: "Accepted — not yet received", icon: <CircleDot className="size-3" />, className: "text-emerald-800 dark:text-emerald-300" },
  SETTLED: { label: "Settled — cash received", icon: <Wallet className="size-3" />, className: "text-emerald-800 dark:text-emerald-300" },
  DECLINED: { label: "Declined", icon: <Ban className="size-3" />, className: "text-rose-800 dark:text-rose-300" },
  FAILED: { label: "Failed", icon: <TriangleAlert className="size-3" />, className: "text-rose-800 dark:text-rose-300" },
};

export function StatusChip({ status, kind }: { status: ActionStatus; kind?: string }) {
  // A deferral that is accepted has moved a date; there is no cash to receive.
  const meta =
    kind === "ap_deferral" && status === "ACCEPTED"
      ? { ...STATUS.ACCEPTED, label: "Accepted — due date moved" }
      : STATUS[status];
  return (
    <Badge variant="outline" className={cn("gap-1 font-mono text-[10px]", meta.className)}>
      {meta.icon}
      {meta.label}
    </Badge>
  );
}

const SIMULATE_LABEL: Partial<Record<ActionStatus, string>> = {
  ACCEPTED: "accepts",
  DECLINED: "declines",
  FAILED: "fails to deliver",
  SETTLED: "pays / funds",
};

type Pending =
  | { kind: "action"; action: ActionView }
  | { kind: "plan"; actionKeys: string[]; cashCents: number; label: string };

export function ExecutionQueue({
  data,
  onChanged,
  openPlanApproval,
  onPlanApprovalHandled,
}: {
  data: DashboardState;
  onChanged: () => Promise<void> | void;
  openPlanApproval?: boolean;
  onPlanApprovalHandled?: () => void;
}) {
  const { money, money2 } = useMoney();
  const can = (capability: string) => data.viewer.capabilities.includes(capability as never);
  const ex = data.execution;
  const scenario = scenarioOf(data);
  const asOf = data.scenario.as_of_date;
  // "Approve this plan" on Tab 2 mounts this tab with the dialog already open.
  const [pending, setPending] = useState<Pending | null>(() =>
    openPlanApproval && ex.bundle && can("approve")
      ? { kind: "plan", actionKeys: ex.bundle.action_keys, cashCents: ex.bundle.cash_cost_cents, label: ex.bundle.confirmation_label }
      : null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const openDialog = (next: Pending) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPending(next);
  };
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ExecutionResult[]>([]);

  useEffect(() => {
    if (openPlanApproval) onPlanApprovalHandled?.();
  }, [openPlanApproval, onPlanApprovalHandled]);

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof SessionExpiredError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    } finally {
      setBusy(null);
      await onChanged();
    }
  };

  const simulate = (action: ActionView, response: ActionStatus) =>
    run(`sim:${action.action_key}`, async () => {
      await simulateResponse(scenario, action.action_key, response);
    });

  const submitted = ex.actions.filter((a) => !["PROPOSED", "APPROVED"].includes(a.status));
  const proposed = ex.actions.filter((a) => a.status === "PROPOSED" || a.status === "APPROVED");
  const account = ex.account;
  const stressed = !data.stress_is_baseline || data.scenario.profile !== "SOLVABLE_DAY14_CRUNCH";

  return (
    <Card className="border-amber-200 dark:border-amber-900">
      <CardHeader>
        <SectionHeading title="Execution queue" hint="sandbox · owner approval required" />
        <CardDescription className="text-xs">
          Every action here is simulated: nothing reaches a real buyer, supplier or lender, and no money moves.
          Approval binds your account, this scenario, plan version{" "}
          <span className="font-mono">{data.plan_version.slice(0, 8)}</span> and the exact amount you confirm.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!can("approve") ? (
          <p className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 p-2.5 text-[11px] text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">
            <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            You are signed in as {data.viewer.role}. You can review every action, but only the business OWNER can
            approve, submit or record counterparty responses.
          </p>
        ) : null}

        {stressed ? (
          <p className="rounded-md border border-sky-200 bg-sky-50 p-2.5 text-[11px] text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
            You are acting on a <strong>stress scenario</strong>. Approvals and executions here are bound to it and
            recorded separately from the baseline; changing a dial gives a different plan, and an approval for this
            one will not run there.
          </p>
        ) : null}

        {error ? (
          <div role="alert" className="rounded-md border border-rose-300 bg-rose-50 p-2.5 text-[11px] text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            <p>
              <strong className="font-medium">Refused — no financial action was taken.</strong>{" "}
              {/plan changed|revoked|different recovery plan|payloadDigest|expired|no longer/i.test(error)
                ? "This approval no longer matches the plan on screen. Review the current plan and approve again."
                : "No approval, submission or response was recorded. The reason is below."}
            </p>
            <details className="mt-1">
              <summary className="cursor-pointer">Technical reason</summary>
              <p className="mt-0.5 font-mono">{error}</p>
            </details>
          </div>
        ) : null}

        {ex.has_position ? (
          <div className="grid gap-2 rounded-md border border-slate-200 p-2.5 text-[11px] sm:grid-cols-3 dark:border-slate-800">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Projected if pending counterparties accept</p>
              <p className="font-medium tabular-nums">
                day-{data.optimization.crunch_day} P10 {ex.projected_p10_at_crunch !== null ? money(ex.projected_p10_at_crunch) : "—"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Sandbox cash (settled only)</p>
              <p className="font-medium tabular-nums">
                {money2(account.cash_cents / 100)}
                <span className="font-normal text-slate-500"> · opened at {money2(account.opening_cash_cents / 100)}</span>
              </p>
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Next shortfall after this position</p>
              <p className="font-medium tabular-nums">
                {ex.current_crunch_day
                  ? `day ${ex.current_crunch_day} (${dayDate(asOf, ex.current_crunch_day)}): ${money(ex.current_required_cash)} below buffer`
                  : "none in the 30-day horizon"}
              </p>
            </div>
            <dl className="grid gap-x-4 gap-y-1 sm:col-span-3 sm:grid-cols-2">
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Receivables outstanding</dt>
                <dd className="tabular-nums">
                  {money2(account.receivables_cents / 100)}
                  {account.discounts_given_cents ? ` · ${money2(account.discounts_given_cents / 100)} discount given up` : ""}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Facility balance owed</dt>
                <dd className="tabular-nums">
                  {account.facility_owed.length
                    ? account.facility_owed
                        .map((f) => `${money2((f.principal_cents + f.cost_cents) / 100)} ${f.target_id} by day ${f.repay_day}`)
                        .join(" · ")
                    : "none drawn"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Bills moved (agreed)</dt>
                <dd className="tabular-nums">
                  {account.moved_obligations.length
                    ? account.moved_obligations
                        .map((o) => `${o.target_id} ${money2(o.amount_cents / 100)}: day ${o.from_day} → ${o.to_day}`)
                        .join(" · ")
                    : "none"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Pending — not cash yet</dt>
                <dd className="tabular-nums">
                  {account.pending_inflows.length
                    ? account.pending_inflows
                        .map((i) => `${money2(i.amount_cents / 100)} ${i.target_id} (${i.status.toLowerCase().replace(/_/g, " ")})`)
                        .join(" · ")
                    : "none"}
                </dd>
              </div>
            </dl>
            {ex.revised_after_decline ? (
              <p className="sm:col-span-3 text-amber-800 dark:text-amber-300">
                A counterparty declined, so the plan was re-solved and any approval minted before that was revoked.
              </p>
            ) : null}
          </div>
        ) : null}

        {ex.bundle && proposed.length > 1 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 p-2.5 dark:border-slate-800">
            <div>
              <p className="text-xs font-medium">Submit the remaining plan as one decision</p>
              <p className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                {ex.bundle.action_keys.length} actions · {money2(ex.bundle.cash_cost_cents / 100)} in cash
              </p>
            </div>
            <Button
              size="sm"
              disabled={!can("approve") || busy !== null}
              onClick={() =>
                openDialog({ kind: "plan", actionKeys: ex.bundle!.action_keys, cashCents: ex.bundle!.cash_cost_cents, label: ex.bundle!.confirmation_label })
              }
              className="text-[11px]"
            >
              <KeyRound className="size-4" aria-hidden />
              Review &amp; approve all
            </Button>
          </div>
        ) : null}

        {[...submitted, ...proposed].map((action) => (
          <div key={action.action_key} className="rounded-lg border border-slate-200 p-2.5 dark:border-slate-800">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-medium">{action.label}</p>
                <p className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-400">{action.effect}</p>
                <p className="mt-0.5 text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                  {money2(action.cash_cost_cents / 100)} cash
                  {action.risk_charge_cents ? ` · ${money2(action.risk_charge_cents / 100)} modelled relationship risk` : ""}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <StatusChip status={action.status} kind={action.kind} />
                {action.delegated_to_agent ? (
                  <Badge variant="outline" className="font-mono text-[10px]">delegated to copilot</Badge>
                ) : null}
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              {action.status === "PROPOSED" || action.status === "APPROVED" ? (
                <Button
                  size="sm"
                  disabled={!can("approve") || busy !== null}
                  onClick={() => openDialog({ kind: "action", action })}
                  className="text-[11px]"
                  title={can("approve") ? undefined : "Only the OWNER can approve"}
                >
                  <KeyRound className="size-4" aria-hidden />
                  Review &amp; approve
                </Button>
              ) : null}
              {action.next_statuses.length && can("simulate") ? (
                <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-slate-300 px-2 py-1 dark:border-slate-700">
                  <FlaskConical className="size-3.5 text-slate-500" aria-hidden />
                  <span className="text-[10px] text-slate-500">Simulate {action.counterparty}:</span>
                  {action.next_statuses.map((next) => (
                    <Button
                      key={next}
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => simulate(action, next)}
                      className="h-6 px-2 text-[10px]"
                    >
                      {busy === `sim:${action.action_key}` ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
                      {SIMULATE_LABEL[next] ?? next.toLowerCase()}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>

            {action.events.length ? (
              <details className="mt-2 text-[11px]">
                <summary className="cursor-pointer text-slate-500 dark:text-slate-400">History ({action.events.length})</summary>
                <ol className="mt-1 flex flex-col gap-0.5 border-l border-slate-200 pl-3 dark:border-slate-800">
                  {action.events.map((event, index) => (
                    <li key={index} className="text-slate-600 dark:text-slate-400">
                      <span className="font-mono text-[10px]">{new Date(event.at).toLocaleTimeString()}</span>{" "}
                      <strong className="font-medium">{STATUS[event.status].label}</strong> — {event.note}{" "}
                      <span className="text-slate-500">({event.actor}{event.audit_seq ? `, audit #${event.audit_seq}` : ""})</span>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </div>
        ))}

        {!ex.actions.length ? (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {data.optimization.optimal_plan.feasible
              ? "No action is needed in this scenario."
              : "No feasible plan: there is nothing here that could be safely approved."}
          </p>
        ) : null}

        {results.map((result, index) => (
          <div key={`${result.seq}-${index}`} className="rounded-lg border border-slate-200 bg-slate-50/70 p-2.5 text-[11px] dark:border-slate-800 dark:bg-slate-900/40">
            <div className="flex flex-wrap items-center gap-1.5">
              <TierBadge tier={result.tier} />
              <DecisionBadge decision={result.decision} />
              <Badge variant="outline" className="font-mono text-[10px]">audit seq #{result.seq}</Badge>
            </div>
            <p className="mt-1 text-slate-600 dark:text-slate-400">{result.reason}</p>
          </div>
        ))}

        <p className="flex items-start gap-1.5 border-t border-slate-100 pt-2 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-slate-500" aria-hidden />
          Approving does not send anything until you also submit it. An approval expires after 5 minutes, works
          once, and stops working if the plan or the scenario changes.
        </p>
      </CardContent>

      <Dialog open={pending !== null} onOpenChange={(open) => (open ? null : setPending(null))}>
        <DialogContent
          className="sm:max-w-xl"
          // Opened from state, not a Trigger, so Base UI cannot know where focus came from.
          finalFocus={() => (returnFocus.current?.isConnected ? returnFocus.current : true)}
        >
          {pending ? (
            <ApprovalDialog
              data={data}
              pending={pending}
              busy={busy === "approve"}
              onCancel={() => setPending(null)}
              onConfirm={(confirmation, delegate) =>
                run("approve", async () => {
                  const target: Target =
                    pending.kind === "plan" ? { kind: "plan" } : { kind: "action", actionKey: pending.action.action_key };
                  const approval = await requestApproval(scenario, target, confirmation, delegate);
                  if (!delegate) {
                    const result = await executeApproved(scenario, target, approval.userApprovalToken);
                    setResults((current) => [result, ...current].slice(0, 5));
                  }
                  setPending(null);
                })
              }
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "good" | "warn" }) {
  return (
    <div className="grid grid-cols-[9.5rem_1fr] gap-x-3 border-t border-slate-100 py-1.5 first:border-t-0 dark:border-slate-800">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</span>
      <span
        className={cn(
          "text-xs tabular-nums",
          tone === "good" && "font-medium text-emerald-700 dark:text-emerald-400",
          tone === "warn" && "font-medium text-amber-800 dark:text-amber-400",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Reading is not consent and clicking is not reading: the figure that matters
 * for *this* action has to be typed back. The server compares it to its own
 * canonical value in cents; this dialog only enables the button.
 */
function ApprovalDialog({
  data,
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  data: DashboardState;
  pending: Pending;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (confirmation: string, delegate: boolean) => void;
}) {
  const { money2, code: currency } = useMoney();
  const [typed, setTyped] = useState("");
  const [delegate, setDelegate] = useState(false);
  const expectedCents =
    pending.kind === "plan" ? pending.cashCents : (pending.action.confirmation?.expected_cents ?? 0);
  const label = pending.kind === "plan" ? pending.label : (pending.action.confirmation?.label ?? "Amount");
  // Grouped the way this company's figures are grouped everywhere else, so the
  // number on screen is the number to type. No symbol: the symbol is not typed.
  const target = confirmationTarget(expectedCents, currency);
  const matches = confirmationMatches(typed, expectedCents);
  const actions =
    pending.kind === "plan"
      ? data.execution.actions.filter((a) => pending.actionKeys.includes(a.action_key))
      : [pending.action];

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm">
          {pending.kind === "plan" ? `Approve ${actions.length} actions in one decision` : `Approve: ${pending.action.label}`}
        </DialogTitle>
        <DialogDescription className="text-xs">
          Sandbox only — nothing reaches a real counterparty. Read what each action does before confirming.
        </DialogDescription>
      </DialogHeader>

      <div className="rounded-md border border-slate-200 px-3 py-1 dark:border-slate-800">
        {actions.map((action) => (
          <Row key={action.action_key} label={action.counterparty} value={action.effect} />
        ))}
        <Row
          label="Cash cost"
          value={money2(actions.reduce((sum, a) => sum + a.cash_cost_cents, 0) / 100)}
          tone="warn"
        />
        {actions.some((a) => a.risk_charge_cents) ? (
          <Row
            label="Modelled risk"
            value={`${money2(actions.reduce((sum, a) => sum + a.risk_charge_cents, 0) / 100)} relationship-risk charge — not cash`}
          />
        ) : null}
        <Row label="Plan version" value={<span className="font-mono">{data.plan_version}</span>} />
        <Row label="Signed in as" value={`${data.viewer.email} (${data.viewer.role})`} />
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">
          {label}: type <span className="font-mono tabular-nums">{target}</span> to confirm
        </span>
        <input
          autoFocus
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          aria-describedby="confirm-help"
          placeholder={target}
          className={cn(
            "h-9 rounded-md border bg-white px-3 font-mono text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-950",
            matches ? "border-emerald-600" : "border-slate-300 dark:border-slate-700",
          )}
        />
        <span id="confirm-help" className="text-[11px] text-slate-500 dark:text-slate-400">
          {typed && !matches ? "That does not match yet." : "Commas and a $ sign are fine; the cents must match."}
        </span>
      </label>

      <label className="flex items-start gap-2 text-[11px] text-slate-700 dark:text-slate-300">
        <input type="checkbox" checked={delegate} onChange={(event) => setDelegate(event.target.checked)} className="mt-0.5" />
        <span>
          Instead of submitting now, let the copilot submit <strong>exactly this</strong> on my behalf within 5 minutes.
          It cannot change the amount, the counterparty or the plan, and the delegation works once.
        </span>
      </label>

      <DialogFooter>
        <Button size="sm" variant="ghost" onClick={onCancel} className="text-[11px]">
          Cancel
        </Button>
        <Button size="sm" disabled={!matches || busy} onClick={() => onConfirm(typed, delegate)} className="text-[11px]">
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : delegate ? <CheckCircle2 className="size-4" aria-hidden /> : <Lock className="size-4" aria-hidden />}
          {delegate ? "Approve & delegate" : `Approve & submit — ${money2(expectedCents / 100)}`}
        </Button>
      </DialogFooter>
    </>
  );
}
