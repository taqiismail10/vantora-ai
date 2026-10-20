"use client";

/**
 * What an owner sees when they open AI monitoring on the demonstration company.
 *
 * The restriction itself is kept: the demo dataset is synthetic and shared, so
 * no credential is ever attached to it and no agent ever runs against it. What
 * changes here is that the restriction stops being a dead end — the two real
 * ways forward are offered in place of a sentence telling the reader to go find
 * one themselves.
 *
 * The company list comes from `/api/company`, which returns only companies the
 * caller already holds a membership on, and switching writes a selection cookie
 * the server re-validates on the next request. So nothing here can reach a
 * company the account is not already entitled to, and nothing here grants
 * access — the list is a shortcut to an existing right, not a new one.
 */

import { useEffect, useState } from "react";
import { Building2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import { fetchWorkspace, switchCompany, type CompanySummary } from "./company-api";

export function MonitoringUnavailable() {
  const [companies, setCompanies] = useState<CompanySummary[] | null>(null);

  useEffect(() => {
    let live = true;
    void fetchWorkspace()
      .then((workspace) => {
        if (live) setCompanies(workspace.companies);
      })
      .catch(() => {
        // The explanation and the create path below stand on their own; a
        // failed list is not worth an error banner over.
        if (live) setCompanies([]);
      });
    return () => {
      live = false;
    };
  }, []);

  // Only a company the account OWNs can hold a connection or a mandate, so an
  // ANALYST/VIEWER membership is not offered as a next step — it would switch
  // successfully and then refuse every action on the panel.
  const ownable = (companies ?? []).filter((c) => !c.isDemo && c.role === "OWNER");
  const nonOwner = (companies ?? []).filter((c) => !c.isDemo && c.role !== "OWNER");
  const atLimit = (companies ?? []).length >= 5;

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/30">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
          AI monitoring is not available for the demonstration company
        </p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Smart Jeans Manufacturing Ltd. is a shared synthetic dataset. No API credential is attached
          to it and no agent runs against it, so its figures stay identical for every reviewer.
          Monitoring runs on a company whose records are your own.
        </p>
      </div>

      {companies === null ? (
        <p className="text-xs text-slate-400">Checking your companies…</p>
      ) : (
        <>
          {ownable.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
                Switch to a company you own
              </p>
              <ul className="flex flex-col gap-1.5">
                {ownable.map((company) => (
                  <li key={company.id}>
                    <button
                      type="button"
                      onClick={() => switchCompany(company.id)}
                      className="flex w-full items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2 text-left text-xs hover:bg-slate-50 focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:outline-none dark:border-slate-700 dark:hover:bg-slate-800"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Building2 className="size-3.5 shrink-0 text-slate-400" aria-hidden />
                        <span className="truncate text-slate-700 dark:text-slate-200">{company.name}</span>
                      </span>
                      <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                        {company.role}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {nonOwner.length > 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              You are also a member of{" "}
              {nonOwner.map((c) => c.name).join(", ")}, but configuring monitoring requires the OWNER
              role on that company.
            </p>
          ) : null}

          <div className="flex flex-col gap-2 border-t border-slate-200 pt-4 dark:border-slate-700">
            <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
              {ownable.length > 0 ? "Or set up a new one" : "Create your company"}
            </p>
            {atLimit ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                This account already has the maximum of 5 companies.
              </p>
            ) : (
              <>
                <a
                  href="/onboarding?new=1"
                  className="inline-flex items-center gap-1.5 self-start rounded-md bg-sky-600 px-3 py-2 text-xs font-medium text-white hover:bg-sky-700 focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:outline-none"
                >
                  <Plus className="size-3.5" aria-hidden /> Create your company
                </a>
                <p className="text-[10px] text-slate-400">
                  Takes you through the existing onboarding steps: profile, cash accounts, receivables
                  and payables, then your safety buffer. Monitoring becomes available once the company
                  has enough records to produce a forecast.
                </p>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
