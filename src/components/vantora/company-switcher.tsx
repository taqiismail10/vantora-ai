"use client";

/**
 * Which company's figures are on screen, and a way to change it.
 *
 * The list is fetched rather than carried on the dashboard payload, because it
 * is only needed by accounts that belong to more than one company. Switching
 * writes the selection cookie and reloads: the server re-validates the id
 * against the caller's memberships on the next request, so the cookie grants
 * nothing on its own.
 */

import { useEffect, useState } from "react";
import { Building2, ChevronDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { fetchWorkspace, switchCompany, type CompanySummary } from "./company-api";

export function CompanySwitcher({ activeId, activeName, isDemo }: { activeId: string; activeName: string; isDemo: boolean }) {
  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchWorkspace()
      .then((workspace) => {
        if (live) setCompanies(workspace.companies);
      })
      .catch(() => {
        // The dashboard already renders without this; a failed list is not
        // worth an error banner over.
      });
    return () => {
      live = false;
    };
  }, []);

  if (isDemo) {
    return (
      <Badge variant="outline" className="border-transparent bg-slate-100 font-mono text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        Demonstration company
      </Badge>
    );
  }

  // Still worth rendering with exactly one company: "Create another
  // company" needs an entry point even for an account that has never had
  // more than one, distinct from resuming this one's own onboarding.
  if (companies.length === 0) return null;

  const atLimit = companies.length >= 5;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <Building2 className="size-3.5" aria-hidden />
        <span className="max-w-[12rem] truncate">{activeName}</span>
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label="Switch company"
          className="absolute left-0 top-full z-30 mt-1 min-w-[16rem] overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-800 dark:bg-slate-950"
        >
          {companies.map((company) => (
            <li key={company.id} role="option" aria-selected={company.id === activeId}>
              <button
                type="button"
                onClick={() => switchCompany(company.id)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-slate-100 dark:hover:bg-slate-800",
                  company.id === activeId && "bg-slate-50 font-medium dark:bg-slate-900",
                )}
              >
                <span className="min-w-0 truncate">{company.name}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {company.isDemo ? (
                    <Badge variant="outline" className="font-mono text-[10px] text-slate-500">
                      demo
                    </Badge>
                  ) : null}
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {company.role}
                  </Badge>
                </span>
              </button>
            </li>
          ))}
          <li role="separator" className="my-1 border-t border-slate-200 dark:border-slate-800" />
          <li>
            {atLimit ? (
              <p className="px-3 py-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                This account already has the maximum of 5 companies.
              </p>
            ) : (
              <a
                href="/onboarding?new=1"
                className="block w-full px-3 py-1.5 text-left text-[11px] font-medium text-sky-700 hover:bg-slate-100 dark:text-sky-400 dark:hover:bg-slate-800"
              >
                + Create another company
              </a>
            )}
          </li>
        </ul>
      ) : null}
    </div>
  );
}
