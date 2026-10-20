"use client";

/**
 * The records workspace: everything a company has entered, after onboarding.
 *
 * Same forms as onboarding, so there is one definition of each entry screen.
 * A VIEWER sees the records and no controls that change them; the server
 * refuses the writes regardless, this only stops offering what it would refuse.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, LoaderCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

import { SessionExpiredError } from "./client-api";
import { fetchWorkspace, type CompanyWorkspace } from "./company-api";
import {
  AccountForm,
  AccountList,
  CounterpartyForm,
  CounterpartyList,
  FacilityForm,
  FacilityList,
  PayableForm,
  PayableList,
  ReceivableForm,
  ReceivableList,
} from "./company-forms";
import { CoveragePanel } from "./coverage-panel";
import { CsvImportForm } from "./csv-import-form";
import { MembershipSection } from "./membership-form";
import { RecurringForm, RecurringList } from "./recurring-form";
import { SettlementSection } from "./settlement-forms";

export function RecordsWorkspace() {
  const [workspace, setWorkspace] = useState<CompanyWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback((cause: unknown) => {
    if (cause instanceof SessionExpiredError) {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full reload on an identity change
      window.location.assign("/login?reason=expired");
      return;
    }
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  /** Re-read after any write, so a list never shows a stale row. */
  const load = useCallback(async () => {
    await fetchWorkspace()
      .then((next) => {
        setWorkspace(next);
        setError(null);
      })
      .catch(fail);
  }, [fail]);

  // State is only set inside the promise callback, never synchronously in the
  // effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    fetchWorkspace()
      .then((next) => {
        setWorkspace(next);
        setError(null);
      })
      .catch(fail);
  }, [fail]);

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
          <LoaderCircle className="mr-2 inline size-3.5 animate-spin" aria-hidden />
          Loading your records…
        </p>
      </Shell>
    );
  }
  if (!workspace.active) {
    return (
      <Shell>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          You have no company yet.{" "}
          <Link href="/onboarding" className="font-medium underline">
            Set one up
          </Link>
          .
        </p>
      </Shell>
    );
  }

  const active = workspace.active;
  const currency = active.company.currency;
  const refresh = () => void load();
  // The demonstration company is read-only; so is a VIEWER's view anywhere.
  const readOnly = active.company.isDemo || active.role === "VIEWER";

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            {active.company.name} · records
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Everything the forecast is built from. Amounts in {currency}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {readOnly ? (
            <Badge variant="outline" className="font-mono text-[10px]">
              {active.company.isDemo ? "demonstration · read-only" : "read-only"}
            </Badge>
          ) : null}
          <Link href="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <ArrowLeft className="size-4" aria-hidden />
            Dashboard
          </Link>
        </div>
      </div>

      <CoveragePanel coverage={active.coverage} />

      <Section title="Accounts">
        <AccountList accounts={active.records.accounts} currency={currency} onChanged={refresh} readOnly={readOnly} />
        {readOnly ? null : <AccountForm onSaved={refresh} />}
      </Section>

      <Section title="Buyers and suppliers">
        <CounterpartyList counterparties={active.records.counterparties} onChanged={refresh} readOnly={readOnly} />
        {readOnly ? null : <CounterpartyForm onSaved={refresh} />}
      </Section>

      <Section title="What you are owed">
        <ReceivableList
          receivables={active.records.receivables}
          currency={currency}
          onChanged={refresh}
          readOnly={readOnly}
        />
        {readOnly ? null : <ReceivableForm counterparties={active.records.counterparties} onSaved={refresh} />}
      </Section>

      <Section title="What you owe">
        <PayableList payables={active.records.payables} currency={currency} onChanged={refresh} readOnly={readOnly} />
        {readOnly ? null : <PayableForm counterparties={active.records.counterparties} onSaved={refresh} />}
      </Section>

      <Section title="Recurring obligations">
        <RecurringList recurring={active.recurring} payables={active.records.payables} currency={currency} onChanged={refresh} readOnly={readOnly} />
        {readOnly ? null : <RecurringForm counterparties={active.records.counterparties} onSaved={refresh} />}
      </Section>

      {active.role === "OWNER" && !active.company.isDemo ? (
        <Section title="Team">
          <MembershipSection
            members={active.members}
            invitations={active.invitations}
            selfUserId={workspace.account.userId}
            onChanged={refresh}
          />
        </Section>
      ) : null}

      {readOnly ? null : (
        <Section title="Import from CSV">
          <CsvImportForm currency={currency} onImported={refresh} />
        </Section>
      )}

      <Section title="Settlement">
        <SettlementSection
          settlement={active.settlement}
          receivables={active.records.receivables}
          payables={active.records.payables}
          counterparties={active.records.counterparties}
          currency={currency}
          readOnly={readOnly}
          canReverse={active.role === "OWNER"}
          onChanged={refresh}
        />
      </Section>

      <Section title="Financing facilities">
        <FacilityList facilities={active.records.facilities} currency={currency} onChanged={refresh} readOnly={readOnly} />
        {readOnly ? null : <FacilityForm onSaved={refresh} />}
      </Section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1 bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8">{children}</div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">{title}</h2>
      {children}
    </section>
  );
}
