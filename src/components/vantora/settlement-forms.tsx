"use client";

/**
 * Settlement: what has actually been paid, credited and matched.
 *
 * The three records stay visibly distinct because they do different things —
 * a payment moves cash, an adjustment changes what is owed without moving
 * cash, and an allocation only points an existing one at an invoice. Every
 * form says which of those it is doing before it is submitted, because the
 * difference is the whole point and is not obvious from an amount alone.
 *
 * Nothing here is reconciled against a bank. Vantora has no bank connection,
 * so every row is what someone typed, and the section says so.
 */

import { useMemo, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, Undo2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  companyAction,
  formatMinor,
  type AdjustmentRow,
  type BalanceRow,
  type PayableRow,
  type PaymentRow,
  type ReceivableRow,
  type Settlement,
} from "./company-api";
import { Check, Empty, Field, FormShell, INPUT, useSubmit } from "./company-forms";

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A typed amount in minor units, or null when it is not a usable figure.
 *
 * Everything downstream adds and subtracts integers: the only float here is
 * the single parse, which the server repeats and is the authority on anyway.
 */
function toCents(value: string): number | null {
  const normalised = value.trim().replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;
  return Math.round(Number(normalised) * 100);
}

/** One obligation a payment or credit note can be applied to. */
interface Target {
  id: string;
  kind: "receivable" | "payable";
  label: string;
  dueDate: string;
  remainingCents: number;
}

function buildTargets(
  receivables: ReceivableRow[],
  payables: PayableRow[],
  balances: BalanceRow[],
): Target[] {
  const byId = new Map(balances.map((b) => [b.id, b]));
  const open = <T extends { id: string; status: string; counterpartyName: string; dueDate: string; amountCents: number }>(
    rows: T[],
    kind: "receivable" | "payable",
  ): Target[] =>
    rows
      .filter((row) => row.status !== "cancelled")
      .map((row) => ({
        id: row.id,
        kind,
        label: row.counterpartyName,
        dueDate: row.dueDate,
        remainingCents: byId.get(row.id)?.remainingCents ?? row.amountCents,
      }))
      .filter((target) => target.remainingCents > 0);
  return [...open(receivables, "receivable"), ...open(payables, "payable")];
}

/** A line in the preview shown before anything is posted. */
function PreviewLine({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className={cn("font-medium tabular-nums", muted ? "text-slate-500 dark:text-slate-400" : "text-slate-900 dark:text-slate-100")}>
        {value}
      </span>
    </div>
  );
}

function Preview({ children }: { children: ReactNode }) {
  return (
    <div className="sm:col-span-2 flex flex-col gap-1 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-[11px] leading-relaxed dark:border-slate-800 dark:bg-slate-900/60">
      <p className="font-medium text-slate-700 dark:text-slate-300">Before you post this</p>
      {children}
    </div>
  );
}

// --- Allocation rows shared by the payment and adjustment forms ------------

interface Line {
  targetId: string;
  amount: string;
}

