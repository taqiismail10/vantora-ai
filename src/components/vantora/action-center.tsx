"use client";

/**
 * Tab 3 — Copilot Action Center.
 *
 * The queue is the point: a Tier 1 draft is produced and shown, and nothing
 * moves to execution without a human minting an HMAC token for that exact plan.
 * The "without token" button is kept next to the real one so the denial is a
 * visible, auditable outcome rather than a claim in a README.
 */

import { useState } from "react";
import { KeyRound, Loader2, Send, ShieldX, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ActionResult, CopilotTurnResponse, DashboardState } from "@/lib/dashboard-state";
import { cn } from "@/lib/utils";

import { askCopilotQuestion, requestApproval, runTool } from "./client-api";
import { AttestedBadge, DecisionBadge, DeterministicBadge, money2, SectionHeading, TierBadge } from "./primitives";

interface Draft {
  tool: string;
  title: string;
  result: ActionResult;
}

const SUGGESTED = [
  "Why does cash break on day 14?",
  "What does the plan cost versus borrowing?",
  "Which financing facilities were rejected and why?",
  "What stops you executing this yourself?",
];

function GateTrace({ result }: { result: ActionResult }) {
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-lg border border-slate-200 bg-slate-50/70 p-2.5 text-[11px] dark:border-slate-800 dark:bg-slate-900/40">
      <div className="flex flex-wrap items-center gap-1.5">
        <TierBadge tier={result.tier} />
        <DecisionBadge decision={result.decision} />
        <Badge variant="outline" className="font-mono text-[10px]">
          audit seq #{result.seq}
        </Badge>
        {result.numericalIntegrity ? <AttestedBadge ok={result.numericalIntegrity.ok} /> : null}
      </div>
      <p className="text-slate-600 dark:text-slate-400">{result.reason}</p>
      {result.tokenVerification ? (
        <p className="font-mono text-slate-500 dark:text-slate-500">
          token: {result.tokenVerification.valid ? "verified" : result.tokenVerification.reason}
        </p>
      ) : null}
      <p className="truncate font-mono text-slate-400 dark:text-slate-600">
        hash {result.currentLogHash.slice(0, 32)}…
      </p>
    </div>
  );
}

