/**
 * Builds the whole dashboard payload. Server-only: it touches the filesystem
 * (the audit chain), the app database and the Python engine.
 *
 * Both the first server render and every client refresh through
 * `GET /api/state` go through this one function, so they cannot drift.
 *
 * `state`, `forecast` and `optimization` describe the scenario as detected,
 * before any sandbox action, so the radar and the counterfactuals stay put.
 * `execution` describes the sandbox position and the plan re-solved on top of
 * it — which is what the action queue acts on.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { aiConfig } from "./agent/providers";
import {
  attestationBundle,
  COPILOT_TOOLS,
  planCostBreakdown,
  screenInvoiceMemos,
  synthesizeNarrative,
} from "./agent/vantora-copilot";
import type { ActionView, DashboardState } from "./dashboard-state";
import { engineHealth, postRecoveryP10Trajectory, procrastinationCurve } from "./quant-client";
import { counterpartyFallbacks, postCrunchEchoCheck } from "./recovery-scenarios";
import { readChain, verifyChain } from "./sandbox/execution-logger";
import { SCENARIO_PRESETS, seedSandboxDataset, type SeedResult } from "./sandbox/seed-data";
import { classifyOperation, verifyNumericalIntegrity } from "./security/permission-gate";
import { pendingApprovals } from "./server/approvals";
import { getCompany, visibleChainFor } from "./server/companies";
import { companyDataset, coverageHeadline } from "./server/company-state";
import { CompanyNotReadyError, ROLE_CAPABILITIES, type HumanActor } from "./server/identity";
import { toCents } from "./server/money";
import {
  AS_OF_DATE,
  DATASET_VERSION,
  effectiveOptimization,
  loadPlanContext,
  NEXT_STATUSES,
  sandboxAccount,
  type ScenarioRef,
} from "./server/plan";
import { BASELINE_STRESS, isBaselineStress } from "./stress-controls";

const BENCHMARK_FILE = join(process.cwd(), "src", "lib", "benchmark-results.json");

function benchmark(): DashboardState["benchmark"] {
  if (!existsSync(BENCHMARK_FILE)) return null;
  try {
    return JSON.parse(readFileSync(BENCHMARK_FILE, "utf8")) as DashboardState["benchmark"];
  } catch {
    return null;
  }
}

/**
 * The company exists but has nothing to forecast from yet.
 *
 * A distinct type, not a bare 409, because the caller's response is to send
 * the owner to onboarding — and any other conflict reaching the dashboard
 * builder must not be mistaken for that and bounced into a loop.
 */
export { CompanyNotReadyError };

