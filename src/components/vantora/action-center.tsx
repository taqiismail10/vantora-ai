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
import { FileWarning, KeyRound, Loader2, Lock, Send, ShieldCheck, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ActionResult, CopilotTurnResponse, DashboardState } from "@/lib/dashboard-state";
import { cn } from "@/lib/utils";

import { askCopilotQuestion, requestApproval, runTool } from "./client-api";
import { AttestationPopover } from "./attestation";
import { AttestedBadge, DecisionBadge, DeterministicBadge, money, money2, pct, SectionHeading, TierBadge } from "./primitives";

interface Draft {
  tool: string;
  title: string;
  result: ActionResult;
}

/** One Tier 2 action, with everything the approval dialog has to disclose. */
interface Tier2Entry {
  operation: string;
  title: string;
  detail: string;
  input: Record<string, unknown>;
  /** Dialog heading: "Authorize Tier-2 Action: …". */
  authorize: string;
  counterparty: string;
  moneyLeaves: string;
  moneyArrives: string;
  obligation: string;
  /** The figure the approver must type back, and which the token binds to. */
  confirmAmount: number;
}

const ACCOUNT_LABEL = "Smart Jeans operating account ••4471";

/** Plain-English supplier archetype for the approval disclosure. */
const ARCHETYPE_LABEL: Record<string, string> = {
  MONOPOLY_STRICT: "single-source, not deferrable",
  FLEXIBLE_PARTNER: "strategic partner",
  COMMERCIAL_NEGOTIATOR: "commercial mill",
  STATUTORY: "statutory",
  OVERHEAD: "overhead",
};

/** Invoices the buyer's own ERP has blocked. They need a document, not a discount. */
const MATCH_EXCEPTIONS = new Set(["QTY_VARIANCE", "PRICE_VARIANCE"]);

