"use client";

/**
 * Entry forms for a company's own financial records.
 *
 * Shared by onboarding and the records workspace so the two can never drift.
 * Every form posts one action to `/api/company` and shows the server's own
 * rejection text — the server validates, this file does not second-guess it.
 *
 * Optional fields say so, and say what leaving them blank means. That is the
 * honest half of the product: an unstated deferral term makes a bill fixed,
 * and the person entering it should know that before they skip the field.
 */

import { useId, useState, type ReactNode } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  companyAction,
  formatMinor,
  type AccountRow,
  type CounterpartyRow,
  type FacilityRow,
  type PayableRow,
  type ReceivableRow,
} from "./company-api";

export const INPUT =
  "h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950";

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: ReactNode;
  required?: boolean;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-slate-700 dark:text-slate-300">
        {label}
        {required ? (
          <span className="ml-1 text-rose-600 dark:text-rose-400" aria-hidden>
            *
          </span>
        ) : (
          <span className="ml-1 font-normal text-slate-400 dark:text-slate-500">(optional)</span>
        )}
      </label>
      {children(id)}
      {hint ? <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function Check({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 rounded border-slate-300 focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700"
      />
      <label htmlFor={id} className="text-xs text-slate-700 dark:text-slate-300">
        {label}
        {hint ? <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-slate-400">{hint}</span> : null}
      </label>
    </div>
  );
}

/** Shared submit plumbing: busy state, server error, reset on success. */
export function useSubmit(onSaved: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>, reset?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      reset?.();
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function FormShell({
  title,
  description,
  error,
  busy,
  submitLabel,
  onSubmit,
  children,
}: {
  title: string;
  description?: ReactNode;
  error: string | null;
  busy: boolean;
  submitLabel: string;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      noValidate
      className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950"
    >
      <h3 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">{title}</h3>
      {description ? (
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{description}</p>
      ) : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">{children}</div>
      {error ? (
        <p role="alert" className="mt-3 rounded-md border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy} className="mt-3">
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
        {submitLabel}
      </Button>
    </form>
  );
}

function DeleteButton({ label, onDelete }: { label: string; onDelete: () => void }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={onDelete}
      aria-label={label}
      title={label}
      className="h-7 px-1.5 text-slate-500 hover:text-rose-600 dark:hover:text-rose-400"
    >
      <Trash2 className="size-3.5" aria-hidden />
    </Button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-xs leading-relaxed text-slate-500 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-400">
      {children}
    </p>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

// --- Accounts -------------------------------------------------------------

export function AccountForm({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState("");
  const [openingBalance, setBalance] = useState("");
  const [asOfDate, setAsOf] = useState(today());
  const [isRestricted, setRestricted] = useState(false);
  const { busy, error, run } = useSubmit(onSaved);

  return (
    <FormShell
      title="Add an account"
      description="Vantora has no bank connection. Balances are as you enter them and are never reconciled against a bank statement."
      error={error}
      busy={busy}
      submitLabel="Add account"
      onSubmit={() =>
        run(() => companyAction("add_account", { name, openingBalance, asOfDate, isRestricted }), () => {
          setName("");
          setBalance("");
          setRestricted(false);
        })
      }
    >
      <Field label="Account name" required>
        {(id) => <input id={id} className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Balance" required>
        {(id) => (
          <input id={id} inputMode="decimal" className={INPUT} value={openingBalance} onChange={(e) => setBalance(e.target.value)} />
        )}
      </Field>
      <Field label="Balance was true on" required hint="The date this balance was correct. The forecast starts from here.">
        {(id) => (
          <input id={id} type="date" max={today()} className={INPUT} value={asOfDate} onChange={(e) => setAsOf(e.target.value)} />
        )}
      </Field>
      <div className="flex items-end pb-1">
        <Check
          label="Restricted cash"
          hint="Excluded from available cash — money you hold but cannot spend, such as escrow or a security deposit."
          checked={isRestricted}
          onChange={setRestricted}
        />
      </div>
    </FormShell>
  );
}

export function AccountList({
  accounts,
  currency,
  onChanged,
  readOnly,
}: {
  accounts: AccountRow[];
  currency: string;
  onChanged: () => void;
  readOnly?: boolean;
}) {
  if (accounts.length === 0) {
    return <Empty>No accounts yet. Add at least one so the forecast has a starting cash position.</Empty>;
  }
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800/60 dark:border-slate-800">
      {accounts.map((account) => (
        <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">
            <span className="font-medium text-slate-900 dark:text-slate-100">{account.name}</span>
            {account.isRestricted ? (
              <Badge variant="outline" className="ml-2 border-transparent bg-amber-100 font-mono text-[10px] text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                restricted
              </Badge>
            ) : null}
            <span className="ml-2 text-slate-500 dark:text-slate-400">as of {account.asOfDate}</span>
          </span>
          <span className="font-medium tabular-nums">{formatMinor(account.openingCents, currency)}</span>
          {readOnly ? null : (
            <DeleteButton
              label={`Remove account ${account.name}`}
              onDelete={() => void companyAction("delete_account", { id: account.id }).then(onChanged)}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

// --- Counterparties -------------------------------------------------------

const ARCHETYPES = [
  { value: "", label: "Not stated" },
  { value: "FLEXIBLE_PARTNER", label: "Flexible partner" },
  { value: "COMMERCIAL_NEGOTIATOR", label: "Commercial negotiator" },
  { value: "MONOPOLY_STRICT", label: "Sole source, strict terms" },
  { value: "STATUTORY", label: "Statutory (tax, wages)" },
  { value: "OVERHEAD", label: "Overhead (rent, utilities)" },
];

export function CounterpartyForm({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState("");
  const [isBuyer, setBuyer] = useState(true);
  const [isSupplier, setSupplier] = useState(false);
  const [country, setCountry] = useState("");
  const [archetype, setArchetype] = useState("");
  const [isCritical, setCritical] = useState(false);
  const { busy, error, run } = useSubmit(onSaved);

  return (
    <FormShell
      title="Add a buyer or supplier"
      description="One record can be both. A counterparty must be at least one of the two."
      error={error}
      busy={busy}
      submitLabel="Add counterparty"
      onSubmit={() =>
        run(
          () =>
            companyAction("add_counterparty", {
              name,
              isBuyer,
              isSupplier,
              country,
              ...(archetype ? { archetype } : {}),
              ...(isSupplier ? { isCritical } : {}),
            }),
          () => {
            setName("");
            setCountry("");
            setArchetype("");
            setCritical(false);
          },
        )
      }
    >
      <Field label="Name" required>
        {(id) => <input id={id} className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Country">
        {(id) => <input id={id} className={INPUT} value={country} onChange={(e) => setCountry(e.target.value)} />}
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
          Relationship <span className="ml-1 text-rose-600 dark:text-rose-400">*</span>
        </span>
        <Check label="Buys from us (receivables)" checked={isBuyer} onChange={setBuyer} />
        <Check label="We buy from them (bills)" checked={isSupplier} onChange={setSupplier} />
      </div>
      {isSupplier ? (
        <div className="flex flex-col gap-2">
          <Field label="Supplier type" hint="Used when the optimizer decides who could be asked to wait.">
            {(id) => (
              <select id={id} className={INPUT} value={archetype} onChange={(e) => setArchetype(e.target.value)}>
                {ARCHETYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Check
            label="Critical supplier"
            hint="Does not block a deferral by itself — it adds a cost penalty the optimizer weighs against the alternative. A bill is only ever excluded from deferral by its own terms (below, or when entering a bill), never by criticality alone."
            checked={isCritical}
            onChange={setCritical}
          />
        </div>
      ) : null}
    </FormShell>
  );
}

/**
 * Edits an existing supplier's constraints in place.
 *
 * This changes the *default* a future bill inherits — never a bill already
 * posted. That is `updateCounterparty`'s own guarantee server-side, not just
 * UI copy: a posted bill's terms are a snapshot taken at entry, so this can
 * never silently rewrite one.
 */
function CounterpartyTermsEditor({ party, onSaved }: { party: CounterpartyRow; onSaved: () => void }) {
  const [isCritical, setCritical] = useState(party.profile.is_critical === true);
  const [lineStopRisk, setLineStopRisk] = useState(
    typeof party.profile.line_stop_risk === "string" ? party.profile.line_stop_risk : "",
  );
  const [isFlexible, setFlexible] = useState(party.profile.is_flexible === true);
  const [maxDeferralDays, setMaxDeferral] = useState(
    typeof party.profile.max_deferral_days === "number" ? String(party.profile.max_deferral_days) : "",
  );
  const { busy, error, run } = useSubmit(onSaved);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(() =>
          companyAction("update_counterparty", {
            id: party.id,
            isCritical,
            lineStopRisk,
            isFlexible,
            ...(isFlexible && maxDeferralDays ? { maxDeferralDays } : isFlexible ? {} : { maxDeferralDays: 0 }),
          }),
        );
      }}
      className="col-span-full flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900"
    >
      <Check
        label="Critical supplier"
        hint="Adds a cost penalty the optimizer weighs against delaying them — it does not by itself exclude them from a deferral proposal."
        checked={isCritical}
        onChange={setCritical}
      />
      <Field
        label="Production-interruption risk"
        hint="What not paying them on time would actually cause. Shown as context, not read by the solver."
      >
        {(id) => (
          <input
            id={id}
            className={INPUT}
            value={lineStopRisk}
            onChange={(e) => setLineStopRisk(e.target.value)}
            placeholder="e.g. halts the dye line within 48 hours"
          />
        )}
      </Field>
      <Check
        label="Would accept a later payment, by default"
        hint="The default a new bill from this supplier inherits. Leaving this off makes a new bill fixed unless you say otherwise when entering it. Never changes a bill you already entered."
        checked={isFlexible}
        onChange={setFlexible}
      />
      {isFlexible ? (
        <Field label="Agreed deferral limit, in days" hint="Blank means no limit is assumed — treated as 0.">
          {(id) => (
            <input
              id={id}
              inputMode="numeric"
              className={INPUT}
              value={maxDeferralDays}
              onChange={(e) => setMaxDeferral(e.target.value)}
            />
          )}
        </Field>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 p-2 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={busy} className="w-fit">
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        Save supplier terms
      </Button>
    </form>
  );
}

export function CounterpartyList({
  counterparties,
  onChanged,
  readOnly,
}: {
  counterparties: CounterpartyRow[];
  onChanged: () => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (counterparties.length === 0) {
    return <Empty>No buyers or suppliers yet. Add them first — invoices and bills attach to one.</Empty>;
  }
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800/60 dark:border-slate-800">
      {counterparties.map((party) => (
        <li key={party.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 font-medium text-slate-900 dark:text-slate-100">{party.name}</span>
          {party.isBuyer ? (
            <Badge variant="outline" className="font-mono text-[10px]">
              buyer
            </Badge>
          ) : null}
          {party.isSupplier ? (
            <Badge variant="outline" className="font-mono text-[10px]">
              supplier
            </Badge>
          ) : null}
          {party.profile.is_critical === true ? (
            <Badge variant="outline" className="border-transparent bg-rose-100 font-mono text-[10px] text-rose-800 dark:bg-rose-950 dark:text-rose-300">
              critical
            </Badge>
          ) : null}
          {readOnly || !party.isSupplier ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditing((current) => (current === party.id ? null : party.id))}
            >
              {editing === party.id ? "Close" : "Edit terms"}
            </Button>
          )}
          {readOnly ? null : (
            <DeleteButton
              label={`Remove ${party.name}`}
              onDelete={() => void companyAction("delete_counterparty", { id: party.id }).then(onChanged).catch(() => onChanged())}
            />
          )}
          {editing === party.id ? (
            <CounterpartyTermsEditor
              party={party}
              onSaved={() => {
                setEditing(null);
                onChanged();
              }}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// --- Receivables ----------------------------------------------------------

export function ReceivableForm({
  counterparties,
  onSaved,
}: {
  counterparties: CounterpartyRow[];
  onSaved: () => void;
}) {
  const buyers = counterparties.filter((party) => party.isBuyer);
  const [counterpartyId, setParty] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDue] = useState("");
  const [externalId, setRef] = useState("");
  const [expectedDelayDays, setDelay] = useState("");
  const { busy, error, run } = useSubmit(onSaved);

  if (buyers.length === 0) return <Empty>Add a buyer before entering what you are owed.</Empty>;

  return (
    <FormShell
      title="Add an invoice you are owed"
      error={error}
      busy={busy}
      submitLabel="Add invoice"
      onSubmit={() =>
        run(
          () =>
            companyAction("add_receivable", {
              counterpartyId,
              amount,
              dueDate,
              ...(externalId ? { externalId } : {}),
              ...(expectedDelayDays ? { expectedDelayDays } : {}),
            }),
          () => {
            setAmount("");
            setDue("");
            setRef("");
            setDelay("");
          },
        )
      }
    >
      <Field label="Buyer" required>
        {(id) => (
          <select id={id} className={INPUT} value={counterpartyId} onChange={(e) => setParty(e.target.value)}>
            <option value="">Select a buyer…</option>
            {buyers.map((buyer) => (
              <option key={buyer.id} value={buyer.id}>
                {buyer.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Amount" required>
        {(id) => <input id={id} inputMode="decimal" className={INPUT} value={amount} onChange={(e) => setAmount(e.target.value)} />}
      </Field>
      <Field label="Due date" required>
        {(id) => <input id={id} type="date" className={INPUT} value={dueDate} onChange={(e) => setDue(e.target.value)} />}
      </Field>
      <Field label="Your invoice reference" hint="Used to stop the same invoice being entered twice.">
        {(id) => <input id={id} className={INPUT} value={externalId} onChange={(e) => setRef(e.target.value)} />}
      </Field>
      <Field
        label="Expected days late"
        hint="Your own expectation of this buyer, not a measurement from their payment history. Blank assumes they pay near the due date."
      >
        {(id) => (
          <input id={id} inputMode="numeric" className={INPUT} value={expectedDelayDays} onChange={(e) => setDelay(e.target.value)} />
        )}
      </Field>
    </FormShell>
  );
}

const STATUS_STYLE: Record<string, string> = {
  open: "",
  disputed: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  cancelled: "border-transparent bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

export function ReceivableList({
  receivables,
  currency,
  onChanged,
  readOnly,
}: {
  receivables: ReceivableRow[];
  currency: string;
  onChanged: () => void;
  readOnly?: boolean;
}) {
  if (receivables.length === 0) return <Empty>Nothing recorded as owed to you yet.</Empty>;
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800/60 dark:border-slate-800">
      {receivables.map((row) => (
        <li key={row.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">
            <span className="font-medium text-slate-900 dark:text-slate-100">{row.counterpartyName}</span>
            <span className="ml-2 text-slate-500 dark:text-slate-400">due {row.dueDate}</span>
            {row.externalId ? <span className="ml-2 font-mono text-[10px] text-slate-400">{row.externalId}</span> : null}
          </span>
          {row.status !== "open" ? (
            <Badge variant="outline" className={cn("font-mono text-[10px]", STATUS_STYLE[row.status])}>
              {row.status}
            </Badge>
          ) : null}
          {row.source === "csv_import" ? (
            <Badge variant="outline" className="font-mono text-[10px] text-slate-500" title="Entered by CSV import, not reconciled against a bank">
              imported
            </Badge>
          ) : null}
          <span className="font-medium tabular-nums">{formatMinor(row.amountCents, currency)}</span>
          {readOnly ? null : (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-1.5 text-[11px]"
                onClick={() =>
                  void companyAction("set_receivable_status", {
                    id: row.id,
                    status: row.status === "disputed" ? "open" : "disputed",
                  }).then(onChanged)
                }
              >
                {row.status === "disputed" ? "Undispute" : "Dispute"}
              </Button>
              <DeleteButton
                label={`Remove invoice from ${row.counterpartyName}`}
                onDelete={() => void companyAction("delete_receivable", { id: row.id }).then(onChanged)}
              />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

// --- Payables -------------------------------------------------------------

export function PayableForm({
  counterparties,
  onSaved,
}: {
  counterparties: CounterpartyRow[];
  onSaved: () => void;
}) {
  const suppliers = counterparties.filter((party) => party.isSupplier);
  const [counterpartyId, setParty] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDue] = useState("");
  const [isPayroll, setPayroll] = useState(false);
  const [payrollLockDate, setLock] = useState("");
  const [isFlexible, setFlexible] = useState(false);
  const [maxDeferralDays, setMaxDeferral] = useState("");
  const { busy, error, run } = useSubmit(onSaved);

  if (suppliers.length === 0) return <Empty>Add a supplier before entering a bill. Payroll counts as a supplier.</Empty>;

  return (
    <FormShell
      title="Add a bill you owe"
      description="Leave the deferral fields blank and this bill is treated as fixed — the optimizer will not propose moving it."
      error={error}
      busy={busy}
      submitLabel="Add bill"
      onSubmit={() =>
        run(
          () =>
            companyAction("add_payable", {
              counterpartyId,
              amount,
              dueDate,
              isPayroll,
              ...(isPayroll && payrollLockDate ? { payrollLockDate } : {}),
              ...(isFlexible ? { isFlexible: true, ...(maxDeferralDays ? { maxDeferralDays } : {}) } : {}),
            }),
          () => {
            setAmount("");
            setDue("");
            setLock("");
            setMaxDeferral("");
          },
        )
      }
    >
      <Field label="Supplier" required>
        {(id) => (
          <select id={id} className={INPUT} value={counterpartyId} onChange={(e) => setParty(e.target.value)}>
            <option value="">Select a supplier…</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Amount" required>
        {(id) => <input id={id} inputMode="decimal" className={INPUT} value={amount} onChange={(e) => setAmount(e.target.value)} />}
      </Field>
      <Field label="Due date" required>
        {(id) => <input id={id} type="date" className={INPUT} value={dueDate} onChange={(e) => setDue(e.target.value)} />}
      </Field>
      <div className="flex flex-col gap-2 pt-1">
        <Check
          label="This is payroll"
          hint="Wages are never deferred past their lock day, whatever else the plan does."
          checked={isPayroll}
          onChange={setPayroll}
        />
        {isPayroll ? (
          <Field label="Bank file lock date" hint="The day the payment file must be submitted — usually before the pay date.">
            {(id) => <input id={id} type="date" className={INPUT} value={payrollLockDate} onChange={(e) => setLock(e.target.value)} />}
          </Field>
        ) : null}
      </div>
      {isPayroll ? null : (
        <div className="flex flex-col gap-2 pt-1">
          <Check
            label="This supplier would accept a later payment"
            hint="Only tick this if you believe it is true. It lets the optimizer propose delaying them."
            checked={isFlexible}
            onChange={setFlexible}
          />
          {isFlexible ? (
            <Field label="Most days they would accept" hint="Blank means no delay is assumed.">
              {(id) => (
                <input id={id} inputMode="numeric" className={INPUT} value={maxDeferralDays} onChange={(e) => setMaxDeferral(e.target.value)} />
              )}
            </Field>
          ) : null}
        </div>
      )}
    </FormShell>
  );
}

/**
 * Overrides one already-posted bill's own deferral/criticality terms.
 *
 * Unlike a supplier-default edit, this changes `payable.terms` directly — the
 * exact field the next forecast and solve read — so it takes effect on the
 * next calculation for this bill specifically, without touching any other
 * bill from the same supplier or any other company.
 */
function PayableTermsEditor({ row, onSaved }: { row: PayableRow; onSaved: () => void }) {
  const [isFlexible, setFlexible] = useState(row.terms.is_flexible === true);
  const [maxDeferralDays, setMaxDeferral] = useState(
    typeof row.terms.max_deferral_days === "number" ? String(row.terms.max_deferral_days) : "",
  );
  const [isCritical, setCritical] = useState(row.terms.is_critical === true);
  const { busy, error, run } = useSubmit(onSaved);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(() =>
          companyAction("update_payable", {
            id: row.id,
            isCritical,
            isFlexible,
            ...(isFlexible && maxDeferralDays ? { maxDeferralDays } : isFlexible ? {} : { maxDeferralDays: 0 }),
          }),
        );
      }}
      className="col-span-full flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900"
    >
      <Check
        label="This specific bill would accept a later payment"
        hint="Overrides the supplier's default for this bill only. Off makes it fixed, whatever the supplier's default says."
        checked={isFlexible}
        onChange={setFlexible}
      />
      {isFlexible ? (
        <Field label="Agreed deferral limit, in days" hint="Blank means no limit is assumed — treated as 0.">
          {(id) => (
            <input
              id={id}
              inputMode="numeric"
              className={INPUT}
              value={maxDeferralDays}
              onChange={(e) => setMaxDeferral(e.target.value)}
            />
          )}
        </Field>
      ) : null}
      <Check
        label="Critical for this bill"
        hint="Adds a cost penalty if this bill is delayed. Does not by itself exclude it from a deferral proposal."
        checked={isCritical}
        onChange={setCritical}
      />
      {error ? (
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 p-2 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={busy} className="w-fit">
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        Save this bill&rsquo;s terms
      </Button>
    </form>
  );
}

export function PayableList({
  payables,
  currency,
  onChanged,
  readOnly,
}: {
  payables: PayableRow[];
  currency: string;
  onChanged: () => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (payables.length === 0) return <Empty>No bills recorded yet. Payroll is the one most likely to change a forecast.</Empty>;
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800/60 dark:border-slate-800">
      {payables.map((row) => (
        <li key={row.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">
            <span className="font-medium text-slate-900 dark:text-slate-100">{row.counterpartyName}</span>
            <span className="ml-2 text-slate-500 dark:text-slate-400">due {row.dueDate}</span>
            {row.payrollLockDate ? (
              <span className="ml-2 text-slate-500 dark:text-slate-400">· locks {row.payrollLockDate}</span>
            ) : null}
          </span>
          {row.isPayroll ? (
            <Badge variant="outline" className="border-transparent bg-sky-100 font-mono text-[10px] text-sky-800 dark:bg-sky-950 dark:text-sky-300">
              payroll
            </Badge>
          ) : null}
          {row.terms.is_flexible === true ? (
            <Badge variant="outline" className="font-mono text-[10px]">
              can wait
            </Badge>
          ) : (
            <Badge variant="outline" className="font-mono text-[10px] text-slate-500">
              fixed
            </Badge>
          )}
          {row.terms.is_critical === true ? (
            <Badge variant="outline" className="border-transparent bg-rose-100 font-mono text-[10px] text-rose-800 dark:bg-rose-950 dark:text-rose-300">
              critical
            </Badge>
          ) : null}
          {row.source === "csv_import" ? (
            <Badge variant="outline" className="font-mono text-[10px] text-slate-500" title="Entered by CSV import, not reconciled against a bank">
              imported
            </Badge>
          ) : null}
          <span className="font-medium tabular-nums">{formatMinor(row.amountCents, currency)}</span>
          {readOnly || row.isPayroll ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditing((current) => (current === row.id ? null : row.id))}
            >
              {editing === row.id ? "Close" : "Edit terms"}
            </Button>
          )}
          {readOnly ? null : (
            <DeleteButton
              label={`Remove bill from ${row.counterpartyName}`}
              onDelete={() => void companyAction("delete_payable", { id: row.id }).then(onChanged)}
            />
          )}
          {editing === row.id ? (
            <PayableTermsEditor
              row={row}
              onSaved={() => {
                setEditing(null);
                onChanged();
              }}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// --- Financing facilities -------------------------------------------------

const PRODUCTS = [
  { value: "bridge_loan", label: "Bridge loan" },
  { value: "line_of_credit", label: "Line of credit" },
  { value: "invoice_factoring", label: "Invoice factoring" },
  { value: "merchant_advance", label: "Merchant advance" },
];

export function FacilityForm({ onSaved }: { onSaved: () => void }) {
  const [provider, setProvider] = useState("");
  const [productType, setProduct] = useState("bridge_loan");
  const [maxAmount, setMax] = useState("");
  const [aprPercent, setApr] = useState("");
  const [fundingDays, setDays] = useState("");
  const [isExistingFacility, setExisting] = useState(false);
  const { busy, error, run } = useSubmit(onSaved);

  return (
    <FormShell
      title="Add a financing facility"
      description="Only facilities you actually have. Nothing here is an offer from Vantora, and no borrowing option is invented if you add none."
      error={error}
      busy={busy}
      submitLabel="Add facility"
      onSubmit={() =>
        run(
          () =>
            companyAction("add_facility", {
              provider,
              productType,
              maxAmount,
              apr: aprPercent === "" ? "" : Number(aprPercent) / 100,
              ...(fundingDays ? { fundingDays } : {}),
              isExistingFacility,
            }),
          () => {
            setProvider("");
            setMax("");
            setApr("");
            setDays("");
          },
        )
      }
    >
      <Field label="Lender" required>
        {(id) => <input id={id} className={INPUT} value={provider} onChange={(e) => setProvider(e.target.value)} />}
      </Field>
      <Field label="Product" required>
        {(id) => (
          <select id={id} className={INPUT} value={productType} onChange={(e) => setProduct(e.target.value)}>
            {PRODUCTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Limit" required>
        {(id) => <input id={id} inputMode="decimal" className={INPUT} value={maxAmount} onChange={(e) => setMax(e.target.value)} />}
      </Field>
      <Field label="APR %" required hint="As a percentage, for example 18 for 18%.">
        {(id) => <input id={id} inputMode="decimal" className={INPUT} value={aprPercent} onChange={(e) => setApr(e.target.value)} />}
      </Field>
      <Field label="Days until funds arrive" hint="Blank is treated as slow (30 days), never as instant.">
        {(id) => <input id={id} inputMode="numeric" className={INPUT} value={fundingDays} onChange={(e) => setDays(e.target.value)} />}
      </Field>
      <div className="flex items-end pb-1">
        <Check
          label="Already approved and in place"
          hint="No fresh application needed to draw on it."
          checked={isExistingFacility}
          onChange={setExisting}
        />
      </div>
    </FormShell>
  );
}

/**
 * Edits an existing facility's own limit, rate, fees and eligibility terms.
 *
 * "Limit" here is always the total contractual ceiling the lender agreed to
 * — never what remains available to draw today, which is computed fresh for
 * every plan (reduced by AR-coverage caps and anything already drawn) and
 * is never a number you can type in. Changing it here never rewrites a draw
 * already recorded: those keep the rate and terms that applied when they
 * were approved.
 */
function FacilityTermsEditor({ facility, onSaved }: { facility: FacilityRow; onSaved: () => void }) {
  const [provider, setProvider] = useState(facility.provider);
  const [maxAmount, setMax] = useState(String(facility.maxAmountCents / 100));
  const [aprPercent, setApr] = useState(String(facility.apr * 100));
  const [fundingDays, setDays] = useState(
    typeof facility.terms.funding_days === "number" ? String(facility.terms.funding_days) : "",
  );
  const [originationFeePercent, setFee] = useState(
    typeof facility.terms.origination_fee_pct === "number" ? String(facility.terms.origination_fee_pct * 100) : "",
  );
  const [requiresArCollateral, setRequiresAr] = useState(facility.terms.requires_ar_collateral === true);
  const [arCoverageRatio, setCoverage] = useState(
    typeof facility.terms.ar_coverage_ratio === "number" ? String(facility.terms.ar_coverage_ratio) : "",
  );
  const [minCreditScore, setMinScore] = useState(
    typeof facility.terms.min_credit_score === "number" ? String(facility.terms.min_credit_score) : "",
  );
  const [isExistingFacility, setExisting] = useState(facility.terms.is_existing_facility === true);
  const { busy, error, run } = useSubmit(onSaved);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(() =>
          companyAction("update_facility", {
            id: facility.id,
            provider,
            maxAmount,
            apr: aprPercent === "" ? "" : Number(aprPercent) / 100,
            ...(fundingDays ? { fundingDays } : {}),
            ...(originationFeePercent ? { originationFeePct: Number(originationFeePercent) / 100 } : {}),
            requiresArCollateral,
            ...(requiresArCollateral && arCoverageRatio ? { arCoverageRatio } : {}),
            ...(minCreditScore ? { minCreditScore } : {}),
            isExistingFacility,
          }),
        );
      }}
      className="col-span-full flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900"
    >
      <Field label="Lender" required>
        {(id) => <input id={id} className={INPUT} value={provider} onChange={(e) => setProvider(e.target.value)} />}
      </Field>
      <Field label="Total credit limit" required hint="The lender's ceiling, not what is left to draw today — that is worked out fresh each time, from this limit minus anything already drawn.">
        {(id) => <input id={id} inputMode="decimal" className={INPUT} value={maxAmount} onChange={(e) => setMax(e.target.value)} />}
      </Field>
      <Field label="APR %" required hint="As a percentage, for example 18 for 18%.">
        {(id) => <input id={id} inputMode="decimal" className={INPUT} value={aprPercent} onChange={(e) => setApr(e.target.value)} />}
      </Field>
      <Field label="Days until funds arrive" hint="Blank is treated as slow (30 days), never as instant. A longer delay can make a facility unable to reach an obligation in time.">
        {(id) => <input id={id} inputMode="numeric" className={INPUT} value={fundingDays} onChange={(e) => setDays(e.target.value)} />}
      </Field>
      <Field label="Origination fee %" hint="As a percentage of the amount drawn.">
        {(id) => (
          <input id={id} inputMode="decimal" className={INPUT} value={originationFeePercent} onChange={(e) => setFee(e.target.value)} />
        )}
      </Field>
      <Field label="Minimum credit score required" hint="Blank means the lender stated none; a facility is screened out, not assumed eligible, when the company's own score is below what you enter here.">
        {(id) => (
          <input id={id} inputMode="numeric" className={INPUT} value={minCreditScore} onChange={(e) => setMinScore(e.target.value)} />
        )}
      </Field>
      <div className="col-span-full flex flex-col gap-2">
        <Check
          label="Secured against receivables"
          hint="What is actually available is capped by pledgeable AR, not by the limit above."
          checked={requiresArCollateral}
          onChange={setRequiresAr}
        />
        {requiresArCollateral ? (
          <Field label="AR coverage ratio" hint="How many dollars of receivables the lender wants pledged per dollar drawn, for example 1.2.">
            {(id) => (
              <input id={id} inputMode="decimal" className={INPUT} value={arCoverageRatio} onChange={(e) => setCoverage(e.target.value)} />
            )}
          </Field>
        ) : null}
      </div>
      <Check
        label="Already approved and in place"
        hint="No fresh application needed to draw on it."
        checked={isExistingFacility}
        onChange={setExisting}
      />
      {error ? (
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 p-2 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={busy} className="w-fit">
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        Save facility terms
      </Button>
    </form>
  );
}

export function FacilityList({
  facilities,
  currency,
  onChanged,
  readOnly,
}: {
  facilities: FacilityRow[];
  currency: string;
  onChanged: () => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (facilities.length === 0) {
    return (
      <Empty>
        No facilities recorded. Recovery plans will compare only internal options — collecting earlier and paying later.
        No borrowing option is invented.
      </Empty>
    );
  }
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800/60 dark:border-slate-800">
      {facilities.map((row) => (
        <li key={row.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">
            <span className="font-medium text-slate-900 dark:text-slate-100">{row.provider}</span>
            <span className="ml-2 text-slate-500 dark:text-slate-400">
              {PRODUCTS.find((p) => p.value === row.productType)?.label ?? row.productType}
            </span>
          </span>
          <span className="tabular-nums text-slate-500 dark:text-slate-400">{(row.apr * 100).toFixed(1)}% APR</span>
          <span className="font-medium tabular-nums">{formatMinor(row.maxAmountCents, currency)} limit</span>
          {readOnly ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditing((current) => (current === row.id ? null : row.id))}
            >
              {editing === row.id ? "Close" : "Edit terms"}
            </Button>
          )}
          {readOnly ? null : (
            <DeleteButton
              label={`Remove facility from ${row.provider}`}
              onDelete={() => void companyAction("delete_facility", { id: row.id }).then(onChanged)}
            />
          )}
          {editing === row.id ? (
            <FacilityTermsEditor
              facility={row}
              onSaved={() => {
                setEditing(null);
                onChanged();
              }}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
