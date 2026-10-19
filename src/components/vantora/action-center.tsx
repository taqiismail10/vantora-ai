"use client";

/**
 * Tab 3 — Copilot Action Center.
 *
 * The queue is the point: a Tier 1 draft is produced and shown, and nothing
 * moves to execution without a human reading what the action actually does and
 * typing the amount back. The gate is proven by the red-team drill, not by a
 * bypass button sitting next to the real one.
 */

import { useState } from "react";
import { FileWarning, Loader2, Send, Sparkles } from "lucide-react";

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PROVIDER_LABEL } from "@/lib/agent/llm";
import type { ActionResult, CopilotTurnResponse, DashboardState } from "@/lib/dashboard-state";
import type { ArInvoiceInput } from "@/lib/quant-client";
import { cn } from "@/lib/utils";

import { BuyerPortalPreview } from "./buyer-portal";
import { askCopilotQuestion, runTool, scenarioOf } from "./client-api";
import { ExecutionQueue } from "./execution-queue";
import { AttestationPopover } from "./attestation";
import { AttestedBadge, DecisionBadge, DeterministicBadge, money, SectionHeading, TierBadge } from "./primitives";

interface Draft {
  tool: string;
  title: string;
  result: ActionResult;
  /**
   * Set only for a genuine early-payment offer. The same tool also drafts the
   * GR/IR reconciliation note, which has no settlement to preview — so the
   * modal keys off the invoice, not off the tool name.
   */
  portal?: ArInvoiceInput;
}

/** Invoices the buyer's own ERP has blocked. They need a document, not a discount. */
const MATCH_EXCEPTIONS = new Set(["QTY_VARIANCE", "PRICE_VARIANCE"]);

const SUGGESTED = [
  "Why does cash break on day 14?",
  "What does the plan cost versus borrowing?",
  "Which financing facilities were rejected and why?",
  "What if Zara declines the early-settlement offer?",
  "What stops you executing this yourself?",
];

/** What a fallback means, and what would fix it. */
/** `p` is the configured provider's name ("Gemini", "OpenRouter"), or "The AI provider". */
const FALLBACK_COPY: Record<string, (p: string) => string> = {
  not_configured: (p) => `${p} is not configured on this server (the owner sets its API key).`,
  invalid_configuration: () => "The AI provider setting on the server is invalid (see AI_PROVIDER in the server log).",
  provider_error: (p) => `${p} returned an error. Check the key, the model name and the server log, then ask again.`,
  model_incompatible: (p) => `The configured ${p} model cannot call Vantora's tools, so no model answer was used.`,
  timeout: (p) => `${p} did not answer within 20 seconds. Ask again in a moment.`,
  empty_response: (p) => `${p} returned an empty answer.`,
  malformed_response: (p) => `${p} returned a malformed tool call.`,
  tool_loop_limit: (p) => `${p} kept calling tools without answering, so the loop was stopped.`,
  integrity_failure: (p) => `${p}'s answer quoted a figure the engine never produced, so it was withheld.`,
};

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
      <p className="truncate font-mono text-slate-500 dark:text-slate-600">
        hash {result.currentLogHash.slice(0, 32)}…
      </p>
    </div>
  );
}