export function ActionCenter({ data, onLedgerChanged }: { data: DashboardState; onLedgerChanged: () => void }) {
  const plan = data.optimization.optimal_plan;
  const discount = plan.actions.find((a) => a.kind === "ar_early_discount");
  const deferral = plan.actions.find((a) => a.kind === "ap_deferral");

  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [preview, setPreview] = useState<Draft | null>(null);
  const [executions, setExecutions] = useState<ActionResult[]>([]);
  const [turns, setTurns] = useState<CopilotTurnResponse[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);

  const guard = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      onLedgerChanged();
    }
  };

  const stageDraft = (tool: string, title: string, input: Record<string, unknown>) =>
    guard(tool, async () => {
      const result = await runTool(tool, input);
      const draft = { tool, title, result };
      setDrafts((current) => [draft, ...current.filter((d) => d.tool !== tool)]);
      setPreview(draft);
    });

  const executeWithApproval = (operation: string, input: Record<string, unknown>) =>
    guard(`approve:${operation}`, async () => {
      const approval = await requestApproval(operation);
      const result = await runTool(operation, input, approval.userApprovalToken);
      setExecutions((current) => [result, ...current]);
    });

  const executeWithoutToken = (operation: string, input: Record<string, unknown>) =>
    guard(`deny:${operation}`, async () => {
      const result = await runTool(operation, input);
      setExecutions((current) => [result, ...current]);
    });

  const ask = (text: string) =>
    guard("ask", async () => {
      const turn = await askCopilotQuestion(text);
      setTurns((current) => [turn, ...current]);
      setQuestion("");
    });

  const tier2 = [
    {
      operation: "execute_recovery_plan",
      title: "Execute the full recovery plan in the sandbox",
      detail: `${plan.actions.length} actions · ${money2(plan.total_cost)} · restores P10 to ${money2(
        plan.post_recovery_p10_balance,
      )}`,
      input: { plan_id: data.plan_id },
    },
    deferral
      ? {
          operation: "send_supplier_deferral_email",
          title: `Send the deferral request to ${deferral.target_id}`,
          detail: deferral.label,
          input: { payable_id: deferral.target_id, plan_id: data.plan_id },
        }
      : null,
    (() => {
      const draw = plan.actions.find((a) => a.kind === "bridge_draw");
      return draw
        ? {
            operation: "accept_financing_offer",
            title: `Draw down ${draw.target_id}`,
            detail: `${draw.label} · ${money2(draw.cost)} cost`,
            input: { financing_id: draw.target_id, amount: draw.cash_impact, plan_id: data.plan_id },
          }
        : null;
    })(),
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <div className="flex flex-col gap-4">
        <Card className="border-slate-200 dark:border-slate-800">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="size-4 text-amber-600 dark:text-amber-400" />
                Copilot briefing
              </CardTitle>
              <div className="flex flex-wrap gap-1.5">
                <AttestedBadge ok={data.copilot.narrative_integrity.ok} />
                <DeterministicBadge
                  method={
                    data.copilot.anthropic_key_present
                      ? `${data.copilot.model} + engine tools`
                      : "Deterministic synthesis"
                  }
                />
              </div>
            </div>
            <CardDescription className="text-xs">
              Every dollar figure below was matched against the quant engine&apos;s own output before this text was
              allowed out of the API route — {data.copilot.narrative_integrity.checkedDollarFigures.length} dollar
              figures and {data.copilot.narrative_integrity.checkedPercentages.length} percentages checked.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2 text-xs leading-relaxed text-slate-700 tabular-nums dark:text-slate-300">
              {data.copilot.narrative.split("\n\n").map((paragraph, index) => (
                <p key={index} className={cn(paragraph.startsWith("- ") && "pl-3 text-slate-600 dark:text-slate-400")}>
                  {paragraph.replace(/\*\*/g, "")}
                </p>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 dark:border-slate-800">
          <CardHeader>
            <SectionHeading title="Ask the copilot" hint={`plan ${data.plan_id}`} />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {SUGGESTED.map((suggestion) => (
                <Button
                  key={suggestion}
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => ask(suggestion)}
                  className="h-7 text-[11px]"
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (question.trim()) ask(question.trim());
              }}
            >
              <input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="e.g. what happens if Harbor Freight declines the discount?"
                className="h-9 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none focus-visible:border-slate-400 dark:border-slate-800 dark:bg-slate-950"
              />
              <Button type="submit" size="sm" disabled={busy !== null || !question.trim()}>
                {busy === "ask" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Ask
              </Button>
            </form>

            {turns.map((turn, index) => (
              <div
                key={`${turn.question}-${index}`}
                className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium">{turn.question}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <AttestedBadge ok={turn.attested} />
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {turn.source}
                      {turn.model ? ` · ${turn.model}` : ""}
                    </Badge>
                  </div>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed tabular-nums text-slate-700 dark:text-slate-300">
                  {turn.answer}
                </p>
                {turn.tool_runs.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {turn.tool_runs.map((run) => (
                      <Badge key={`${run.tool}-${run.seq}`} variant="outline" className="font-mono text-[10px]">
                        {run.tool} · {run.decision} · #{run.seq}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        {error ? (
          <div className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        ) : null}

        <Card className="border-slate-200 dark:border-slate-800">
          <CardHeader>
            <SectionHeading title="Staged Tier 1 drafts" hint="no side effects" />
            <CardDescription className="text-xs">
              Drafted text only. Sending any of it is a separate Tier 2 operation.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {discount ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  stageDraft("draft_customer_discount_offer", `Early-pay offer · ${discount.target_id}`, {
                    invoice_id: discount.target_id,
                  })
                }
                className="justify-start text-[11px]"
              >
                {busy === "draft_customer_discount_offer" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                Draft {discount.label}
              </Button>
            ) : null}
            {deferral ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  stageDraft("draft_supplier_deferral_email", `Deferral notice · ${deferral.target_id}`, {
                    payable_id: deferral.target_id,
                  })
                }
                className="justify-start text-[11px]"
              >
                {busy === "draft_supplier_deferral_email" ? <Loader2 className="size-4 animate-spin" /> : null}
                Draft {deferral.label}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => stageDraft("draft_recovery_plan_summary", "CFO recovery briefing", {})}
              className="justify-start text-[11px]"
            >
              {busy === "draft_recovery_plan_summary" ? <Loader2 className="size-4 animate-spin" /> : null}
              Draft the CFO recovery briefing
            </Button>

            {drafts.map((draft) => (
              <div key={draft.tool} className="rounded-lg border border-sky-200 p-2.5 dark:border-sky-900">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium">{draft.title}</p>
                  <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setPreview(draft)}>
                    Preview
                  </Button>
                </div>
                <GateTrace result={draft.result} />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border-amber-200 dark:border-amber-900">
          <CardHeader>
            <SectionHeading title="Tier 2 execution queue" hint="human approval required" />
            <CardDescription className="text-xs">
              The left button mints an HMAC token bound to this operation and this plan, then executes in the
              sandbox. The right one calls the same tool with no token, so you can watch the gate refuse it.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {tier2.map((entry) => (
              <div
                key={entry.operation}
                className="rounded-lg border border-slate-200 p-2.5 dark:border-slate-800"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium">{entry.title}</p>
                    <p className="mt-0.5 text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                      {entry.detail}
                    </p>
                  </div>
                  <TierBadge tier="TIER_2_HITL_APPROVAL" />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => executeWithApproval(entry.operation, entry.input)}
                    className="text-[11px]"
                  >
                    {busy === `approve:${entry.operation}` ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <KeyRound className="size-4" />
                    )}
                    Issue HMAC token &amp; execute
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy !== null}
                    onClick={() => executeWithoutToken(entry.operation, entry.input)}
                    className="text-[11px]"
                  >
                    {busy === `deny:${entry.operation}` ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ShieldX className="size-4" />
                    )}
                    Execute without token
                  </Button>
                </div>
              </div>
            ))}
            {executions.map((result, index) => (
              <GateTrace key={`${result.tool}-${result.seq}-${index}`} result={result} />
            ))}
          </CardContent>
        </Card>
      </div>

      <Dialog open={preview !== null} onOpenChange={(open) => (open ? null : setPreview(null))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{preview?.title}</DialogTitle>
            <DialogDescription className="text-xs">
              Tier 1 draft · {preview?.result.decision} · audit seq #{preview?.result.seq}. Nothing has been sent.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">
            {renderDraft(preview?.result.output)}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function renderDraft(output: unknown): string {
  if (!output || typeof output !== "object") return String(output ?? "");
  const payload = output as {
    draft?: { to?: string; subject?: string; body?: string };
    narrative?: string;
    denied?: boolean;
    reason?: string;
  };
  if (payload.draft) {
    return [`To: ${payload.draft.to}`, `Subject: ${payload.draft.subject}`, "", payload.draft.body].join("\n");
  }
  if (payload.narrative) return payload.narrative.replace(/\*\*/g, "");
  return JSON.stringify(output, null, 2);
}
