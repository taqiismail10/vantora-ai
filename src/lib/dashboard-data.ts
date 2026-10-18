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
  DEFAULT_SME_PROFILE,
  SME_PROFILES,
  seedApexDataset,
  smeFinancialState,
  type SmeProfileId,
} from "./sandbox/seed-data";
import { classifyOperation, verifyNumericalIntegrity } from "./security/permission-gate";

export async function buildDashboardState(
  profileId: SmeProfileId = DEFAULT_SME_PROFILE,
  correlationRho = 0,
): Promise<DashboardState> {
  const profile = SME_PROFILES[profileId];
  const seed = await seedApexDataset(profileId);
  // rho = 0 reproduces the canonical dataset exactly; above it the forecast is
  // re-run with one systemic delay factor shared by the whole receivables book.
  const base = smeFinancialState(profileId);
  const state = correlationRho > 0 ? { ...base, correlation_rho: correlationRho } : base;
  const ctx = await loadCopilotContext(state, seed.smeProfileId, profileId);
  const { forecast, optimization } = ctx;

  const narrative = synthesizeNarrative(ctx);
  const chain = readChain();

  return {
    company_name: state.company_name,
    plan_id: recoveryPlanId(optimization, profileId),
    profile: {
      id: profile.id,
      industry: profile.industry,
      alert_band: profile.alert_band,
      headline: profile.headline,
      available: Object.values(SME_PROFILES).map((p) => ({
        id: p.id,
        alert_band: p.alert_band,
        label: p.state.company_name ?? p.id,
        headline: p.headline,
      })),
    },
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
