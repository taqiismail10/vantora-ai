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
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, LoaderCircle } from "lucide-react";

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
  "h-9 w-full rounded-md border border-white/10 bg-white/5 px-3 text-sm text-white outline-none placeholder:text-white/20 focus-visible:border-[#cdf632]/50 focus-visible:ring-2 focus-visible:ring-[#cdf632]/20";

export function Onboarding() {
  const [workspace, setWorkspace] = useState<CompanyWorkspace | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Distinct from resuming the active company: `?new=1` is the explicit
  // "Create another company" path, reached only from the company switcher.
  const creatingAnother = useSearchParams().get("new") === "1";

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
        <p role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
          {error}
        </p>
      </Shell>
    );
  }

  if (!workspace) {
    return (
      <Shell>
        <p role="status" className="text-xs text-white/40">
          <LoaderCircle className="mr-2 inline size-3.5 animate-spin" aria-hidden />
          Loading your workspace…
        </p>
      </Shell>
    );
  }

  // No company at all, or the owner explicitly asked to add another one:
  // either way, the only thing to do is create one. Distinct from resuming
  // the active company's own onboarding, which the branch below handles.
  if (!workspace.active || workspace.companies.length === 0 || creatingAnother) {
    return (
      <Shell>
        <CreateCompany
          onCreated={async (newCompanyId) => {
            if (creatingAnother) {
              // Select the one just created, the same mechanism the company
              // switcher uses, so the next load resumes *its* onboarding —
              // never the company the owner was already working in.
              document.cookie = `vantora_company=${encodeURIComponent(newCompanyId)}; path=/; SameSite=Lax; max-age=${60 * 60 * 24 * 365}`;
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload so the new company's data starts clean
              window.location.assign("/onboarding");
              return;
            }
            await load();
          }}
        />
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
          <h1 className="text-lg font-semibold tracking-tight text-white">
            Set up {company.name}
          </h1>
          <p className="text-xs text-white/40">
            You can stop at any point and pick this up later. {company.currency} · required fields are marked
            <span className="mx-1 text-rose-400">*</span>
          </p>
        </div>
        {/* "Step N of 4" from the Figma company-setup frames: plain green
            text rather than the boxed chip. Style only — it keeps its current
            place in the header row. */}
        <span className="text-xs font-medium text-[#cdf632]">
          Step {index + 1} of {STEPS.length}
        </span>
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
                    ? "border-[#cdf632]/40 bg-[#cdf632]/10 text-[#cdf632]"
                    : "border-white/10 text-white/40 hover:bg-white/5",
                )}
              >
                {done ? <Check className="size-3" aria-hidden /> : null}
                {entry.label}
              </button>
            </li>
          );
        })}
      </ol>

      <p className="text-xs text-white/40">{STEPS[index].blurb}</p>

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
    <main className="dark flex-1 bg-[#0a0a0a]">
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
    <div className="flex flex-col gap-2 border-t border-white/10 pt-4">
      {error ? (
        <p role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-300">
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
            {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
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
      <h2 className="text-sm font-semibold tracking-tight text-white">{title}</h2>
      {children}
    </section>
  );
}

function CreateCompany({ onCreated }: { onCreated: (newCompanyId: string) => Promise<void> }) {
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
      const result = await companyAction<{ company: { id: string } }>("create_company", { name, industry, country, currency });
      await onCreated(result.company.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-white">Create your company</h1>
        <p className="mt-1 text-xs leading-relaxed text-white/40">
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
        <p role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || !name}>
        {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
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
      <div className="grid gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-4 sm:grid-cols-2">
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
          <p className="text-[11px] leading-relaxed text-white/35">
            Base currency is <strong className="font-medium text-white/60">{company.currency}</strong>. It is fixed once any amount
            exists, because changing it would silently re-denominate every figure you have entered.
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-rose-400 sm:col-span-2">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="button" onClick={() => void save()} disabled={busy}>
            {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
            Save details
          </Button>
          {saved && !busy ? (
            <span role="status" className="text-xs text-[#cdf632]">
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
          <p className="rounded-md border border-[#cdf632]/30 bg-[#cdf632]/10 p-2.5 text-xs text-[#cdf632]">
            A payroll obligation is recorded. It will never be deferred past its lock date.
          </p>
        ) : (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-300">
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
      <div className="grid gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-4 sm:grid-cols-2">
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
          <p role="alert" className="text-xs text-rose-400 sm:col-span-2">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="button" onClick={() => void save()} disabled={busy}>
            {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
            Save
          </Button>
          {saved && !busy ? (
            <span role="status" className="text-xs text-[#cdf632]">
              Saved.
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
