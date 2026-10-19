/**
 * Builds the whole dashboard payload. Server-only: it touches the filesystem
 * (the audit chain) and the Python engine.
 *
 * Both the first server render and every client refresh through
 * `GET /api/state` go through this one function, so they cannot drift.
 */

import {
  attestationBundle,
  hasAnthropicKey,
  loadCopilotContext,
  recoveryPlanId,
  screenInvoiceMemos,
  synthesizeNarrative,
  COPILOT_MODEL,
  COPILOT_TOOLS,
} from "./agent/vantora-copilot";
import type { DashboardState } from "./dashboard-state";
import { engineHealth, postRecoveryP10Trajectory, procrastinationCurve } from "./quant-client";
import { readChain, verifyChain } from "./sandbox/execution-logger";
import {
  DEFAULT_SCENARIO_PRESET,
  SCENARIO_PRESETS,
  scenarioState,
  seedSandboxDataset,
  type ScenarioPresetId,
} from "./sandbox/seed-data";
import { BASELINE_STRESS, isBaselineStress, type StressControls } from "./stress-controls";
import { classifyOperation, verifyNumericalIntegrity } from "./security/permission-gate";

export async function buildDashboardState(
  presetId: ScenarioPresetId = DEFAULT_SCENARIO_PRESET,
  stress: StressControls = BASELINE_STRESS,
): Promise<DashboardState> {
  const preset = SCENARIO_PRESETS[presetId];
  const seed = await seedSandboxDataset(presetId);
  // At rest this is the preset dataset itself, which is what every canonical
  // figure is pinned to; move any control and the forecast and the MILP are
  // both re-run against the perturbed inputs.
  const state = scenarioState(presetId, stress);
  const ctx = await loadCopilotContext(state, seed.smeProfileId, presetId);
  const { forecast, optimization } = ctx;

  const narrative = synthesizeNarrative(ctx);
  const chain = readChain();

  return {
    company_name: state.company_name,
    plan_id: recoveryPlanId(optimization, presetId),
    profile: {
      id: preset.id,
      industry: preset.industry,
      alert_band: preset.alert_band,
      headline: preset.headline,
      available: Object.values(SCENARIO_PRESETS).map((p) => ({
        id: p.id,
        alert_band: p.alert_band,
        label: p.label,
        headline: p.headline,
      })),
    },
    stress,
    stress_is_baseline: isBaselineStress(stress),
    correlation_rho: state.correlation_rho ?? 0,
    seed: { ...seed, source: seed.mode === "prisma" ? "Supabase (Prisma)" : "In-memory dataset" },
    engine: {
      python_engine_up: await engineHealth(),
      forecast_source: forecast.engine_source,
      optimization_source: optimization.engine_source,
      solver_status: optimization.solver_status,
    },
    copilot: {
      anthropic_key_present: hasAnthropicKey(),
      model: hasAnthropicKey() ? COPILOT_MODEL : null,
      tools: COPILOT_TOOLS.map((tool) => ({
        name: tool.name,
        tier: classifyOperation(tool.name),
        description: tool.description,
      })),
      narrative,
      narrative_integrity: verifyNumericalIntegrity(narrative, attestationBundle(ctx)),
    },
    state,
    forecast,
    optimization,
    post_recovery_p10_trajectory: postRecoveryP10Trajectory(forecast, optimization),
    procrastination_curve: procrastinationCurve(state, forecast, optimization),
    // Already screened and sanitised by the same function the agent read path
    // uses. The raw text never leaves that module.
    memos: screenInvoiceMemos(ctx),
    audit: { entries: chain, verification: verifyChain(chain) },
  };
}
