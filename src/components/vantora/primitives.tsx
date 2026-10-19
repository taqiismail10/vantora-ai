/**
 * Shared display primitives for the Vantora dashboard.
 *
 * Colour is semantic, not decorative: emerald = healthy / verified,
 * amber = warning / awaiting a human, rose = shortfall / blocked.
 */

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PermissionTier } from "@/lib/security/permission-gate";

const CURRENCY_DISPLAY: Record<string, { symbol: string; locale: string }> = {
  USD: { symbol: "$", locale: "en-US" },
  BDT: { symbol: "৳", locale: "en-BD" },
  CNY: { symbol: "¥", locale: "zh-CN" },
};

// One company's figures are on screen at a time, and switching company is a
// full page reload, so the active currency is module state set by the shell
// during render rather than a prop threaded through 114 call sites.
//
// ponytail: this is safe only because the dashboard subtree contains no
// Suspense or lazy boundary, so server-side rendering walks it in a single
// synchronous pass and two concurrent requests cannot interleave between the
// shell setting the currency and a child reading it. Module state is shared
// per server process, so adding a suspending boundary inside the dashboard
// would let one company's figures render with another's currency symbol.
// If that is ever needed — or if two currencies must render together — move
// this to a React context and bind the formatter per subtree.
let activeCurrency = "USD";

/** Called by the dashboard shell during render, before any child formats money. */
export function setDisplayCurrency(code: string) {
  activeCurrency = CURRENCY_DISPLAY[code] ? code : "USD";
}

export const currencySymbol = () => CURRENCY_DISPLAY[activeCurrency].symbol;

export const money = (value: number, maxFractionDigits = 0) => {
  const { symbol, locale } = CURRENCY_DISPLAY[activeCurrency];
  return `${value < 0 ? "-" : ""}${symbol}${Math.abs(value).toLocaleString(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  })}`;
};

export const money2 = (value: number) => money(value, 2);

export const pct = (fraction: number, digits = 1) => `${(fraction * 100).toFixed(digits)}%`;

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
