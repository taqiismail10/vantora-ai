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
  synthesizeNarrative,
  COPILOT_MODEL,
  COPILOT_TOOLS,
} from "./agent/vantora-copilot";
import type { DashboardState } from "./dashboard-state";
import { engineHealth, postRecoveryP10Trajectory } from "./quant-client";
import { readChain, verifyChain } from "./sandbox/execution-logger";
import { APEX_INVOICE_MEMOS, apexFinancialState, seedApexDataset } from "./sandbox/seed-data";
import {
  classifyOperation,
  detectIndirectPromptInjection,
  verifyNumericalIntegrity,
} from "./security/permission-gate";

export async function buildDashboardState(): Promise<DashboardState> {
  const seed = await seedApexDataset();
  const state = apexFinancialState();
  const ctx = await loadCopilotContext(state, seed.smeProfileId);
  const { forecast, optimization } = ctx;

  const narrative = synthesizeNarrative(ctx);
  const chain = readChain();

  return {
    company_name: state.company_name,
    plan_id: recoveryPlanId(optimization),
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
    // Memos are returned already screened and sanitised. The raw text never
    // leaves this module, so nothing downstream can paste it into a prompt.
    memos: Object.entries(APEX_INVOICE_MEMOS).map(([invoiceId, memo]) => {
      const scan = detectIndirectPromptInjection(memo);
      return {
        invoice_id: invoiceId,
        customer_name: state.invoices_ar.find((i) => i.id === invoiceId)?.customer_name ?? invoiceId,
        quarantined: scan.injectionDetected,
        severity: scan.severity,
        matched_patterns: scan.matches.map((m) => m.name),
        sanitized_excerpt: scan.sanitizedMemo,
      };
    }),
    audit: { entries: chain, verification: verifyChain(chain) },
  };
}
