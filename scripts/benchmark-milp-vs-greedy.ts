/**
 * Does the MILP ever find a cheaper plan than a greedy heuristic on the data
 * this project ships? Measured, not asserted.
 *
 * Runs every scenario preset x every stress-dial combination through the Python
 * HiGHS MILP (`optimizeRecovery`, which requires the engine on :8000) and the
 * TypeScript greedy cost-per-dollar mirror (`localOptimize`), compares the plan
 * cost and feasibility, and writes the tally to src/lib/benchmark-results.json,
 * which the optimizer tab quotes verbatim.
 *
 *   npm run quant            # in one terminal
 *   npm run benchmark        # in another
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { engineHealth, forecastCashFlow, localOptimize, optimizeRecovery } from "../src/lib/quant-client";
import { SCENARIO_PRESETS, scenarioState } from "../src/lib/sandbox/seed-data";
import { DELAY_SHIFT_STEPS, PRIOR_EXTENSION_STEPS, RHO_STEPS, WORKFORCE_STEPS } from "../src/lib/stress-controls";

async function main() {
  if (!(await engineHealth())) {
    console.error("The Python engine is not reachable on QUANT_ENGINE_URL; start it with `npm run quant`.");
    process.exitCode = 1;
    return;
  }

  let scenarios = 0;
  let identical = 0;
  let milpCheaper = 0;
  let greedyCheaper = 0;
  let bothInfeasible = 0;
  let feasibilityDisagree = 0;
  const differences: string[] = [];

  for (const preset of Object.keys(SCENARIO_PRESETS) as (keyof typeof SCENARIO_PRESETS)[]) {
    for (const delayShift of DELAY_SHIFT_STEPS) {
      for (const workforce of WORKFORCE_STEPS) {
        for (const rho of RHO_STEPS) {
          for (const priorExtensions of PRIOR_EXTENSION_STEPS) {
            const state = scenarioState(preset, { delayShift, workforce, rho, priorExtensions });
            const forecast = await forecastCashFlow(state);
            const milp = (await optimizeRecovery(state)).optimal_plan;
            if (milp === undefined) throw new Error("engine returned no plan");
            const greedy = localOptimize(state, forecast).optimal_plan;
            const tag = `${preset} d${delayShift} w${workforce} r${rho} p${priorExtensions}`;
            scenarios += 1;
            if (!milp.feasible && !greedy.feasible) {
              bothInfeasible += 1;
            } else if (milp.feasible !== greedy.feasible) {
              feasibilityDisagree += 1;
              differences.push(`${tag}: feasible milp=${milp.feasible} greedy=${greedy.feasible}`);
            } else {
              const delta = Math.round((greedy.total_cost - milp.total_cost) * 100) / 100;
              if (Math.abs(delta) < 0.01) identical += 1;
              else if (delta > 0) {
                milpCheaper += 1;
                differences.push(`${tag}: milp ${milp.total_cost} < greedy ${greedy.total_cost}`);
              } else {
                greedyCheaper += 1;
                differences.push(`${tag}: greedy ${greedy.total_cost} < milp ${milp.total_cost}`);
              }
            }
          }
        }
      }
    }
  }

  const result = {
    scenarios,
    identical,
    milp_cheaper: milpCheaper,
    greedy_cheaper: greedyCheaper,
    both_infeasible: bothInfeasible,
    feasibility_disagree: feasibilityDisagree,
    run_at: new Date().toISOString(),
  };
  writeFileSync(join(process.cwd(), "src", "lib", "benchmark-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(result);
  if (differences.length) console.log(differences.join("\n"));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