/** `d` days from today, as a human date. Called only inside an open dialog. */
function offsetDate(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
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
  const [executions, setExecutions] = useState<ActionResult[]>([]);
  const [turns, setTurns] = useState<CopilotTurnResponse[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<Tier2Entry | null>(null);
  const [typed, setTyped] = useState("");

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

  const executeWithApproval = (entry: Tier2Entry) =>
    guard(`approve:${entry.operation}`, async () => {
      // Same input on both calls, and the amount the human typed travels with
      // the mint: the token is bound to this exact payload and this figure.
      const approval = await requestApproval(entry.operation, entry.input, entry.confirmAmount);
      const result = await runTool(entry.operation, entry.input, approval.userApprovalToken);
      setExecutions((current) => [result, ...current]);
      setApproving(null);
      setTyped("");
    });

  const ask = (text: string) =>
    guard("ask", async () => {
      const turn = await askCopilotQuestion(text);
      setTurns((current) => [turn, ...current]);
      setQuestion("");
    });

  const draw = plan.actions.find((a) => a.kind === "bridge_draw");
  const drawOption = draw ? data.state.financing_options.find((f) => f.id === draw.target_id) : undefined;
  const deferralPayable = deferral
    ? data.state.payables_ap.find((p) => p.id === deferral.target_id)
    : undefined;
  const crunchDay = data.optimization.crunch_day;

  const tier2: Tier2Entry[] = ([
    {
      operation: "execute_recovery_plan" as const,
      title: "Execute the full recovery plan in the sandbox",
      detail: `${plan.actions.length} actions · ${money2(plan.total_cost)} · restores P10 to ${money2(
        plan.post_recovery_p10_balance,
      )}`,
      input: { plan_id: data.plan_id },
      authorize: "Execute the full recovery plan",
      counterparty: `${plan.actions.length} counterparties across AR, AP and financing`,
      moneyLeaves: `${money2(plan.total_cost)} in fees and discounts`,
      moneyArrives: `${money(plan.cash_raised)} of working capital, by day ${crunchDay}`,
      obligation: `Each action settles on its own terms; the plan itself adds no new debt beyond the draws listed in it.`,
      confirmAmount: plan.total_cost,
    },
    deferral && deferralPayable
      ? {
          operation: "send_supplier_deferral_email",
          title: `Send the deferral request to ${deferral.target_id}`,
          detail: deferral.label,
          input: { payable_id: deferral.target_id, plan_id: data.plan_id },
          authorize: `Send a payment-deferral request to ${deferralPayable.supplier_name}`,
          counterparty: `${deferralPayable.supplier_name} — ${
            ARCHETYPE_LABEL[deferralPayable.supplier_archetype ?? "OVERHEAD"]
          }${
            (deferralPayable.past_extension_count ?? 0) >= 1
              ? ", goodwill already spent"
              : ", first schedule change asked of them"
          }`,
          moneyLeaves: "Nothing today",
          moneyArrives: `${money(deferralPayable.amount)} stays in the account past day ${deferralPayable.due_day}`,
          obligation: `${money2(deferralPayable.amount + (deferralPayable.deferral_fee_pct ?? 0) * deferralPayable.amount)} on ${offsetDate(
            deferralPayable.due_day + (deferralPayable.max_deferral_days ?? 0),
          )} (${deferralPayable.max_deferral_days}d deferral @ ${pct(deferralPayable.deferral_fee_pct ?? 0, 2)} fee)`,
          confirmAmount: deferralPayable.amount,
        }
      : null,
    draw && drawOption
      ? {
          operation: "accept_financing_offer",
          title: `Draw down ${draw.target_id}`,
          detail: `${draw.label} · ${money2(draw.cost)} cost`,
          input: { financing_id: draw.target_id, amount: draw.cash_impact, plan_id: data.plan_id },
          authorize: `Draw on the ${drawOption.provider} line`,
          counterparty: `${drawOption.provider}${
            drawOption.is_existing_facility ? " — existing, already underwritten" : ""
          }${
            drawOption.requires_notice_of_assignment
              ? ", notifies your buyer"
              : ", confidential: your buyer is never notified"
          }`,
          moneyLeaves: "Nothing today",
          moneyArrives: `${money(draw.cash_impact)} into ${ACCOUNT_LABEL}`,
          obligation: `${money2(draw.cash_impact + draw.cost)} on ${offsetDate(30)} (30 days @ ${pct(
            drawOption.apr,
          )} APR)`,
          confirmAmount: draw.cash_impact,
        }
      : null,
  ] as (Tier2Entry | null)[]).filter((entry): entry is Tier2Entry => entry !== null);

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
                <AttestationPopover
                  integrity={data.copilot.narrative_integrity}
                  blocked={integrityDenials}
                  source={
                    data.copilot.anthropic_key_present
                      ? `${data.copilot.model} with engine tools`
                      : "the deterministic synthesiser"
                  }
                />
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
                placeholder="e.g. what happens if Zara declines the early-settlement offer?"
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
            {/* Not a lever in the plan, and deliberately offered anyway: the
                cash behind a blocked invoice is unreachable until the dock
                exception clears, so the clerical note is the highest-value
                Tier 1 draft on the board even though the solver cannot price
                it. It is clerk-signed, never owner-signed. */}
            {blocked ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
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
                  <FileWarning className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
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
              Each action opens a confirmation that discloses where the money goes and asks you to type the
              amount back. Only then is an HMAC token minted, bound to that exact payload and figure.
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
                    onClick={() => {
                      setTyped("");
                      setApproving(entry);
                    }}
                    className="text-[11px]"
                  >
                    {busy === `approve:${entry.operation}` ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <KeyRound className="size-4" />
                    )}
                    Review &amp; approve
                  </Button>
                </div>
              </div>
            ))}
            {executions.map((result, index) => (
              <GateTrace key={`${result.tool}-${result.seq}-${index}`} result={result} />
            ))}
            {/* The bypass button that used to sit here is gone: a one-click
                "execute without token" next to the real control is a footgun in
                a product, and the drill already proves the gate refuses it. */}
            <p className="flex items-start gap-1.5 border-t border-slate-100 pt-2 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-slate-400" />
              Protected by the 4-tier permission gate — unauthorised calls are blocked without a human token
              (proven live in the security drill).
            </p>
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={approving !== null}
        onOpenChange={(open) => {
          if (!open) {
            setApproving(null);
            setTyped("");
          }
        }}
      >
        <DialogContent className="max-w-xl">
          {approving ? (
            <ApprovalDialogBody
              entry={approving}
              data={data}
              typed={typed}
              onTyped={setTyped}
              busy={busy === `approve:${approving.operation}`}
              onConfirm={() => executeWithApproval(approving)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

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

function DisclosureRow({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" }) {
  return (
    <div className="grid grid-cols-[9.5rem_1fr] gap-x-3 gap-y-0.5 border-t border-slate-100 py-1.5 first:border-t-0 dark:border-slate-800">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <span
        className={cn(
          "text-xs tabular-nums",
          tone === "good" && "font-medium text-emerald-600 dark:text-emerald-400",
          tone === "warn" && "font-medium text-amber-700 dark:text-amber-400",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The cognitive-review step.
 *
 * Reading is not consent, and clicking is not reading. The amount has to be
 * typed back, which is the only interaction that cannot be performed by
 * muscle memory — and the typed figure is what gets hashed into the token.
 */
function ApprovalDialogBody({
  entry,
  data,
  typed,
  onTyped,
  busy,
  onConfirm,
}: {
  entry: Tier2Entry;
  data: DashboardState;
  typed: string;
  onTyped: (next: string) => void;
  busy: boolean;
  onConfirm: () => void;
}) {
  const plan = data.optimization.optimal_plan;
  const crunchDay = data.optimization.crunch_day;
  const crunchP10 = data.forecast.p10_trajectory[crunchDay - 1];
  // Accept "2345", "2,345" and "2345.00": commas and a trailing .00 are how a
  // human writes money, not a different number.
  const normalised = Number(typed.replace(/[,\s$]/g, ""));
  const matches = Number.isFinite(normalised) && Math.abs(normalised - entry.confirmAmount) < 0.005;
  const target = entry.confirmAmount.toLocaleString("en-US", { maximumFractionDigits: 2 });

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm">Authorize Tier-2 action: {entry.authorize}</DialogTitle>
        <DialogDescription className="text-xs">
          Executed in the sandbox against the seeded dataset. Read the cash direction before confirming.
        </DialogDescription>
      </DialogHeader>

      <div className="rounded-md border border-slate-200 px-3 py-1 dark:border-slate-800">
        <DisclosureRow label="Money leaves" value={entry.moneyLeaves} />
        <DisclosureRow label="Money arrives" value={entry.moneyArrives} tone="good" />
        <DisclosureRow label="Obligation" value={entry.obligation} tone="warn" />
        <DisclosureRow label="Counterparty" value={entry.counterparty} />
        <DisclosureRow
          label={`Impact on day ${crunchDay}`}
          value={
            plan.feasible
              ? `Cash restored from ${money(crunchP10)} to ${money(plan.post_recovery_p10_balance)} — safe buffer maintained`
              : `No feasible plan; the day-${crunchDay} gap stays open`
          }
          tone={plan.feasible ? "good" : undefined}
        />
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">
          Type <span className="font-mono tabular-nums">{target}</span> to confirm
        </span>
        <input
          value={typed}
          onChange={(event) => onTyped(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          aria-label={`Type ${target} to confirm`}
          placeholder={target}
          className={cn(
            "h-9 rounded-md border bg-white px-3 font-mono text-sm tabular-nums outline-none dark:bg-slate-950",
            matches
              ? "border-emerald-500 focus-visible:border-emerald-500"
              : "border-slate-200 focus-visible:border-slate-400 dark:border-slate-800",
          )}
        />
      </label>

      <p className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        This action issues a single-use HMAC token bound to this exact payload and amount. Once transmitted,
        the sandbox facility draw cannot be recalled from this interface.
      </p>

      <p className="font-mono text-[10px] text-slate-500 dark:text-slate-500">
        Solver: {data.engine.optimization_source === "python-fastapi" ? "HiGHS MILP" : "TS mirror"} · Plan:{" "}
        {data.plan_id} · Sequence: next append
      </p>

      <DialogFooter>
        <Button size="sm" disabled={!matches || busy} onClick={onConfirm} className="text-[11px]">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
          Sign &amp; send — {money(entry.confirmAmount)}
        </Button>
      </DialogFooter>
    </>
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
