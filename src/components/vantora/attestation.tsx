"use client";

/**
 * The attestation popover.
 *
 * "Attested" is a claim until you can see what it checked. This maps every
 * figure in the narrative back to the engine value it was matched against, so
 * the badge is an entry point to the evidence rather than a reassurance.
 */

import { BadgeCheck, ShieldX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { NumericalIntegrityResult } from "@/lib/security/permission-gate";
import { cn } from "@/lib/utils";

import { money2 } from "./primitives";

export function AttestationPopover({
  integrity,
  source,
  blocked = [],
}: {
  integrity: NumericalIntegrityResult;
  /** What produced the text, shown so "attested" is not mistaken for "generated". */
  source: string;
  /** Audit entries where this same check already refused a fabricated figure. */
  blocked?: { seq: number; reason: string }[];
}) {
  const dollars = integrity.checkedDollarFigures;
  const rates = integrity.checkedPercentages;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] transition-colors",
              integrity.ok
                ? "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                : "border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300",
            )}
          />
        }
      >
        {integrity.ok ? <BadgeCheck className="size-3" /> : <ShieldX className="size-3" />}
        {integrity.ok
          ? `✓ ${dollars.length} figures · ${rates.length} rates — traced to solver`
          : `${integrity.violations.length} figures BLOCKED`}
      </PopoverTrigger>

      <PopoverContent className="w-[26rem] max-w-[calc(100vw-2rem)]">
        <p className="text-xs font-semibold">Numerical provenance</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
          Produced by {source}. Every figure below was matched against the quant engine&apos;s own output
          before the text was allowed out of the API route.
        </p>

        <div className="mt-2 max-h-56 overflow-auto rounded-md border border-slate-200 dark:border-slate-800">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900">
              <tr>
                <th className="px-2 py-1 text-left font-medium text-slate-500">Cited</th>
                <th className="px-2 py-1 text-left font-medium text-slate-500">Kind</th>
                <th className="px-2 py-1 text-left font-medium text-slate-500">Provenance</th>
              </tr>
            </thead>
            <tbody>
              {dollars.map((value, index) => (
                <tr key={`d-${index}-${value}`} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-2 py-1 font-mono tabular-nums">{money2(value)}</td>
                  <td className="px-2 py-1 text-slate-500">dollar</td>
                  <td className="px-2 py-1 text-emerald-700 dark:text-emerald-400">matched · engine output</td>
                </tr>
              ))}
              {rates.map((value, index) => (
                <tr key={`p-${index}-${value}`} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-2 py-1 font-mono tabular-nums">{value}%</td>
                  <td className="px-2 py-1 text-slate-500">rate</td>
                  <td className="px-2 py-1 text-emerald-700 dark:text-emerald-400">matched · engine rate</td>
                </tr>
              ))}
              {integrity.violations.map((violation, index) => (
                <tr key={`v-${index}`} className="border-t border-rose-200 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/30">
                  <td className="px-2 py-1 font-mono tabular-nums">{violation.value}</td>
                  <td className="px-2 py-1 text-slate-500">{violation.kind}</td>
                  <td className="px-2 py-1 text-rose-700 dark:text-rose-400">BLOCKED — {violation.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
          <Badge variant="outline" className="mb-1 font-mono text-[10px]">
            deterministic anti-hallucination
          </Badge>
          {blocked.length ? (
            // Not an illustration: these are entries this check already wrote
            // to the chain in this session, quoted back with their sequence.
            <>
              <p>
                Fabricated numbers are rejected before display, not flagged after it. This same check has
                already refused {blocked.length} payload{blocked.length === 1 ? "" : "s"} on this chain:
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {blocked.slice(0, 4).map((entry) => (
                  <li key={entry.seq} className="flex gap-1.5">
                    <span className="shrink-0 font-mono text-rose-700 dark:text-rose-400">seq {entry.seq}</span>
                    <span className="min-w-0 truncate" title={entry.reason}>
                      {entry.reason.replace(/^numerical integrity failure: /, "")}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>
              Fabricated numbers are rejected before display, not flagged after it. Run the red-team drill to
              watch <span className="font-mono">$45,000</span> and{" "}
              <span className="font-mono">6.25% APR</span> get blocked and appended to the audit chain as
              DENIED entries.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