function AllocationLines({
  targets,
  lines,
  setLines,
  currency,
  limitKind,
}: {
  targets: Target[];
  lines: Line[];
  setLines: (next: Line[]) => void;
  currency: string;
  limitKind?: "receivable" | "payable";
}) {
  const usable = limitKind ? targets.filter((t) => t.kind === limitKind) : targets;
  if (usable.length === 0) {
    return (
      <p className="sm:col-span-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
        Nothing is outstanding to match this against. You can still post it and match it later.
      </p>
    );
  }
  const update = (index: number, patch: Partial<Line>) =>
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  return (
    <div className="sm:col-span-2 flex flex-col gap-2">
      <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
        Match against <span className="ml-1 font-normal text-slate-400 dark:text-slate-500">(optional)</span>
      </span>
      {lines.map((line, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <select
            aria-label={`Invoice or bill for line ${index + 1}`}
            className={cn(INPUT, "min-w-0 flex-1")}
            value={line.targetId}
            onChange={(event) => update(index, { targetId: event.target.value })}
          >
            <option value="">Select…</option>
            {usable.map((target) => (
              <option key={target.id} value={target.id}>
                {target.label} · due {target.dueDate} · {formatMinor(target.remainingCents, currency)} left
              </option>
            ))}
          </select>
          <input
            aria-label={`Amount for line ${index + 1}`}
            inputMode="decimal"
            placeholder="Amount"
            className={cn(INPUT, "w-32")}
            value={line.amount}
            onChange={(event) => update(index, { amount: event.target.value })}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-9 text-[11px]"
            onClick={() => setLines(lines.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-fit text-[11px]"
        onClick={() => setLines([...lines, { targetId: "", amount: "" }])}
      >
        Add a line
      </Button>
    </div>
  );
}

const allocationPayload = (lines: Line[], targets: Target[]) =>
  lines
    .filter((line) => line.targetId && toCents(line.amount) !== null)
    .map((line) => ({
      targetKind: targets.find((t) => t.id === line.targetId)?.kind ?? "receivable",
      targetId: line.targetId,
      amount: line.amount,
    }));

const allocatedCents = (lines: Line[]) =>
  lines.reduce((sum, line) => sum + (line.targetId ? (toCents(line.amount) ?? 0) : 0), 0);

// --- Record a payment ------------------------------------------------------

export function PaymentForm({
  targets,
  counterparties,
  currency,
  openingCutoff,
  onSaved,
}: {
  targets: Target[];
  counterparties: { id: string; name: string }[];
  currency: string;
  openingCutoff: string | null;
  onSaved: () => void;
}) {
  const [direction, setDirection] = useState<"receipt" | "disbursement">("receipt");
  const [amount, setAmount] = useState("");
  const [effectiveDate, setDate] = useState(today());
  const [counterpartyId, setParty] = useState("");
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [override, setOverride] = useState<boolean | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const { busy, error, run } = useSubmit(onSaved);

  // One key per submission attempt, kept across a retry of the same attempt so
  // a double-click or a resend cannot post the payment twice.
  const key = useRef<string | null>(null);

  const insideOpening = openingCutoff !== null && effectiveDate <= openingCutoff;
  const alreadyInOpeningBalance = override ?? insideOpening;
  const cents = toCents(amount);
  const allocated = allocatedCents(lines);
  const unallocated = cents === null ? null : cents - allocated;
  const future = effectiveDate > today();

  return (
    <FormShell
      title="Record a payment"
      description="Money that actually moved — a customer paying you, or you paying a supplier."
      error={error}
      busy={busy}
      submitLabel="Record payment"
      onSubmit={() => {
        key.current ??= crypto.randomUUID();
        void run(
          () =>
            companyAction("record_payment", {
              direction,
              amount,
              effectiveDate,
              idempotencyKey: key.current,
              ...(counterpartyId ? { counterpartyId } : {}),
              ...(method ? { method } : {}),
              ...(reference ? { reference } : {}),
              ...(alreadyInOpeningBalance ? { alreadyInOpeningBalance: true } : {}),
              ...(lines.length ? { allocations: allocationPayload(lines, targets) } : {}),
            }),
          () => {
            key.current = null;
            setAmount("");
            setReference("");
            setLines([]);
            setOverride(null);
          },
        );
      }}
    >
      <Field label="Direction" required>
        {(id) => (
          <select
            id={id}
            className={INPUT}
            value={direction}
            onChange={(event) => setDirection(event.target.value as "receipt" | "disbursement")}
          >
            <option value="receipt">Money in — a customer paid us</option>
            <option value="disbursement">Money out — we paid a supplier</option>
          </select>
        )}
      </Field>
      <Field label="Amount" required>
        {(id) => (
          <input id={id} inputMode="decimal" className={INPUT} value={amount} onChange={(e) => setAmount(e.target.value)} />
        )}
      </Field>
      <Field label="Date the money moved" required hint="Not the date you are entering it. Only this date affects cash.">
        {(id) => <input id={id} type="date" className={INPUT} value={effectiveDate} onChange={(e) => setDate(e.target.value)} />}
      </Field>
      <Field label="Counterparty">
        {(id) => (
          <select id={id} className={INPUT} value={counterpartyId} onChange={(e) => setParty(e.target.value)}>
            <option value="">Not stated</option>
            {counterparties.map((party) => (
              <option key={party.id} value={party.id}>
                {party.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Method" hint="Bank transfer, cheque, cash — your own wording.">
        {(id) => <input id={id} className={INPUT} value={method} onChange={(e) => setMethod(e.target.value)} />}
      </Field>
      <Field label="Reference">
        {(id) => <input id={id} className={INPUT} value={reference} onChange={(e) => setReference(e.target.value)} />}
      </Field>

      <div className="sm:col-span-2">
        <Check
          label="Already included in an opening balance"
          hint={
            openingCutoff
              ? `Your opening balances are true as of ${openingCutoff}. Money that moved on or before that date is already counted in them, so recording it here must not add it again — but it can still settle an invoice.`
              : "Add an account with its opening balance first."
          }
          checked={alreadyInOpeningBalance}
          onChange={(next) => setOverride(next)}
        />
      </div>

      <AllocationLines targets={targets} lines={lines} setLines={setLines} currency={currency} />

      <Preview>
        <PreviewLine
          label="Cash impact"
          muted={alreadyInOpeningBalance || future}
          value={
            alreadyInOpeningBalance
              ? "No cash impact — already inside an opening balance"
              : cents === null
                ? "—"
                : future
                  ? `${formatMinor(direction === "receipt" ? cents : -cents, currency)}, but dated ahead, so not counted as cash you hold now`
                  : formatMinor(direction === "receipt" ? cents : -cents, currency)
          }
        />
        <PreviewLine
          label="Applied to invoices or bills"
          value={allocated === 0 ? "Nothing matched yet" : formatMinor(allocated, currency)}
        />
        <PreviewLine
          label="Left unmatched"
          muted
          value={
            unallocated === null
              ? "—"
              : unallocated < 0
                ? "More matched than the payment — the server will refuse this"
                : formatMinor(unallocated, currency)
          }
        />
      </Preview>
    </FormShell>
  );
}

// --- Record an adjustment --------------------------------------------------

export function AdjustmentForm({
  targets,
  currency,
  onSaved,
}: {
  targets: Target[];
  currency: string;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<"credit_note" | "debit_note">("credit_note");
  const [targetKind, setTargetKind] = useState<"receivable" | "payable">("receivable");
  const [amount, setAmount] = useState("");
  const [effectiveDate, setDate] = useState(today());
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const { busy, error, run } = useSubmit(onSaved);
  const key = useRef<string | null>(null);

  const cents = toCents(amount);
  const allocated = allocatedCents(lines);

  return (
    <FormShell
      title="Record a credit or debit note"
      description="Changes what is owed without any money moving — a short delivery, a price correction, a returned batch."
      error={error}
      busy={busy}
      submitLabel="Record note"
      onSubmit={() => {
        key.current ??= crypto.randomUUID();
        void run(
          () =>
            companyAction("record_adjustment", {
              kind,
              targetKind,
              amount,
              effectiveDate,
              idempotencyKey: key.current,
              ...(reason ? { reason } : {}),
              ...(lines.length ? { allocations: allocationPayload(lines, targets).map(({ targetId, amount: a }) => ({ targetId, amount: a })) } : {}),
            }),
          () => {
            key.current = null;
            setAmount("");
            setReason("");
            setLines([]);
          },
        );
      }}
    >
      <Field label="Type" required>
        {(id) => (
          <select id={id} className={INPUT} value={kind} onChange={(e) => setKind(e.target.value as "credit_note" | "debit_note")}>
            <option value="credit_note">Credit note — reduces what is owed</option>
            <option value="debit_note">Debit note — increases what is owed</option>
          </select>
        )}
      </Field>
      <Field label="Applies to" required>
        {(id) => (
          <select
            id={id}
            className={INPUT}
            value={targetKind}
            onChange={(event) => {
              setTargetKind(event.target.value as "receivable" | "payable");
              setLines([]);
            }}
          >
            <option value="receivable">An invoice we issued</option>
            <option value="payable">A bill we received</option>
          </select>
        )}
      </Field>
      <Field label="Amount" required>
        {(id) => <input id={id} inputMode="decimal" className={INPUT} value={amount} onChange={(e) => setAmount(e.target.value)} />}
      </Field>
      <Field label="Date" required>
        {(id) => <input id={id} type="date" className={INPUT} value={effectiveDate} onChange={(e) => setDate(e.target.value)} />}
      </Field>
      <Field label="Reason" hint="Worth recording — this is what explains the change later.">
        {(id) => <input id={id} className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>

      <AllocationLines targets={targets} lines={lines} setLines={setLines} currency={currency} limitKind={targetKind} />

      <Preview>
        <PreviewLine label="Cash impact" muted value="None — a note never moves money" />
        <PreviewLine
          label={kind === "credit_note" ? "Reduces what is owed by" : "Increases what is owed by"}
          value={allocated === 0 ? (cents === null ? "—" : "Nothing matched yet") : formatMinor(allocated, currency)}
        />
      </Preview>
    </FormShell>
  );
}

// --- Match an existing payment --------------------------------------------

export function AllocateForm({
  payments,
  adjustments,
  targets,
  currency,
  onSaved,
}: {
  payments: PaymentRow[];
  adjustments: AdjustmentRow[];
  targets: Target[];
  currency: string;
  onSaved: () => void;
}) {
  const sources = useMemo(
    () => [
      ...payments
        .filter((p) => !p.reversedAt && p.unallocatedCents > 0)
        .map((p) => ({
          kind: "payment" as const,
          id: p.id,
          label: `${p.direction === "receipt" ? "Money in" : "Money out"} · ${p.effectiveDate}${p.counterpartyName ? ` · ${p.counterpartyName}` : ""}`,
          unallocatedCents: p.unallocatedCents,
        })),
      ...adjustments
        .filter((a) => !a.reversedAt && a.unallocatedCents > 0)
        .map((a) => ({
          kind: "adjustment" as const,
          id: a.id,
          label: `${a.kind === "credit_note" ? "Credit note" : "Debit note"} · ${a.effectiveDate}`,
          unallocatedCents: a.unallocatedCents,
        })),
    ],
    [payments, adjustments],
  );

  const [sourceId, setSource] = useState("");
  const [targetId, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const { busy, error, run } = useSubmit(onSaved);

  const source = sources.find((s) => s.id === sourceId);
  const target = targets.find((t) => t.id === targetId);

  if (sources.length === 0) {
    return <Empty>Nothing is waiting to be matched. Every payment and note you have recorded is fully applied.</Empty>;
  }

  return (
    <FormShell
      title="Match money already recorded"
      description="Points a payment or note you have already entered at an invoice or bill. Nothing new moves — the cash was counted when the payment was recorded."
      error={error}
      busy={busy}
      submitLabel="Match it"
      onSubmit={() =>
        run(
          () =>
            companyAction("allocate", {
              sourceKind: source?.kind ?? "payment",
              sourceId,
              targetKind: target?.kind ?? "receivable",
              targetId,
              amount,
            }),
          () => {
            setAmount("");
            setTarget("");
          },
        )
      }
    >
      <Field label="Money to apply" required>
        {(id) => (
          <select id={id} className={INPUT} value={sourceId} onChange={(e) => setSource(e.target.value)}>
            <option value="">Select…</option>
            {sources.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} · {formatMinor(option.unallocatedCents, currency)} unmatched
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Apply it to" required>
        {(id) => (
          <select id={id} className={INPUT} value={targetId} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Select…</option>
            {targets.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} · due {option.dueDate} · {formatMinor(option.remainingCents, currency)} left
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Amount" required>
        {(id) => <input id={id} inputMode="decimal" className={INPUT} value={amount} onChange={(e) => setAmount(e.target.value)} />}
      </Field>
      <Preview>
        <PreviewLine label="Cash impact" muted value="None — this money was already counted when it was recorded" />
        <PreviewLine
          label="Still unmatched after this"
          value={
            source && toCents(amount) !== null
              ? formatMinor(source.unallocatedCents - (toCents(amount) ?? 0), currency)
              : source
                ? formatMinor(source.unallocatedCents, currency)
                : "—"
          }
        />
      </Preview>
    </FormShell>
  );
}

// --- Outstanding balances --------------------------------------------------

export function BalancesTable({
  receivables,
  payables,
  balances,
  currency,
}: {
  receivables: ReceivableRow[];
  payables: PayableRow[];
  balances: BalanceRow[];
  currency: string;
}) {
  const byId = new Map(balances.map((b) => [b.id, b]));
  const rows = [
    ...receivables.map((row) => ({ row, kind: "owed to you" as const })),
    ...payables.map((row) => ({ row, kind: "you owe" as const })),
  ].filter(({ row }) => row.status !== "cancelled");

  if (rows.length === 0) return <Empty>Nothing outstanding. Add an invoice or a bill and it will appear here.</Empty>;

  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="Outstanding balances"
      className="overflow-x-auto rounded-xl border border-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-800"
    >
      <table className="w-full text-xs">
        <caption className="sr-only">Outstanding balances: original amount, what has been applied, and what is left</caption>
        <thead className="bg-slate-50 text-left text-[11px] text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Counterparty</th>
            <th scope="col" className="px-3 py-2 font-medium">Due</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Original</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Notes</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Paid</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Remaining</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
          {rows.map(({ row, kind }) => {
            const balance = byId.get(row.id);
            const remaining = balance?.remainingCents ?? row.amountCents;
            const settled = balance?.settled ?? false;
            return (
              <tr key={row.id}>
                <td className="px-3 py-2">
                  <span className="font-medium text-slate-900 dark:text-slate-100">{row.counterpartyName}</span>
                  <span className="ml-2 text-[10px] text-slate-400 dark:text-slate-500">{kind}</span>
                  {settled ? (
                    <Badge
                      variant="outline"
                      className="ml-2 border-transparent bg-emerald-100 font-mono text-[10px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                    >
                      settled
                    </Badge>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{row.dueDate}</td>
                {/* The original never changes: settling it is recorded beside it, not over it. */}
                <td className="px-3 py-2 text-right tabular-nums">{formatMinor(row.amountCents, currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                  {balance?.adjustedCents ? formatMinor(balance.adjustedCents, currency) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                  {balance?.paidCents ? formatMinor(balance.paidCents, currency) : "—"}
                </td>
                <td
                  className={cn(
                    "px-3 py-2 text-right font-medium tabular-nums",
                    settled ? "text-emerald-600 dark:text-emerald-400" : "text-slate-900 dark:text-slate-100",
                  )}
                >
                  {formatMinor(remaining, currency)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Posted records, with reversal ----------------------------------------

function ReverseControl({
  kind,
  id,
  canReverse,
  onDone,
}: {
  kind: "payment" | "adjustment" | "allocation";
  id: string;
  canReverse: boolean;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canReverse) {
    return (
      <span className="text-[10px] text-slate-400 dark:text-slate-500">
        Only the owner can reverse a posted record
      </span>
    );
  }
  if (!open) {
    return (
      <Button size="sm" variant="ghost" className="h-7 px-1.5 text-[11px]" onClick={() => setOpen(true)}>
        <Undo2 className="size-3.5" aria-hidden />
        Reverse
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <input
        aria-label="Reason for reversing"
        placeholder="Why?"
        className={cn(INPUT, "h-7 w-36 text-[11px]")}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-1.5 text-[11px]"
        disabled={busy || !reason.trim()}
        onClick={() => {
          setBusy(true);
          setError(null);
          void companyAction("reverse", { kind, id, reason })
            .then(() => {
              setOpen(false);
              setReason("");
              onDone();
            })
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
        Confirm
      </Button>
      <Button size="sm" variant="ghost" className="h-7 px-1.5 text-[11px]" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error ? (
        <span role="alert" className="text-[10px] text-rose-700 dark:text-rose-300">
          {error}
        </span>
      ) : null}
    </span>
  );
}

const REVERSED = "border-transparent bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400";

export function PostedList({
  settlement,
  currency,
  canReverse,
  onChanged,
}: {
  settlement: Settlement;
  currency: string;
  canReverse: boolean;
  onChanged: () => void;
}) {
  const entries = [
    ...settlement.payments.map((p) => ({
      id: p.id,
      kind: "payment" as const,
      when: p.effectiveDate,
      title: p.direction === "receipt" ? "Money in" : "Money out",
      detail: [p.counterpartyName, p.method, p.reference].filter(Boolean).join(" · "),
      amountCents: p.direction === "receipt" ? p.amountCents : -p.amountCents,
      unallocatedCents: p.unallocatedCents,
      noCash: !p.affectsCash,
      reversedAt: p.reversedAt,
      reversalReason: p.reversalReason,
    })),
    ...settlement.adjustments.map((a) => ({
      id: a.id,
      kind: "adjustment" as const,
      when: a.effectiveDate,
      title: a.kind === "credit_note" ? "Credit note" : "Debit note",
      detail: a.reason,
      amountCents: a.amountCents,
      unallocatedCents: a.unallocatedCents,
      noCash: true,
      reversedAt: a.reversedAt,
      reversalReason: a.reversalReason,
    })),
  ].sort((a, b) => (a.when < b.when ? 1 : -1));

  if (entries.length === 0) {
    return <Empty>No payments or notes recorded yet. Once you record one it stays here, including anything later reversed.</Empty>;
  }

  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800/60 dark:border-slate-800">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "font-medium text-slate-900 dark:text-slate-100",
                entry.reversedAt ? "line-through decoration-slate-400" : "",
              )}
            >
              {entry.title}
            </span>
            <span className="ml-2 text-slate-500 dark:text-slate-400">{entry.when}</span>
            {entry.detail ? <span className="ml-2 text-slate-500 dark:text-slate-400">{entry.detail}</span> : null}
            {entry.reversedAt && entry.reversalReason ? (
              <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-400">
                reversed — {entry.reversalReason}
              </span>
            ) : null}
          </span>
          {entry.noCash && !entry.reversedAt ? (
            <Badge variant="outline" className="font-mono text-[10px]">
              no cash
            </Badge>
          ) : null}
          {!entry.reversedAt && entry.unallocatedCents > 0 ? (
            <Badge
              variant="outline"
              className="border-transparent bg-amber-100 font-mono text-[10px] text-amber-800 dark:bg-amber-950 dark:text-amber-300"
            >
              {formatMinor(entry.unallocatedCents, currency)} unmatched
            </Badge>
          ) : null}
          {entry.reversedAt ? (
            <Badge variant="outline" className={cn("font-mono text-[10px]", REVERSED)}>
              reversed
            </Badge>
          ) : null}
          <span
            className={cn(
              "font-medium tabular-nums",
              entry.reversedAt ? "text-slate-400 line-through dark:text-slate-500" : "",
            )}
          >
            {formatMinor(entry.amountCents, currency)}
          </span>
          {entry.reversedAt ? null : (
            <ReverseControl kind={entry.kind} id={entry.id} canReverse={canReverse} onDone={onChanged} />
          )}
        </li>
      ))}
    </ul>
  );
}

// --- The whole section -----------------------------------------------------

export function SettlementSection({
  settlement,
  receivables,
  payables,
  counterparties,
  currency,
  readOnly,
  canReverse,
  onChanged,
}: {
  settlement: Settlement;
  receivables: ReceivableRow[];
  payables: PayableRow[];
  counterparties: { id: string; name: string }[];
  currency: string;
  readOnly: boolean;
  canReverse: boolean;
  onChanged: () => void;
}) {
  const targets = useMemo(
    () => buildTargets(receivables, payables, settlement.balances),
    [receivables, payables, settlement.balances],
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
        Everything here is as you entered it. Vantora has no bank connection, so nothing below is reconciled
        against a bank statement.{" "}
        {settlement.openingCutoff
          ? `Money dated on or before ${settlement.openingCutoff} is already inside your opening balances and is not counted again.`
          : null}
      </p>

      <BalancesTable receivables={receivables} payables={payables} balances={settlement.balances} currency={currency} />

      <PostedList settlement={settlement} currency={currency} canReverse={canReverse && !readOnly} onChanged={onChanged} />

      {readOnly ? null : (
        <>
          <PaymentForm
            targets={targets}
            counterparties={counterparties}
            currency={currency}
            openingCutoff={settlement.openingCutoff}
            onSaved={onChanged}
          />
          <AdjustmentForm targets={targets} currency={currency} onSaved={onChanged} />
          <AllocateForm
            payments={settlement.payments}
            adjustments={settlement.adjustments}
            targets={targets}
            currency={currency}
            onSaved={onChanged}
          />
        </>
      )}
    </div>
  );
}
