/**
 * What the forecast on screen does and does not rest on.
 *
 * This is the product's honesty surface, so it renders in the open rather than
 * behind a toggle: a warning here is the difference between a projection you
 * can act on and one that is missing an obligation. Warnings are visually
 * separated from notes so a missing payroll run cannot read like a footnote.
 */

import { AlertTriangle, Info } from "lucide-react";

import type { DashboardState } from "@/lib/dashboard-state";

export function CoveragePanel({ coverage }: { coverage: DashboardState["coverage"] }) {
  const warnings = coverage.filter((note) => note.level === "warning");
  const notes = coverage.filter((note) => note.level === "info");
  if (warnings.length === 0 && notes.length === 0) return null;

  return (
    <section
      aria-label="Forecast coverage"
      className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          What this forecast rests on
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {warnings.length > 0
            ? `${warnings.length} thing${warnings.length === 1 ? "" : "s"} could make it wrong`
            : "Nothing is known to be missing"}
        </p>
      </div>

      {warnings.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {warnings.map((note) => (
            <li
              key={note.code}
              className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{note.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {notes.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {notes.map((note) => (
            <li key={note.code} className="flex gap-2 px-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{note.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
