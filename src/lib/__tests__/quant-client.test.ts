/**
 * Bridge tests. The live-engine cases are skipped automatically when the Python
 * service is not running, so the suite is green either way — but when it IS up
 * they prove the two engines agree on the day-14 crunch.
 */

import { describe, expect, it } from "vitest";

import {
  deferralFeePct,
  engineHealth,
  forecastCashFlow,
  localForecast,
  localOptimize,
  optimizeRecovery,
  pledgeableAr,
  procrastinationCurve,
  uncertaintyWindows,
} from "../quant-client";
import {
  parseScenarioPresetId,
  SCENARIO_PRESETS,
  smartJeansFinancialState,
  type ScenarioPresetId,
} from "../sandbox/seed-data";
import { applyStress, BASELINE_STRESS, parseStressControls } from "../stress-controls";

// Probed at module scope: `it.runIf` is evaluated while tests are collected,
// which happens before any beforeAll hook could set this.
const engineUp = await engineHealth();

describe("uncertaintyWindows", () => {
  it("finds the days where the P10-P90 band is open, and nothing where the percentiles coincide", () => {
    const p10 = [52, 52, 42, 42, 68, 9, 9, -49, -49, -49, -49, -6];
    const p90 = [52, 52, 68, 102, 102, 9, 9, -49, -49, -49, -6, 2];
    const forecast = { p10_trajectory: p10, p90_trajectory: p90 } as unknown as Parameters<typeof uncertaintyWindows>[0];
    expect(uncertaintyWindows(forecast)).toEqual([
      { from: 3, to: 5, max_spread: 60, max_day: 4 },
      { from: 11, to: 12, max_spread: 43, max_day: 11 },
    ]);
  });
});

