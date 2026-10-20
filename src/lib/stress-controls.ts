/**
 * The four supply-chain stress dials.
 *
 * Deliberately its own module rather than part of `seed-data.ts`: the seed
 * module reaches for `node:module` to load Prisma, so anything a client
 * component imports from it drags the Node builtin into the browser bundle and
 * the Turbopack build fails. The dial definitions are shared contract — the
 * header renders them, the API route parses them, the builder applies them —
 * so they belong on the client-safe side of that boundary.
 */

import type { SmeFinancialState } from "./quant-client";

export interface StressControls {
  /** Extra days added to every buyer's expected payment delay. */
  delayShift: number;
  /** Shift operators on the floor. Sets the payroll run. */
  workforce: number;
  /** Systemic correlation between buyer delays, 0 to 0.95. */
  rho: number;
  /** Extensions this plant has already asked its flexible suppliers for. */
  priorExtensions: number;
}

/** Every control at rest. This is the state every canonical figure is pinned to. */
export const BASELINE_STRESS: StressControls = {
  delayShift: 0,
  workforce: 100,
  rho: 0,
  priorExtensions: 0,
};

/** Operators on the floor -> the monthly payroll run, at $680 a head. */
export const WORKFORCE_PAYROLL: Record<number, number> = { 100: 68_000, 125: 85_000, 150: 102_000 };

export const DELAY_SHIFT_STEPS = [0, 7, 14, 21];
export const WORKFORCE_STEPS = [100, 125, 150];
export const RHO_STEPS = [0, 0.3, 0.6];
export const PRIOR_EXTENSION_STEPS = [0, 1];

/**
 * Narrow untrusted query params to the enumerated control positions.
 *
 * Anything off the dial is rejected rather than clamped: these are four
 * discrete switches on a panel, and a hand-edited `?workforce=1e9` should
 * render the baseline, not a payroll run nobody designed.
 */
export function parseStressControls(params: URLSearchParams): StressControls {
  const onDial = (allowed: number[], raw: string | null, fallback: number) => {
    const value = Number(raw);
    return raw !== null && Number.isFinite(value) && allowed.includes(value) ? value : fallback;
  };
  return {
    delayShift: onDial(DELAY_SHIFT_STEPS, params.get("delayShift"), 0),
    workforce: onDial(WORKFORCE_STEPS, params.get("workforce"), 100),
    rho: onDial(RHO_STEPS, params.get("rho"), 0),
    priorExtensions: onDial(PRIOR_EXTENSION_STEPS, params.get("priorExtensions"), 0),
  };
}

export const isBaselineStress = (stress: StressControls): boolean =>
  stress.delayShift === BASELINE_STRESS.delayShift &&
  stress.workforce === BASELINE_STRESS.workforce &&
  stress.rho === BASELINE_STRESS.rho &&
  stress.priorExtensions === BASELINE_STRESS.priorExtensions;

export const payrollLabel = (workforce: number) =>
  `Monthly factory payroll (${workforce} shift operators)`;

/**
 * Apply the stress controls to a preset's dataset.
 *
 * At rest this returns the preset object untouched rather than a structurally
 * equal copy, so the canonical path is provably the one the tests pin — nothing
 * here can perturb it by rounding a field it did not mean to change.
 *
 * Each control moves exactly one input: the delay shift moves the AR delay
 * means, the shift scale moves the payroll run, rho moves the forecaster's
 * copula, and the goodwill memory moves `past_extension_count` on the flexible
 * suppliers (which the optimiser turns into a step surcharge).
 */
export function applyStress(state: SmeFinancialState, stress: StressControls): SmeFinancialState {
  if (isBaselineStress(stress)) return state;

  const payrollMoved = stress.workforce !== BASELINE_STRESS.workforce;
  return {
    ...state,
    correlation_rho: stress.rho,
    invoices_ar: stress.delayShift
      ? state.invoices_ar.map((inv) => ({
          ...inv,
          expected_delay_days_mean: inv.expected_delay_days_mean + stress.delayShift,
        }))
      : state.invoices_ar,
    payables_ap: state.payables_ap.map((ap) => ({
      ...ap,
      ...(ap.is_payroll && payrollMoved
        ? { amount: WORKFORCE_PAYROLL[stress.workforce], supplier_name: payrollLabel(stress.workforce) }
        : {}),
      ...(ap.is_flexible ? { past_extension_count: stress.priorExtensions } : {}),
    })),
  };
}