export function ActionCenter({
  data,
  onLedgerChanged,
  openPlanApproval,
  onPlanApprovalHandled,
}: {
  data: DashboardState;
  onLedgerChanged: () => Promise<void> | void;
  openPlanApproval?: boolean;
  onPlanApprovalHandled?: () => void;
}) {
  const canDraft = data.viewer.capabilities.includes("draft");
  const canAsk = data.viewer.capabilities.includes("analyze");
  const scenario = scenarioOf(data);
  const plan = data.optimization.optimal_plan;
  const discount = plan.actions.find((a) => a.kind === "ar_early_discount");
  const deferral = plan.actions.find((a) => a.kind === "ap_deferral");
  const blocked = data.state.invoices_ar.find((i) => MATCH_EXCEPTIONS.has(i.match_status ?? ""));
  // Entries where this exact check already refused a fabricated figure, read
  // off the live chain rather than hard-coded, so the popover cites evidence
  // that exists rather than evidence we expect to exist.
  const integrityDenials = data.audit.entries
    .filter((entry) => entry.decision === "DENIED" && entry.reason.startsWith("numerical integrity failure"))
    .map((entry) => ({ seq: entry.seq, reason: entry.reason }));

  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [preview, setPreview] = useState<Draft | null>(null);
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

  const stageDraft = (
    tool: string,
    title: string,
    input: Record<string, unknown>,
    portal?: ArInvoiceInput,
  ) =>
    guard(tool, async () => {
      const result = await runTool(scenario, tool, input);
      const draft = { tool, title, result, portal };
      setDrafts((current) => [draft, ...current.filter((d) => d.tool !== tool)]);
      setPreview(draft);
    });

  const ask = (text: string) =>
    guard("ask", async () => {
      const turn = await askCopilotQuestion(scenario, text);
      setTurns((current) => [turn, ...current]);
      setQuestion("");
    });

  const crunchDay = data.optimization.crunch_day;
  const discountInvoice = discount ? data.state.invoices_ar.find((i) => i.id === discount.target_id) : undefined;
  const payrollLockDay = data.state.payables_ap.find((p) => p.is_payroll)?.payroll_lock_day ?? null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <div className="flex flex-col gap-4">
        <Card className="border-slate-200 dark:border-slate-800">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="size-4 text-amber-700 dark:text-amber-400" />
                Copilot briefing
              </CardTitle>
              <div className="flex flex-wrap gap-1.5">
                {/* The briefing is always the deterministic synthesiser's: it is
                    rebuilt on every load from engine output. Model answers
                    appear below, each labelled with its actual source. */}
                <AttestationPopover
                  integrity={data.copilot.narrative_integrity}
                  blocked={integrityDenials}
                  source="the deterministic synthesiser"
                />
                <DeterministicBadge method="Deterministic briefing" />
              </div>
            </div>
            <CardDescription className="text-xs">
              Every dollar figure below was matched against the quant engine&apos;s own output before this text was
              allowed out of the API route — {data.copilot.narrative_integrity.checkedDollarFigures.length} dollar
              figures and {data.copilot.narrative_integrity.checkedPercentages.length} percentages checked.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* No tabular-nums on prose: fixed-advance digits inside running
                text stretch the words around them and read as a spreadsheet. */}
            <div className="flex flex-col gap-2 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
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
                  disabled={busy !== null || !canAsk}
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
                placeholder="e.g. what happens if Zara declines the early-settlement offer?"
                className="h-9 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none focus-visible:border-slate-400 dark:border-slate-800 dark:bg-slate-950"
              />
              <Button type="submit" size="sm" disabled={busy !== null || !question.trim() || !canAsk}>
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
                      {turn.source !== "deterministic" && turn.model
                        ? `${PROVIDER_LABEL[turn.source]} · ${turn.model}`
                        : "Deterministic fallback"}
                    </Badge>
                  </div>
                </div>
                {turn.source === "deterministic" && turn.fallback_reason ? (
                  <p className="mt-1 text-[11px] text-amber-800 dark:text-amber-300">
                    {(FALLBACK_COPY[turn.fallback_reason] ?? (() => "The AI model was unavailable."))(
                      turn.provider ? PROVIDER_LABEL[turn.provider] : "The AI provider",
                    )}{" "}
                    This answer came from the
                    deterministic synthesiser over the same engine output.
                  </p>
                ) : null}
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-700 dark:text-slate-300">
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
                disabled={busy !== null || !canDraft}
                onClick={() =>
                  stageDraft(
                    "draft_customer_discount_offer",
                    `Early-pay offer · ${discount.target_id}`,
                    { invoice_id: discount.target_id },
                    discountInvoice,
                  )
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
                disabled={busy !== null || !canDraft}
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
            {/* Not a lever in the plan, and deliberately offered anyway: the
                cash behind a blocked invoice is unreachable until the dock
                exception clears, so the clerical note is the highest-value
                Tier 1 draft on the board even though the solver cannot price
                it. It is clerk-signed, never owner-signed. */}
            {blocked ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null || !canDraft}
                onClick={() =>
                  stageDraft(
                    "draft_customer_discount_offer",
                    `3-way reconciliation · ${blocked.id}`,
                    { invoice_id: blocked.id },
                  )
                }
                className="h-auto justify-start py-1.5 text-left text-[11px] whitespace-normal"
              >
                {busy === "draft_customer_discount_offer" ? (
                  <Loader2 className="size-4 shrink-0 animate-spin" />
                ) : (
                  <FileWarning className="size-4 shrink-0 text-amber-700 dark:text-amber-400" />
                )}
                <span>
                  Draft the 3-way reconciliation request to {blocked.customer_name}
                  <span className="block text-[10px] font-normal text-slate-500 dark:text-slate-400">
                    {money(blocked.amount)} blocked in their GR/IR queue · clerk-signed
                  </span>
                </span>
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || !canDraft}
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

        <ExecutionQueue
          data={data}
          onChanged={onLedgerChanged}
          openPlanApproval={openPlanApproval}
          onPlanApprovalHandled={onPlanApprovalHandled}
        />
      </div>


      <Dialog open={preview !== null} onOpenChange={(open) => (open ? null : setPreview(null))}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{preview?.title}</DialogTitle>
            <DialogDescription className="text-xs">
              Tier 1 draft · {preview?.result.decision} · audit seq #{preview?.result.seq}. Nothing has been sent.
            </DialogDescription>
          </DialogHeader>
          {preview?.portal ? (
            <Tabs defaultValue="email">
              <TabsList className="h-9 w-full justify-start">
                <TabsTrigger value="email" className="shrink-0 text-[11px]">
                  Outbound email draft
                </TabsTrigger>
                <TabsTrigger value="portal" className="shrink-0 text-[11px]">
                  Buyer portal preview
                </TabsTrigger>
              </TabsList>
              <TabsContent value="email" className="flex flex-col gap-2 pt-1">
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Controller signatory · no distress language · {preview.portal.allowed_signatory_role}
                </p>
                <DraftBody output={preview.result.output} />
              </TabsContent>
              <TabsContent value="portal" className="flex flex-col gap-2 pt-1">
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  What {preview.portal.customer_name}&apos;s treasury team sees behind the magic link.
                </p>
                <div className="max-h-[52vh] overflow-auto pr-1">
                  <BuyerPortalPreview
                    invoice={preview.portal}
                    crunchDay={crunchDay}
                    payrollLockDay={payrollLockDay}
                  />
                </div>
              </TabsContent>
            </Tabs>
          ) : (
            <DraftBody output={preview?.result.output} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DraftBody({ output }: { output: unknown }) {
  return (
    <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">
      {renderDraft(output)}
    </pre>
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
