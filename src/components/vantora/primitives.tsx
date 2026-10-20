"use client";

/**
 * Shared display primitives for the Vantora dashboard.
 *
 * Colour is semantic, not decorative: emerald = healthy / verified,
 * amber = warning / awaiting a human, rose = shortfall / blocked.
 *
 * Money formatting is scoped to the company being rendered, through context
 * rather than module state: the server renders many requests in one process,
 * so a shared mutable "current currency" could let one company's figures
 * render with another company's symbol.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PermissionTier } from "@/lib/security/permission-gate";

import { makeMoney } from "./currency";

const CurrencyContext = createContext<string>("USD");

/** Binds every figure inside it to one company's currency. */
export function CurrencyProvider({ currency, children }: { currency: string; children: ReactNode }) {
  return <CurrencyContext.Provider value={currency}>{children}</CurrencyContext.Provider>;
}

export type MoneyFormat = ReturnType<typeof makeMoney>;

/** Formatters bound to the company whose subtree this component renders in. */
export function useMoney(): MoneyFormat {
  const code = useContext(CurrencyContext);
  return useMemo(() => makeMoney(code), [code]);
}

export const pct = (fraction: number, digits = 1) => `${(fraction * 100).toFixed(digits)}%`;

/**
 * `crunch_day` is 0 when the engine found no shortfall across any simulated
 * trajectory — a sentinel, not a real day — so it cannot index a trajectory
 * array directly (`trajectory[-1]` is `undefined`, which renders as `$NaN`).
 * Clamped to day 1 (array index 0): with no crunch, that is simply today's
 * P10, which is the figure worth showing.
 */
export const crunchDayIndex = (crunchDay: number) => Math.max(crunchDay - 1, 0);

/** Cost as an annualised rate on the cash it raised, over a 30-day bridge. */
export const impliedApr = (cost: number, raised: number) =>
  raised > 0 ? (cost / raised) * (365 / 30) : 0;

const TIER_STYLE: Record<PermissionTier, { label: string; className: string }> = {
  TIER_0_AUTO_READ: {
    label: "TIER 0 · AUTO READ",
    className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  },
  TIER_1_DRAFT_ONLY: {
    label: "TIER 1 · DRAFT ONLY",
    className: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  },
  TIER_2_HITL_APPROVAL: {
    label: "TIER 2 · HUMAN APPROVAL",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  },
  TIER_3_PROHIBITED: {
    label: "TIER 3 · PROHIBITED",
    className: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  },
};

export function TierBadge({ tier, className }: { tier: PermissionTier; className?: string }) {
  const style = TIER_STYLE[tier] ?? TIER_STYLE.TIER_2_HITL_APPROVAL;
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent font-mono text-[10px] tracking-tight", style.className, className)}
    >
      {style.label}
    </Badge>
  );
}

const DECISION_STYLE: Record<string, string> = {
  ALLOWED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  DRAFTED: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  DENIED: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

export function DecisionBadge({ decision }: { decision: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-transparent font-mono text-[10px]",
        DECISION_STYLE[decision] ?? "bg-slate-100 text-slate-700",
      )}
    >
      {decision}
    </Badge>
  );
}

/** "This number came out of a solver, not a language model." */
export function DeterministicBadge({ method }: { method: string }) {
  return (
    <Badge
      variant="outline"
      className="border-slate-200 bg-white font-mono text-[10px] text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400"
    >
      ◆ {method}
    </Badge>
  );
}

export function AttestedBadge({ ok }: { ok: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-transparent font-mono text-[10px]",
        ok
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          : "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
      )}
    >
      {ok ? "Numerical Integrity: Attested" : "Numerical Integrity: BLOCKED"}
    </Badge>
  );
}

export function KpiCard({
  label,
  value,
  sublabel,
  tone = "neutral",
  footnote,
}: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: "neutral" | "good" | "warn" | "bad";
  footnote?: ReactNode;
}) {
  const valueTone = {
    neutral: "text-slate-900 dark:text-slate-50",
    good: "text-emerald-700 dark:text-emerald-400",
    warn: "text-amber-700 dark:text-amber-400",
    bad: "text-rose-600 dark:text-rose-400",
  }[tone];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className={cn("mt-2 text-3xl font-semibold tabular-nums tracking-tight", valueTone)}>{value}</div>
      {sublabel ? (
        <div className="mt-1 text-xs tabular-nums text-slate-500 dark:text-slate-400">{sublabel}</div>
      ) : null}
      {footnote ? <div className="mt-3">{footnote}</div> : null}
    </div>
  );
}

export function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">{title}</h2>
      {hint ? <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function Metric({
  label,
  value,
  tone = "neutral",
  mono = true,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
  mono?: boolean;
}) {
  const valueTone = {
    neutral: "text-slate-900 dark:text-slate-100",
    good: "text-emerald-700 dark:text-emerald-400",
    warn: "text-amber-700 dark:text-amber-400",
    bad: "text-rose-600 dark:text-rose-400",
  }[tone];
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-slate-100 py-1.5 text-xs first:border-t-0 dark:border-slate-800/60">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className={cn("font-medium", mono && "tabular-nums", valueTone)}>{value}</span>
    </div>
  );
}
