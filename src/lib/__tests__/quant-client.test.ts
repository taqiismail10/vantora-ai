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
} from "../quant-client";
import { apexFinancialState } from "../sandbox/seed-data";

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
