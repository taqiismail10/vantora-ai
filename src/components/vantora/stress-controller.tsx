"use client";

/**
 * The Smart Jeans supply-chain stress controller.
 *
 * It replaces the three-company switcher, which asked the viewer to believe
 * three unrelated SMEs happened to exercise three different code paths. One
 * plant, three scenario presets and four live controls is both the honest
 * framing and the stronger demo: the same optimiser has to re-solve against
 * inputs the viewer chose, not inputs we shipped.
 *
 * Each control maps to exactly one `/api/state` query param, and leaving the
 * drawer at rest reproduces the canonical dataset byte for byte.
 */

import { useState } from "react";
import { ChevronDown, Loader2, SlidersHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { DashboardState } from "@/lib/dashboard-state";
import type { StressControls } from "@/lib/stress-controls";
import { cn } from "@/lib/utils";

type PresetId = DashboardState["profile"]["id"];

const BAND_STYLE: Record<string, { dot: string; active: string }> = {
  RED: {
    dot: "bg-rose-500",
    active: "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200",
  },
  GREEN: {
    dot: "bg-emerald-500",
    active:
      "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
  },
  BLACK: {
    dot: "bg-slate-900 dark:bg-slate-200",
    active: "border-slate-400 bg-slate-100 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100",
  },
};

const BAND_CAPTION: Record<string, string> = {
  RED: "RED — day-14 crunch",
  GREEN: "GREEN — healthy",
  BLACK: "BLACK — infeasible",
};

/** One dial. Discrete positions only: every value here is a designed scenario. */
function Dial<T extends number>({
  label,
  hint,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span
        className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-slate-400"
        title={hint}
      >
        {label}
      </span>
      <div
        role="group"
        aria-label={label}
        className="inline-flex w-fit items-center rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-800 dark:bg-slate-900"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded px-2 py-1 text-[11px] font-medium whitespace-nowrap transition-colors disabled:opacity-60",
              option.value === value
                ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-slate-100"
                : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function StressController({
  data,
  busy,
  onPreset,
  onStress,
}: {
  data: DashboardState;
  busy: boolean;
  onPreset: (preset: PresetId) => void;
  onStress: (next: Partial<StressControls>) => void;
}) {
  const [open, setOpen] = useState(false);
  const { stress } = data;
  const custom = !data.stress_is_baseline;
  // The shift-scale dial rewrites payroll with the demonstration plant's
  // per-head figure, so it is offered only where that figure is the truth.
  const demo = data.company.is_demo;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {data.profile.available.length > 0 ? (
        <div
          role="group"
          aria-label="Scenario preset"
          className="flex max-w-full items-center gap-1 overflow-x-auto rounded-md border border-slate-200 p-1 dark:border-slate-800"
        >
          {data.profile.available.map((option) => {
            const active = option.id === data.profile.id;
            const style = BAND_STYLE[option.alert_band];
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onPreset(option.id)}
                disabled={busy}
                aria-pressed={active}
                title={option.headline}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium whitespace-nowrap transition-colors",
                  active
                    ? cn("border", style.active)
                    : "border border-transparent text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800",
                )}
              >
                <span className={cn("size-1.5 rounded-full", style.dot)} />
                {option.label}
                <span className="font-mono text-[10px]">
                  [{BAND_CAPTION[option.alert_band] ?? option.alert_band}]
                </span>
              </button>
            );
          })}
        </div>
        ) : null}

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors",
            custom
              ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
              : "border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-800",
          )}
        >
          <SlidersHorizontal className="size-3.5" />
          Stress controls
          {custom ? (
            <Badge variant="outline" className="border-transparent bg-amber-200/70 font-mono text-[10px] text-amber-900 dark:bg-amber-900/60 dark:text-amber-100">
              Custom stress simulation
            </Badge>
          ) : null}
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          )}
        </button>
      </div>

      {open ? (
        <div className="flex flex-wrap items-start gap-x-5 gap-y-3 rounded-md border border-slate-200 bg-slate-50/70 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-900/40">
          <Dial
            label="Buyer delay shift"
            hint="Adds days to every buyer's expected payment delay, on top of their own distribution."
            value={stress.delayShift}
            disabled={busy}
            onChange={(delayShift) => onStress({ delayShift })}
            options={[
              { value: 0, label: "+0d on-time" },
              { value: 7, label: "+7d" },
              { value: 14, label: "+14d" },
              { value: 21, label: "+21d" },
            ]}
          />
          {demo ? (
            <Dial
              label="Plant shift scale"
              hint="Operators on the floor at $680 a head. Moves the payroll run, which is the hard constraint."
              value={stress.workforce}
              disabled={busy}
              onChange={(workforce) => onStress({ workforce })}
              options={[
                { value: 100, label: "100 ops · $68k" },
                { value: 125, label: "125 ops · $85k" },
                { value: 150, label: "150 ops · $102k" },
              ]}
            />
          ) : null}
          <Dial
            label="Systemic correlation ρ"
            hint="Shared factor across buyer delays. Above zero the whole receivables book slips together."
            value={stress.rho}
            disabled={busy}
            onChange={(rho) => onStress({ rho })}
            options={[
              { value: 0, label: "0.0 independent" },
              { value: 0.3, label: "0.3 moderate" },
              { value: 0.6, label: "0.6 sector stress" },
            ]}
          />
          <Dial
            label="Supplier goodwill memory"
            hint="Extensions already asked of the flexible suppliers. Goodwill is a stock, not a rate."
            value={stress.priorExtensions}
            disabled={busy}
            onChange={(priorExtensions) => onStress({ priorExtensions })}
            options={[
              { value: 0, label: "0 prior · no cash fee" },
              { value: 1, label: "1 prior · +1.5% step" },
            ]}
          />
          <p className="w-full text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            {custom
              ? "Every control change re-runs the 1,000-trajectory forecast and re-solves the MILP against the perturbed inputs. These are assumptions you chose, not facts about your business."
              : demo
                ? "All four controls are at rest, so this is the canonical dataset: $52,000 opening cash, a $74,700 day-14 gap and a $1,368.88 optimal plan."
                : "The controls are at rest, so this is your own data as entered. Moving a dial asks a what-if question; it does not change your records."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
