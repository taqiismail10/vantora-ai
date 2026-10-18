/**
 * Bridge tests. The live-engine cases are skipped automatically when the Python
 * service is not running, so the suite is green either way — but when it IS up
 * they prove the two engines agree on the day-14 crunch.
 */

import { describe, expect, it } from "vitest";

import {
  engineHealth,
  forecastCashFlow,
  localForecast,
  localOptimize,
  optimizeRecovery,
  procrastinationCurve,
} from "../quant-client";
import {
  apexFinancialState,
  parseSmeProfileId,
  SME_PROFILES,
  type SmeProfileId,
} from "../sandbox/seed-data";

// Probed at module scope: `it.runIf` is evaluated while tests are collected,
// which happens before any beforeAll hook could set this.
const engineUp = await engineHealth();

describe("quant client", () => {
  it("falls back to the deterministic TS mirror without a Python engine", () => {
    const forecast = localForecast(apexFinancialState());
    expect(forecast.engine_source).toBe("typescript-fallback");
    expect(forecast.first_shortfall_day).toBe(14);
    expect(forecast.n_simulations).toBe(1000);
    expect(forecast.seed).toBe(42);
  });

  it("produces a plan the fallback itself rates as feasible and cheapest", () => {
    const result = localOptimize(apexFinancialState());
    expect(result.optimal_plan.meets_buffer).toBe(true);
    expect(result.optimal_plan.total_cost).toBeLessThan(result.naive_borrowing_plan.total_cost);
    expect(result.savings_vs_do_nothing).toBeGreaterThan(0);
  });

  it("uses every lever type available to it", () => {
    const kinds = new Set(localOptimize(apexFinancialState()).optimal_plan.actions.map((a) => a.kind));
    expect(kinds.has("ar_early_discount")).toBe(true);
    expect(kinds.has("ap_deferral")).toBe(true);
  });

  it("divides AP by daily COGS, not daily revenue, for DPO", () => {
    const state = apexFinancialState();
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
    const forecast = localForecast(apexFinancialState());
    expect(forecast.decision_day).toBe(11);
    const [low, high] = forecast.p10_ci_95;
    expect(low).toBeLessThanOrEqual(forecast.p10_trajectory[13]);
    expect(high).toBeGreaterThanOrEqual(forecast.p10_trajectory[13]);
  });

  it("widens the tail when invoice delays are systemically correlated", () => {
    const state = apexFinancialState();
    const independent = localForecast(state);
    const correlated = localForecast({ ...state, correlation_rho: 0.6 });
    const meanSpread = (f: typeof independent) =>
      f.p90_trajectory.reduce((sum, v, i) => sum + (v - f.p10_trajectory[i]), 0) / f.horizon_days;

    expect(meanSpread(correlated)).toBeGreaterThan(meanSpread(independent));
    // rho = 0 is the default every canonical Apex figure is pinned to.
    expect(localForecast({ ...state, correlation_rho: 0 }).p10_trajectory).toEqual(
      independent.p10_trajectory,
    );
  });

  it("prices procrastination: cost rises monotonically as levers expire", () => {
    const state = apexFinancialState();
    const forecast = localForecast(state);
    const curve = procrastinationCurve(state, forecast, localOptimize(state, forecast));

    expect(curve.map((p) => p.day_waited)).toEqual([0, 4, 7, 11, 13]);
    expect(curve.map((p) => p.days_remaining)).toEqual([14, 10, 7, 3, 1]);
    // Acting today and acting on day 4 cost the same $1,368.88; after that
    // every point is dearer than the one before, and the eve is unsolvable.
    expect(curve[0].total_cost).toBe(1368.88);
    expect(curve[1].total_cost).toBe(1368.88);
    expect(curve[3].total_cost).toBe(5812.27); // QuickFloat at 46% APR, alone
    expect(curve[4]).toMatchObject({ total_cost: null, feasible: false });

    const costs = curve.map((p) => p.total_cost ?? Infinity);
    for (let i = 1; i < costs.length; i++) expect(costs[i]).toBeGreaterThanOrEqual(costs[i - 1]);
    expect(curve[3].expired_lever).toContain("Meridian Capital");
  });

  it.each<[SmeProfileId, "GREEN" | "RED" | "BLACK"]>([
    ["SME_APEX", "RED"],
    ["SME_PRECISION", "GREEN"],
    ["SME_MIDLAND", "BLACK"],
  ])("puts %s in the %s band the dataset was shaped for", (profileId, band) => {
    const { state, alert_band } = SME_PROFILES[profileId];
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

  it("resolves only real profile ids, inherited keys included", () => {
    expect(parseSmeProfileId("SME_MIDLAND")).toBe("SME_MIDLAND");
    for (const hostile of ["", "sme_midland", "nonsense", "__proto__", "constructor", "toString"]) {
      // `in` would wave __proto__ through and then index to undefined.
      expect(parseSmeProfileId(hostile)).toBe("SME_APEX");
      expect(SME_PROFILES[parseSmeProfileId(hostile)]).toBeDefined();
    }
    expect(parseSmeProfileId(null)).toBe("SME_APEX");
  });

  it.runIf(engineUp)("prefers the Python engine when it is reachable", async () => {
    const forecast = await forecastCashFlow(apexFinancialState());
    expect(forecast.engine_source).toBe("python-fastapi");
    expect(forecast.first_shortfall_day).toBe(14);
  });

  it.runIf(engineUp)("agrees with the MILP on the crunch day and the gap", async () => {
    const state = apexFinancialState();
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