describe("quant client", () => {
  it("falls back to the deterministic TS mirror without a Python engine", () => {
    const forecast = localForecast(smartJeansFinancialState());
    expect(forecast.engine_source).toBe("typescript-fallback");
    expect(forecast.first_shortfall_day).toBe(14);
    expect(forecast.n_simulations).toBe(1000);
    expect(forecast.seed).toBe(42);
  });

  it("produces a plan the fallback itself rates as feasible and cheapest", () => {
    const result = localOptimize(smartJeansFinancialState());
    expect(result.optimal_plan.meets_buffer).toBe(true);
    expect(result.optimal_plan.total_cost).toBeLessThan(result.naive_borrowing_plan.total_cost);
    expect(result.savings_vs_do_nothing).toBeGreaterThan(0);
  });

  it("uses every lever type available to it", () => {
    const kinds = new Set(localOptimize(smartJeansFinancialState()).optimal_plan.actions.map((a) => a.kind));
    expect(kinds.has("ar_early_discount")).toBe(true);
    expect(kinds.has("ap_deferral")).toBe(true);
  });

  it("divides AP by daily COGS, not daily revenue, for DPO", () => {
    const state = smartJeansFinancialState();
    const wc = localForecast(state).working_capital_metrics;
    const dailyCogs = (state.monthly_revenue * (1 - (state.gross_margin ?? 0.35))) / 30;
    expect(wc.days_payable_outstanding).toBeCloseTo(wc.total_ap_due / dailyCogs, 1);
    // The old denominator was strictly larger, so it reported a smaller DPO.
    expect(wc.days_payable_outstanding).toBeGreaterThan(wc.total_ap_due / (state.monthly_revenue / 30));
    expect(wc.cash_conversion_gap_days).toBeCloseTo(
      wc.days_sales_outstanding - wc.days_payable_outstanding,
      2,
    );
  });

  it("reports a decision day 72h before the crunch and a CI around the P10", () => {
    const forecast = localForecast(smartJeansFinancialState());
    expect(forecast.decision_day).toBe(11);
    const [low, high] = forecast.p10_ci_95;
    expect(low).toBeLessThanOrEqual(forecast.p10_trajectory[13]);
    expect(high).toBeGreaterThanOrEqual(forecast.p10_trajectory[13]);
  });

  it("widens the tail when invoice delays are systemically correlated", () => {
    const state = smartJeansFinancialState();
    const independent = localForecast(state);
    const correlated = localForecast({ ...state, correlation_rho: 0.6 });
    const meanSpread = (f: typeof independent) =>
      f.p90_trajectory.reduce((sum, v, i) => sum + (v - f.p10_trajectory[i]), 0) / f.horizon_days;

    expect(meanSpread(correlated)).toBeGreaterThan(meanSpread(independent));
    // rho = 0 is the default every canonical Smart Jeans figure is pinned to.
    expect(localForecast({ ...state, correlation_rho: 0 }).p10_trajectory).toEqual(
      independent.p10_trajectory,
    );
  });

  it("prices procrastination: cost rises monotonically as levers expire", () => {
    const state = smartJeansFinancialState();
    const forecast = localForecast(state);
    const curve = procrastinationCurve(state, forecast, localOptimize(state, forecast));

    expect(curve.map((p) => p.day_waited)).toEqual([0, 4, 7, 11, 13]);
    expect(curve.map((p) => p.days_remaining)).toEqual([14, 10, 7, 3, 1]);
    // Acting today and acting on day 4 cost the same $1,368.88; after that
    // every point is dearer than the one before, and the eve is unsolvable.
    expect(curve[0].total_cost).toBe(1368.88);
    expect(curve[1].total_cost).toBe(1368.88);
    // Day 7: Midland needs six days' notice, so the deferral is gone and a
    // dearer discount takes its place.
    expect(curve[2].total_cost).toBe(1486.79);
    // Day 11 is the payroll file lock: every working-capital lever has closed
    // and the whole gap has to be borrowed.
    expect(curve[3].total_cost).toBe(2353.56);
    expect(curve[4]).toMatchObject({ total_cost: null, feasible: false });

    const costs = curve.map((p) => p.total_cost ?? Infinity);
    for (let i = 1; i < costs.length; i++) expect(costs[i]).toBeGreaterThanOrEqual(costs[i - 1]);
    expect(curve[2].expired_lever).toContain("Midland Hardware");
    expect(curve[3].expired_lever).toContain("Zara International");
  });

  it.each<[ScenarioPresetId, "GREEN" | "RED" | "BLACK"]>([
    ["SOLVABLE_DAY14_CRUNCH", "RED"],
    ["HEALTHY_RUNWAY", "GREEN"],
    ["INSOLVENT_STRUCTURAL_GAP", "BLACK"],
  ])("puts %s in the %s band the dataset was shaped for", (profileId, band) => {
    const { state, alert_band } = SCENARIO_PRESETS[profileId];
    expect(alert_band).toBe(band);

    const forecast = localForecast(state);
    const result = localOptimize(state, forecast);

    if (band === "GREEN") {
      expect(forecast.shortfall_detected).toBe(false);
      expect(Math.min(...forecast.p10_trajectory)).toBeGreaterThanOrEqual(state.minimum_safe_buffer);
      expect(result.optimal_plan.total_cost).toBe(0);
      expect(result.optimal_plan.meets_buffer).toBe(true);
      return;
    }

    expect(forecast.shortfall_detected).toBe(true);
    expect(result.baseline_do_nothing_plan.breaches_statutory_payroll).toBe(true);

    if (band === "RED") {
      expect(result.solver_status).toBe("Optimal");
      expect(result.optimal_plan.feasible).toBe(true);
      expect(result.optimal_plan.total_cost).toBeLessThan(result.naive_borrowing_plan.total_cost);
      return;
    }

    // BLACK: every eligible facility drawn to the ceiling still leaves a hole,
    // so the honest answer is escalation rather than a cheaper draw.
    expect(result.solver_status).toBe("INFEASIBLE");
    expect(result.optimal_plan.feasible).toBe(false);
    expect(result.optimal_plan.actions).toEqual([]);
    const headroom = result.matched_financing_options
      .filter((m) => m.eligible)
      .reduce((sum, m) => sum + m.max_available, 0);
    expect(headroom).toBeLessThan(result.required_cash);
  });

  it("resolves only real preset ids, legacy aliases and inherited keys included", () => {
    expect(parseScenarioPresetId("INSOLVENT_STRUCTURAL_GAP")).toBe("INSOLVENT_STRUCTURAL_GAP");
    // Bookmarked links from the three-company era still land on the right preset.
    expect(parseScenarioPresetId("SME_APEX")).toBe("SOLVABLE_DAY14_CRUNCH");
    expect(parseScenarioPresetId("SME_PRECISION")).toBe("HEALTHY_RUNWAY");
    expect(parseScenarioPresetId("SME_MIDLAND")).toBe("INSOLVENT_STRUCTURAL_GAP");

    for (const hostile of ["", "sme_midland", "nonsense", "__proto__", "constructor", "toString"]) {
      // `in` would wave __proto__ through and then index to undefined.
      expect(parseScenarioPresetId(hostile)).toBe("SOLVABLE_DAY14_CRUNCH");
      expect(SCENARIO_PRESETS[parseScenarioPresetId(hostile)]).toBeDefined();
    }
    expect(parseScenarioPresetId(null)).toBe("SOLVABLE_DAY14_CRUNCH");
  });

  it("rejects stress-control values that are off the dial", () => {
    const at = (query: string) => parseStressControls(new URLSearchParams(query));
    expect(at("")).toEqual(BASELINE_STRESS);
    expect(at("delayShift=14&workforce=150&rho=0.6&priorExtensions=1")).toEqual({
      delayShift: 14,
      workforce: 150,
      rho: 0.6,
      priorExtensions: 1,
    });
    // A hand-edited URL must render the baseline, not a payroll run nobody
    // designed: these are four discrete switches, so off-dial is not clamped.
    expect(at("workforce=1e9&delayShift=3&rho=0.99&priorExtensions=-1")).toEqual(BASELINE_STRESS);
    expect(at("workforce=__proto__&rho=NaN")).toEqual(BASELINE_STRESS);
  });

  it("leaves the canonical dataset untouched at rest and perturbs exactly one input per control", () => {
    const preset = SCENARIO_PRESETS.SOLVABLE_DAY14_CRUNCH.state;
    // Identity, not deep equality: nothing in the stress path may re-derive the
    // dataset every canonical figure is pinned to.
    expect(applyStress(preset, BASELINE_STRESS)).toBe(preset);

    const heavier = applyStress(preset, { ...BASELINE_STRESS, workforce: 150 });
    expect(heavier.payables_ap.find((p) => p.is_payroll)?.amount).toBe(102_000);
    expect(heavier.invoices_ar).toBe(preset.invoices_ar); // delay dial untouched

    const later = applyStress(preset, { ...BASELINE_STRESS, delayShift: 7 });
    expect(later.invoices_ar.map((i) => i.expected_delay_days_mean)).toEqual(
      preset.invoices_ar.map((i) => i.expected_delay_days_mean + 7),
    );
    expect(later.payables_ap.find((p) => p.is_payroll)?.amount).toBe(68_000);
  });

  it("prices spent goodwill as a step surcharge, not a smooth rate", () => {
    const preset = SCENARIO_PRESETS.SOLVABLE_DAY14_CRUNCH.state;
    const partner = preset.payables_ap.find((p) => p.id === "AP-RAW-STEEL")!;
    expect(deferralFeePct(partner)).toBe(0.005); // first ask: no cash surcharge

    const burned = applyStress(preset, { ...BASELINE_STRESS, priorExtensions: 1 });
    const after = burned.payables_ap.find((p) => p.id === "AP-RAW-STEEL")!;
    expect(deferralFeePct(after)).toBeCloseTo(0.02, 10); // 0.5% + a 1.5% step
    expect(after.amount * (deferralFeePct(after) - deferralFeePct(partner))).toBeCloseTo(450, 2);

    // Once goodwill is spent the deferral loses to borrowing on price, so the
    // optimiser stops recommending it rather than quietly paying more for it.
    const plan = localOptimize(burned).optimal_plan;
    expect(plan.actions.some((a) => a.target_id === "AP-RAW-STEEL")).toBe(false);
    expect(plan.total_cost).toBeGreaterThan(1368.88);
  });

  it("never treats payroll as a deferral lever, even if the record says flexible", () => {
    const state = smartJeansFinancialState();
    const payrolled: typeof state = {
      ...state,
      payables_ap: state.payables_ap.map((ap) =>
        // Absurdly cheap and wide open, so price cannot be what excludes it.
        ap.is_payroll ? { ...ap, is_flexible: true, max_deferral_days: 21, deferral_fee_pct: 0.001 } : ap,
      ),
    };
    const plan = localOptimize(payrolled).optimal_plan;
    expect(plan.feasible).toBe(true);
    expect(plan.actions.some((a) => a.target_id === "AP-PAYROLL")).toBe(false);
    // And the guard costs nothing on the canonical path.
    expect(plan.total_cost).toBe(1368.88);
  });

  it("excludes match-exception invoices from the borrowing base", () => {
    const state = smartJeansFinancialState();
    const blocked = state.invoices_ar.find((i) => i.match_status === "QTY_VARIANCE")!;
    const gross = state.invoices_ar.reduce((sum, i) => sum + i.amount, 0);
    // A receivable the buyer's ERP has already blocked cannot be assigned, so
    // it dilutes the borrowing base rather than padding it.
    expect(pledgeableAr(state)).toBe(gross - blocked.amount);
    expect(blocked.early_payment_discount_eligible ?? false).toBe(false);
  });

  it.runIf(engineUp)("prefers the Python engine when it is reachable", async () => {
    const forecast = await forecastCashFlow(smartJeansFinancialState());
    expect(forecast.engine_source).toBe("python-fastapi");
    expect(forecast.first_shortfall_day).toBe(14);
  });

  it.runIf(engineUp)("agrees with the MILP on the crunch day and the gap", async () => {
    const state = smartJeansFinancialState();
    const [remote, local] = [await optimizeRecovery(state), localOptimize(state)];
    expect(remote.engine_source).toBe("python-fastapi");
    expect(remote.solver_status).toBe("Optimal");
    expect(remote.crunch_day).toBe(local.crunch_day);
    expect(remote.required_cash).toBeCloseTo(local.required_cash, 2);
    // The greedy mirror must not claim to beat the true optimum.
    expect(local.optimal_plan.total_cost).toBeGreaterThanOrEqual(
      remote.optimal_plan.total_cost - 0.01,
    );
  });
});