export async function buildDashboardState(actor: HumanActor, ref: ScenarioRef): Promise<DashboardState> {
  const presetId = ref.preset;
  const preset = SCENARIO_PRESETS[presetId];

  // A real company forecasts from its own records; only the demonstration
  // company uses the seeded dataset. There is no path on which a customer's
  // dashboard falls back to Smart Jeans figures.
  const company = getCompany(actor.businessId);
  const real = company && !company.isDemo ? company : null;
  const dataset = real ? companyDataset(real) : null;

  if (dataset && !dataset.state) {
    const blocking = dataset.coverage.find((note) => note.level === "blocking");
    throw new CompanyNotReadyError(blocking?.message ?? "This company has no financial data yet.");
  }

  // The workforce dial rewrites payroll with the demonstration plant's
  // per-head figure, so it is held at rest for a real company's data.
  const effectiveRef: ScenarioRef = real ? { ...ref, stress: { ...ref.stress, workforce: BASELINE_STRESS.workforce } } : ref;

  const seed: SeedResult = dataset
    ? {
        mode: "company",
        smeProfileId: dataset.company.id,
        invoices: dataset.counts.receivables,
        payables: dataset.counts.payables,
        financingOptions: dataset.counts.facilities,
        quarantinedMemos: [],
      }
    : await seedSandboxDataset(presetId);

  const plan = await loadPlanContext(
    actor.businessId,
    effectiveRef,
    dataset?.state
      ? {
          state: dataset.state,
          profileId: dataset.company.id,
          dataVersion: dataset.dataVersion,
          planSlug: dataset.company.id,
          currency: dataset.company.currency,
        }
      : undefined,
  );
  const { base, ctx } = plan;
  const { forecast, optimization, state } = base;

  const narrative = synthesizeNarrative(base);
  // Integrity is a property of the whole file, so verification runs over every
  // entry; only the displayed slice is scoped to this company. `length` is
  // therefore the number of entries this company may see, not the file's size,
  // which would otherwise tell one tenant how much activity the others have.
  const fullChain = readChain();
  const chain = visibleChainFor(actor.businessId, fullChain);
  const chainVerification = { ...verifyChain(fullChain), length: chain.length };
  const pending = pendingApprovals(actor.businessId, plan.scenarioKey);
  const approvedKeys = new Map<string, { expires_at: number; delegate: string | null }>();
  for (const approval of pending) {
    for (const key of JSON.parse(approval.action_keys) as string[]) {
      approvedKeys.set(key, { expires_at: approval.expires_at, delegate: approval.delegate });
    }
  }

  const submitted: ActionView[] = plan.records.map((record) => {
    const spec = {
      counterparty:
        record.kind === "ar_early_discount"
          ? base.state.invoices_ar.find((i) => i.id === record.target_id)?.customer_name
          : record.kind === "ap_deferral"
            ? base.state.payables_ap.find((p) => p.id === record.target_id)?.supplier_name
            : base.state.financing_options.find((f) => f.id === record.target_id)?.provider,
    };
    const p = record.payload;
    return {
      action_key: record.action_key,
      kind: record.kind,
      target_id: record.target_id,
      counterparty: spec.counterparty ?? record.target_id,
      label:
        record.kind === "ar_early_discount"
          ? `Early-pay offer to ${spec.counterparty}`
          : record.kind === "ap_deferral"
            ? `Deferral request to ${spec.counterparty}`
            : `Drawdown on ${spec.counterparty}`,
      operation:
        record.kind === "ar_early_discount"
          ? "issue_early_payment_discount"
          : record.kind === "ap_deferral"
            ? "send_supplier_deferral_email"
            : "accept_financing_offer",
      status: record.status,
      confirmation: null,
      cash_cost_cents: p.discount_cents ?? p.fee_cents ?? p.cost_cents ?? 0,
      risk_charge_cents: 0,
      effect:
        record.kind === "ar_early_discount"
          ? `${(p.settlement_cents! / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} expected within ${p.settles_in_days} days if accepted`
          : record.kind === "ap_deferral"
            ? `due date day ${p.from_day} → day ${p.to_day} if accepted`
            : `${(p.principal_cents! / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} principal, funds in ${p.funding_days} days if approved`,
      next_statuses: NEXT_STATUSES[record.kind][record.status] ?? [],
      events: record.events,
      approval_expires_at: null,
      delegated_to_agent: false,
    };
  });

  const proposed: ActionView[] = plan.specs.map((spec) => {
    const approval = approvedKeys.get(spec.action_key);
    return {
      action_key: spec.action_key,
      kind: spec.kind,
      target_id: spec.target_id,
      counterparty: spec.counterparty,
      label: spec.label,
      operation: spec.operation,
      status: approval ? "APPROVED" : "PROPOSED",
      confirmation: spec.confirmation,
      cash_cost_cents: spec.cash_cost_cents,
      risk_charge_cents: spec.risk_charge_cents,
      effect: spec.effect,
      next_statuses: [],
      events: [],
      approval_expires_at: approval?.expires_at ?? null,
      delegated_to_agent: approval?.delegate != null,
    };
  });

  const split = planCostBreakdown(base);
  const crunch = optimization.crunch_day;

  return {
    company_name: state.company_name,
    plan_id: ctx.planId,
    viewer: {
      email: actor.email,
      name: actor.name,
      role: actor.role,
      capabilities: [...ROLE_CAPABILITIES[actor.role]],
      session_expires_at: actor.sessionExpiresAt,
    },
    scenario: {
      profile: presetId,
      stress: effectiveRef.stress,
      key: plan.scenarioKey,
      dataset_version: dataset ? dataset.dataVersion : DATASET_VERSION,
      as_of_date: dataset ? dataset.asOf : AS_OF_DATE,
    },
    plan_version: plan.planVersion,
    cost_breakdown: {
      cash_cents: toCents(split.cash),
      risk_cents: toCents(split.risk),
      total_cents: toCents(split.total),
    },
    execution: {
      actions: [...submitted, ...proposed],
      bundle: plan.bundle
        ? {
            action_keys: plan.bundle.action_keys,
            cash_cost_cents: plan.bundle.payload.cash_cost_cents,
            confirmation_label: plan.bundle.confirmation.label,
          }
        : null,
      current_plan: ctx.optimization.optimal_plan,
      projected_p10_at_crunch: plan.records.length && crunch ? ctx.forecast.p10_trajectory[crunch - 1] : null,
      current_crunch_day: ctx.optimization.crunch_day,
      current_required_cash: ctx.optimization.required_cash,
      settled_movements: plan.movements,
      account: sandboxAccount(plan),
      has_position: plan.records.length > 0,
      revised_after_decline: plan.records.some((r) => r.status === "DECLINED" || r.status === "FAILED"),
    },
    ai: (() => {
      // Names and status only: no key, and no hint of the inactive provider's key.
      const config = aiConfig();
      return { provider: config.provider, model: config.model, configured: config.configured, problem: config.problem?.message ?? null };
    })(),
    benchmark: benchmark(),
    profile: dataset
      ? {
          id: preset.id,
          industry: dataset.company.industry || "Not recorded",
          alert_band: preset.alert_band,
          headline: coverageHeadline(dataset.coverage) ?? "Forecast built from your own records.",
          // No demonstration scenario is offered to a real company.
          available: [],
        }
      : {
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
    company: {
      id: actor.businessId,
      name: dataset ? dataset.company.name : (state.company_name ?? "Demonstration company"),
      currency: dataset ? dataset.company.currency : "USD",
      is_demo: !dataset,
      status: dataset ? dataset.company.status : "active",
    },
    coverage: dataset ? dataset.coverage : [],
    stress: effectiveRef.stress,
    stress_is_baseline: isBaselineStress(effectiveRef.stress),
    correlation_rho: state.correlation_rho ?? 0,
    seed: {
      ...seed,
      source:
        seed.mode === "company"
          ? "Your company's records"
          : seed.mode === "prisma"
            ? "Supabase (Prisma)"
            : "In-memory demonstration dataset",
    },
    engine: {
      python_engine_up: await engineHealth(),
      forecast_source: forecast.engine_source,
      optimization_source: optimization.engine_source,
      solver_status: optimization.solver_status,
    },
    copilot: {
      tools: COPILOT_TOOLS.map((tool) => ({
        name: tool.name,
        tier: classifyOperation(tool.name),
        description: tool.description,
      })),
      narrative,
      narrative_integrity: verifyNumericalIntegrity(narrative, attestationBundle(base)),
    },
    state,
    forecast,
    optimization,
    post_recovery_p10_trajectory: postRecoveryP10Trajectory(forecast, optimization),
    procrastination_curve: procrastinationCurve(state, forecast, optimization),
    // Refusal branches of what is still to be sent, re-solved on the current position.
    counterparty_fallbacks: counterpartyFallbacks(ctx.state, ctx.forecast, ctx.optimization),
    // The aftermath of everything committed plus everything still proposed.
    post_crunch_echo_check: postCrunchEchoCheck(state, effectiveOptimization(plan)),
    memos: screenInvoiceMemos(base),
    audit: { entries: chain, verification: chainVerification },
  };
}
