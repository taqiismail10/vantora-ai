"use client";

/**
 * Company onboarding: resumable, server-driven.
 *
 * The step lives on the company row, not in this component, so closing the tab
 * and coming back resumes where the owner left off. Steps already passed stay
 * reachable; steps ahead do not, because each one needs the last.
 *
 * The forms are the same components the records workspace uses — there is one
 * definition of "add an invoice", not two that can drift apart.
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { SessionExpiredError } from "./client-api";
import {
  companyAction,
  CURRENCIES,
  fetchWorkspace,
  type CompanyWorkspace,
} from "./company-api";
import {
  AccountForm,
  AccountList,
  CounterpartyForm,
  CounterpartyList,
  Field,
  PayableForm,
  PayableList,
  ReceivableForm,
  ReceivableList,
} from "./company-forms";

type Step = "profile" | "accounts" | "records" | "policy";

const STEPS: { id: Step; label: string; blurb: string }[] = [
  { id: "profile", label: "Company", blurb: "Who you are and the currency you keep your books in." },
  { id: "accounts", label: "Cash", blurb: "What you hold, and the date that was true." },
  { id: "records", label: "Money in and out", blurb: "Who owes you, who you owe, and payroll." },
  { id: "policy", label: "Safety line", blurb: "The balance you never want to drop under." },
];

const INPUT =
  "h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950";

export function Onboarding() {
  const [workspace, setWorkspace] = useState<CompanyWorkspace | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((next: CompanyWorkspace) => {
    setWorkspace(next);
    // Resume where the owner left off, but never move them off the step they
    // are currently on.
    setStep((current) => {
      if (current) return current;
      const stored = next.active?.company.onboardingStep;
      return stored && stored !== "done" ? stored : "profile";
    });
    setError(null);
  }, []);

  const fail = useCallback((cause: unknown) => {
    if (cause instanceof SessionExpiredError) {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full reload on an identity change
      window.location.assign("/login?reason=expired");
      return;
    }
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const load = useCallback(async () => {
    await fetchWorkspace().then(apply).catch(fail);
  }, [apply, fail]);

  // State is only set inside the promise callback, never synchronously in the
  // effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    fetchWorkspace().then(apply).catch(fail);
  }, [apply, fail]);

  if (error) {
    return (
      <Shell>
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </p>
      </Shell>
    );
  }

  if (!workspace) {
    return (
      <Shell>
        <p role="status" className="text-xs text-slate-500 dark:text-slate-400">
          <Loader2 className="mr-2 inline size-3.5 animate-spin" aria-hidden />
          Loading your workspace…
        </p>
      </Shell>
    );
  }

  // No company at all: the only thing to do is create one.
  if (!workspace.active || workspace.companies.length === 0) {
    return (
      <Shell>
        <CreateCompany onCreated={load} />
      </Shell>
    );
  }

  const { company } = workspace.active;
  const active = step ?? "profile";
  const reached = STEPS.findIndex((s) => s.id === (company.onboardingStep === "done" ? "policy" : company.onboardingStep));
  const index = STEPS.findIndex((s) => s.id === active);

  const go = async (next: Step) => {
    setStep(next);
    await companyAction("set_step", { step: next }).catch(() => {});
    await load();
  };

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Set up {company.name}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            You can stop at any point and pick this up later. {company.currency} · required fields are marked
            <span className="mx-1 text-rose-600 dark:text-rose-400">*</span>
          </p>
        </div>
        <Badge variant="outline" className="font-mono text-[10px]">
          Step {index + 1} of {STEPS.length}
        </Badge>
      </div>

      <ol className="flex flex-wrap gap-1.5" aria-label="Onboarding steps">
        {STEPS.map((entry, position) => {
          const done = position < Math.max(reached, index);
          const unlocked = position <= Math.max(reached, index);
          return (
            <li key={entry.id}>
              <button
                type="button"
                disabled={!unlocked}
                aria-current={entry.id === active ? "step" : undefined}
                onClick={() => void go(entry.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-40",
                  entry.id === active
                    ? "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200"
                    : "border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-800",
                )}
              >
                {done ? <Check className="size-3" aria-hidden /> : null}
                {entry.label}
              </button>
            </li>
          );
        })}
      </ol>

      <p className="text-xs text-slate-500 dark:text-slate-400">{STEPS[index].blurb}</p>

      {active === "profile" ? <ProfileStep workspace={workspace} onSaved={load} /> : null}
      {active === "accounts" ? <AccountsStep workspace={workspace} onSaved={load} /> : null}
      {active === "records" ? <RecordsStep workspace={workspace} onSaved={load} /> : null}
      {active === "policy" ? <PolicyStep workspace={workspace} onSaved={load} /> : null}

      <StepNav index={index} onGo={go} workspace={workspace} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1 bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-8">{children}</div>
    </main>
  );
}

function StepNav({
  index,
  onGo,
  workspace,
}: {
  index: number;
  onGo: (step: Step) => Promise<void>;
  workspace: CompanyWorkspace;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = index === STEPS.length - 1;

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await companyAction("activate");
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload so the dashboard reads the new company state
      window.location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
      {error ? (
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="outline"
          disabled={index === 0}
          onClick={() => void onGo(STEPS[Math.max(0, index - 1)].id)}
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back
        </Button>
        {last ? (
          <Button onClick={() => void finish()} disabled={busy || !workspace.active}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Finish and see my forecast
          </Button>
        ) : (
          <Button onClick={() => void onGo(STEPS[index + 1].id)}>
            Next
            <ArrowRight className="size-4" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">{title}</h2>
      {children}
    </section>
  );
}

function CreateCompany({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [country, setCountry] = useState("");
  const [currency, setCurrency] = useState<string>("USD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await companyAction("create_company", { name, industry, country, currency });
      await onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">Create your company</h1>
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          This is your own workspace. It starts empty — no demonstration data is copied into it, and nobody else can
          see it.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Company name" required>
          {(id) => <input id={id} className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Industry">
          {(id) => <input id={id} className={INPUT} value={industry} onChange={(e) => setIndustry(e.target.value)} />}
        </Field>
        <Field label="Country" hint="Sets formatting and defaults only. It makes no compliance or tax claim.">
          {(id) => <input id={id} className={INPUT} value={country} onChange={(e) => setCountry(e.target.value)} />}
        </Field>
        <Field label="Base currency" required hint="This cannot be changed once you have entered any amount.">
          {(id) => (
            <select id={id} className={INPUT} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {error ? (
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 p-2.5 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || !name}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        Create company
      </Button>
    </form>
  );
}

function ProfileStep({ workspace, onSaved }: { workspace: CompanyWorkspace; onSaved: () => Promise<void> }) {
  const company = workspace.active!.company;
  const [name, setName] = useState(company.name);
  const [industry, setIndustry] = useState(company.industry);
  const [country, setCountry] = useState(company.country);
  const [businessType, setType] = useState(company.businessType);
  const [timezone, setTimezone] = useState(company.timezone);
  const [locations, setLocations] = useState(company.locations.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await companyAction("update_company", {
        name,
        industry,
        country,
        businessType,
        timezone,
        locations: locations.split(",").map((value) => value.trim()).filter(Boolean),
      });
      setSaved(true);
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Company details">
      <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 dark:border-slate-800 dark:bg-slate-950">
        <Field label="Company name" required>
          {(id) => <input id={id} className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Industry">
          {(id) => <input id={id} className={INPUT} value={industry} onChange={(e) => setIndustry(e.target.value)} />}
        </Field>
        <Field label="Country" hint="Formatting and defaults only — no compliance or tax claim is made.">
          {(id) => <input id={id} className={INPUT} value={country} onChange={(e) => setCountry(e.target.value)} />}
        </Field>
        <Field label="Business type" hint="For example manufacturer, wholesaler, retailer.">
          {(id) => <input id={id} className={INPUT} value={businessType} onChange={(e) => setType(e.target.value)} />}
        </Field>
        <Field label="Timezone">
          {(id) => <input id={id} className={INPUT} value={timezone} onChange={(e) => setTimezone(e.target.value)} />}
        </Field>
        <Field label="Operating locations" hint="Comma separated.">
          {(id) => <input id={id} className={INPUT} value={locations} onChange={(e) => setLocations(e.target.value)} />}
        </Field>
        <div className="sm:col-span-2">
          <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            Base currency is <strong className="font-medium">{company.currency}</strong>. It is fixed once any amount
            exists, because changing it would silently re-denominate every figure you have entered.
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-rose-700 sm:col-span-2 dark:text-rose-300">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="button" onClick={() => void save()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Save details
          </Button>
          {saved && !busy ? (
            <span role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
              Saved.
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function AccountsStep({ workspace, onSaved }: { workspace: CompanyWorkspace; onSaved: () => Promise<void> }) {
  const active = workspace.active!;
  return (
    <Card title="Cash on hand">
      <AccountList
        accounts={active.records.accounts}
        currency={active.company.currency}
        onChanged={() => void onSaved()}
      />
      <AccountForm onSaved={() => void onSaved()} />
    </Card>
  );
}

function RecordsStep({ workspace, onSaved }: { workspace: CompanyWorkspace; onSaved: () => Promise<void> }) {
  const active = workspace.active!;
  const refresh = () => void onSaved();
  const hasPayroll = active.records.payables.some((row) => row.isPayroll && row.status !== "cancelled");
  const declaredNone = active.policies.payroll_status?.value === "none";

  return (
    <div className="flex flex-col gap-6">
      <Card title="Buyers and suppliers">
        <CounterpartyList counterparties={active.records.counterparties} onChanged={refresh} />
        <CounterpartyForm onSaved={refresh} />
      </Card>

      <Card title="What you are owed">
        <ReceivableList receivables={active.records.receivables} currency={active.company.currency} onChanged={refresh} />
        <ReceivableForm counterparties={active.records.counterparties} onSaved={refresh} />
      </Card>

      <Card title="What you owe">
        <PayableList payables={active.records.payables} currency={active.company.currency} onChanged={refresh} />
        <PayableForm counterparties={active.records.counterparties} onSaved={refresh} />
      </Card>

      <Card title="Payroll">
        {hasPayroll ? (
          <p className="rounded-md border border-emerald-300 bg-emerald-50 p-2.5 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            A payroll obligation is recorded. It will never be deferred past its lock date.
          </p>
        ) : (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <p>
              No payroll is recorded. Payroll is the obligation most likely to make a forecast wrong, so leaving it out
              will make your projection look healthier than it is.
            </p>
            <p className="mt-2">
              Add it above as a bill with <strong className="font-medium">This is payroll</strong> ticked — or, if this
              company genuinely has none, say so and the forecast will stop warning you about it.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={declaredNone}
              onClick={() => void companyAction("set_payroll_status", { status: "none" }).then(refresh)}
            >
              {declaredNone ? "Recorded: this company has no payroll" : "This company has no payroll"}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function PolicyStep({ workspace, onSaved }: { workspace: CompanyWorkspace; onSaved: () => Promise<void> }) {
  const active = workspace.active!;
  const [buffer, setBuffer] = useState(
    active.policies.minimum_safe_buffer_cents ? String(Number(active.policies.minimum_safe_buffer_cents.value) / 100) : "",
  );
  const [creditScore, setCredit] = useState(active.policies.credit_score?.value ?? "");
  const [revenue, setRevenue] = useState(
    active.policies.monthly_revenue_cents ? String(Number(active.policies.monthly_revenue_cents.value) / 100) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      if (buffer !== "") await companyAction("set_policy", { key: "minimum_safe_buffer_cents", value: buffer });
      if (creditScore !== "") await companyAction("set_policy", { key: "credit_score", value: creditScore });
      if (revenue !== "") await companyAction("set_policy", { key: "monthly_revenue_cents", value: revenue });
      setSaved(true);
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Your safety line">
      <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 dark:border-slate-800 dark:bg-slate-950">
        <Field
          label="Minimum cash buffer"
          hint="The balance you never want to drop under. It is normal for this to be higher than the cash you hold today — that gap is exactly what the forecast is for."
        >
          {(id) => <input id={id} inputMode="decimal" className={INPUT} value={buffer} onChange={(e) => setBuffer(e.target.value)} />}
        </Field>
        <Field label="Credit score" hint="Leave blank and any facility that requires one is screened out rather than assumed to qualify.">
          {(id) => <input id={id} inputMode="numeric" className={INPUT} value={creditScore} onChange={(e) => setCredit(e.target.value)} />}
        </Field>
        <Field label="Monthly revenue" hint="Used only for working-capital ratios. Blank simply hides them.">
          {(id) => <input id={id} inputMode="decimal" className={INPUT} value={revenue} onChange={(e) => setRevenue(e.target.value)} />}
        </Field>
        {error ? (
          <p role="alert" className="text-xs text-rose-700 sm:col-span-2 dark:text-rose-300">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="button" onClick={() => void save()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Save
          </Button>
          {saved && !busy ? (
            <span role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
              Saved.
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
