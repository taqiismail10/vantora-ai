/**
 * Two questions a recovery plan has to survive before anyone signs it.
 *
 * 1. **What if the counterparty says no?** Every lever in the plan except the
 *    bridge draw is an *offer*. A plan that only works when three
 *    counterparties all say yes is a forecast, not a plan.
 * 2. **What does the plan cost after the crunch?** Pulling a receivable
 *    forward and pushing a payable back is borrowing from the near future.
 *    The day-14 line going green is worthless if it turns the problem into a
 *    day-31 problem.
 *
 * Both are computed from the same forecast the optimiser used, so neither
 * re-simulates anything and neither can move the canonical figures.
 */

import {
  localOptimize,
  type ApPayableInput,
  type ArInvoiceInput,
  type ForecastResult,
  type OptimizationResult,
  type PlanAction,
  type SmeFinancialState,
} from "./quant-client";

// ------------------------------------------------- counterparty refusal (plan B)

export interface CounterpartyFallback {
  id: string;
  /** Control label: what the counterparty did. */
  label: string;
  /** The same thing said the way the owner would hear it. */
  scenario: string;
  /** Levers withdrawn in this branch, named by counterparty. */
  withdrawn: string[];
  feasible: boolean;
  /** Null when no admissible lever set closes the gap without them. */
  total_cost: number | null;
  /** Extra dollars versus the optimal plan. Null when infeasible. */
  cost_delta: number | null;
  actions: PlanAction[];
  notes: string;
}

const withoutDiscount = (state: SmeFinancialState, id: string): SmeFinancialState => ({
  ...state,
  invoices_ar: state.invoices_ar.map((inv) =>
    inv.id === id ? { ...inv, early_payment_discount_eligible: false } : inv,
  ),
});

const withoutDeferral = (state: SmeFinancialState, id: string): SmeFinancialState => ({
  ...state,
  payables_ap: state.payables_ap.map((ap) => (ap.id === id ? { ...ap, is_flexible: false } : ap)),
});

/**
 * Re-solve the gap with one or both key counterparties refusing.
 *
 * The scenarios are derived from the levers the plan actually chose, not from
 * hard-coded ids, so a different preset (or a stress scenario that changes the
 * chosen mix) produces fallbacks for *its* counterparties. A plan with no
 * counterparty-dependent levers has no fallbacks to show.
 *
 * ponytail: re-solved by the deterministic mirror against the already-computed
 * forecast rather than by three more MILP round trips. Excluding a discount or
 * a deferral cannot change the forecast, so re-forecasting three times would
 * buy nothing, and the baseline is re-solved the same way so the delta is
 * mirror-to-mirror arithmetic rather than a cross-engine subtraction.
 */
export function counterpartyFallbacks(
  state: SmeFinancialState,
  forecast: ForecastResult,
  optimization: OptimizationResult,
): CounterpartyFallback[] {
  const plan = optimization.optimal_plan;
  if (!plan.feasible || !optimization.crunch_day) return [];

  const discount = plan.actions.find((a) => a.kind === "ar_early_discount");
  const deferral = plan.actions.find((a) => a.kind === "ap_deferral");
  if (!discount && !deferral) return [];

  const buyer = state.invoices_ar.find((i) => i.id === discount?.target_id);
  const supplier = state.payables_ap.find((p) => p.id === deferral?.target_id);
  const baseline = localOptimize(state, forecast).optimal_plan.total_cost;

  const solve = (
    id: string,
    label: string,
    scenario: string,
    withdrawn: string[],
    variant: SmeFinancialState,
  ): CounterpartyFallback => {
    const result = localOptimize(variant, forecast).optimal_plan;
    const feasible = result.feasible;
    return {
      id,
      label,
      scenario,
      withdrawn,
      feasible,
      total_cost: feasible ? result.total_cost : null,
      cost_delta: feasible ? Math.round((result.total_cost - baseline) * 100) / 100 : null,
      actions: result.actions,
      notes: feasible
        ? `Re-solved without ${withdrawn.join(" and ")}. The gap is unchanged; the mix is not.`
        : result.notes,
    };
  };

  const branches: CounterpartyFallback[] = [];

  if (buyer) {
    branches.push(
      solve(
        "buyer_declines",
        `${buyer.customer_name} declines`,
        `The early-settlement offer is refused or simply ignored inside the 72-hour window.`,
        [`${buyer.customer_name}'s early-settlement incentive`],
        withoutDiscount(state, buyer.id),
      ),
    );
  }

  if (supplier) {
    branches.push(
      solve(
        "supplier_refuses",
        `${supplier.supplier_name} refuses`,
        `The supplier holds the original due date and will not take a revised schedule.`,
        [`${supplier.supplier_name}'s deferral`],
        withoutDeferral(state, supplier.id),
      ),
    );
  }

  if (buyer && supplier) {
    branches.push(
      solve(
        "both_decline",
        "Both decline",
        `Worst case: neither counterparty cooperates, and the gap has to close on the levers Vantora controls.`,
        [`${buyer.customer_name}'s incentive`, `${supplier.supplier_name}'s deferral`],
        withoutDeferral(withoutDiscount(state, buyer.id), supplier.id),
      ),
    );
  }

  return branches;
}

// ------------------------------------------------------ the day 15-45 echo cliff

export interface EchoPoint {
  day: number;
  label: string;
  /** Signed: positive is cash in, negative is cash out. */
  delta: number;
  /** Running balance after this event, assuming contingent inflows land. */
  balance: number;
  /** The same balance with every contingent inflow withheld: the conservative read. */
  balance_withheld: number;
  /** True when the cash depends on something still unresolved. */
  contingent: boolean;
  /** True when this obligation exists only because the recovery plan acted. */
  plan_created: boolean;
  reason: string;
}

export interface EchoCheck {
  window: [number, number];
  /** Post-recovery P10 balance on the crunch day: where the window starts. */
  opening_balance: number;
  buffer: number;
  points: EchoPoint[];
  min_balance: number;
  min_balance_day: number;
  clears_buffer: boolean;
  /** The same walk with every contingent inflow withheld. */
  min_balance_withheld: number;
  min_balance_day_withheld: number;
  clears_buffer_withheld: boolean;
  contingent_total: number;
  /** Days the plan itself put an obligation on. */
  plan_echo_days: number[];
}

/** Days past due this customer is expected to pay, with the forecaster's reliability stretch. */
export const scheduledArrival = (inv: ArInvoiceInput): number =>
  Math.ceil(inv.due_day + inv.expected_delay_days_mean * (2 - inv.reliability_score));

/** Mirrors the ranker: an invoice the buyer's ERP has blocked is not dependable cash. */
const MATCH_EXCEPTIONS = new Set(["QTY_VARIANCE", "PRICE_VARIANCE"]);

const deferredTo = (ap: ApPayableInput, days: number) => ap.due_day + days;

/**
 * Does the plan turn a day-14 problem into a day-31 one?
 *
 * Deliberately deterministic and deliberately ungenerous: it walks the existing
 * ledger only. **No next-cycle revenue is assumed**, because a solvency proof
 * that leans on sales nobody has made yet proves nothing. If the window clears
 * the buffer on the current book alone, it clears it.
 *
 * Contingent inflows are tracked separately rather than discounted into the
 * balance. A receivable sitting in a buyer's match-exception queue is not
 * 80% of itself, it is either reconciled or it is not — so the walk is
 * reported both ways and the UI says which one the conclusion depends on.
 */
export function postCrunchEchoCheck(
  state: SmeFinancialState,
  optimization: OptimizationResult,
  windowEnd = 45,
): EchoCheck | null {
  const crunchDay = optimization.crunch_day;
  const plan = optimization.optimal_plan;
  if (!crunchDay || !plan.feasible) return null;

  const start = crunchDay + 1;
  const buffer = state.minimum_safe_buffer;
  const inWindow = (day: number) => day >= start && day <= windowEnd;
  const points: EchoPoint[] = [];

  const accelerated = new Set(
    plan.actions.filter((a) => a.kind === "ar_early_discount").map((a) => a.target_id),
  );
  const deferred = new Map(
    plan.actions.filter((a) => a.kind === "ap_deferral").map((a) => [a.target_id, a]),
  );

  for (const inv of state.invoices_ar) {
    // Pulled forward by the plan: this cash already landed before the crunch
    // and counting it again here would double-spend it.
    if (accelerated.has(inv.id)) continue;
    const day = scheduledArrival(inv);
    if (!inWindow(day)) continue;
    const blocked = MATCH_EXCEPTIONS.has(inv.match_status ?? "MATCH_CLEAN");
    points.push({
      day,
      label: `${inv.customer_name} settles ${inv.id}`,
      delta: inv.amount,
      balance: 0,
      balance_withheld: 0,
      contingent: blocked,
      plan_created: false,
      reason: blocked
        ? `Contingent: held in the buyer's GR/IR exception queue until the 3-way match is reconciled.`
        : `Scheduled arrival, ${inv.expected_delay_days_mean}d mean delay past day ${inv.due_day}.`,
    });
  }

  for (const ap of state.payables_ap) {
    const moved = deferred.get(ap.id);
    // `moved` only tells us the plan chose this lever; the window comes from the
    // ledger and the insurance cap, exactly as the solver computed it.
    if (moved) {
      // The plan did not make this bill disappear, it moved it. The fee was
      // already paid out of the plan's total cost; the principal lands here.
      const window = Math.min(ap.max_deferral_days ?? 0, ap.insurance_revocation_day_cap ?? 30);
      const day = deferredTo(ap, window);
      if (inWindow(day)) {
        points.push({
          day,
          label: `${ap.supplier_name} deferred settlement`,
          delta: -ap.amount,
          balance: 0,
          balance_withheld: 0,
          contingent: false,
          plan_created: true,
          reason: `Moved from day ${ap.due_day} by the recovery plan. This is the bill the day-14 fix borrowed against.`,
        });
      }
      continue;
    }
    if (!inWindow(ap.due_day)) continue;
    points.push({
      day: ap.due_day,
      label: ap.supplier_name,
      delta: -ap.amount,
      balance: 0,
      balance_withheld: 0,
      contingent: false,
      plan_created: false,
      reason: `Already on the schedule; unaffected by the recovery plan.`,
    });
  }

  for (const draw of plan.actions.filter((a) => a.kind === "bridge_draw")) {
    const day = crunchDay + 30;
    if (!inWindow(day)) continue;
    points.push({
      day,
      label: `${draw.label.replace(/^Draw \$[\d,]+ from /, "")} repayment`,
      delta: -(draw.cash_impact + draw.cost),
      balance: 0,
      balance_withheld: 0,
      contingent: false,
      plan_created: true,
      reason: `Principal plus ${draw.cost.toLocaleString("en-US", { style: "currency", currency: "USD" })} of fees and interest, 30 days after the draw.`,
    });
  }

  // Outflows before inflows on the same day: the conservative ordering, since
  // a supplier is paid on a schedule and a customer pays when it pays.
  points.sort((a, b) => a.day - b.day || a.delta - b.delta);

  let balance = plan.post_recovery_p10_balance;
  let withheld = balance;
  let min = balance;
  let minDay = crunchDay;
  let minWithheld = balance;
  let minWithheldDay = crunchDay;

  for (const point of points) {
    balance = Math.round((balance + point.delta) * 100) / 100;
    point.balance = balance;
    if (balance < min) {
      min = balance;
      minDay = point.day;
    }
    if (!point.contingent) {
      withheld = Math.round((withheld + point.delta) * 100) / 100;
      if (withheld < minWithheld) {
        minWithheld = withheld;
        minWithheldDay = point.day;
      }
    }
    point.balance_withheld = withheld;
  }

  return {
    window: [start, windowEnd],
    opening_balance: plan.post_recovery_p10_balance,
    buffer,
    points,
    min_balance: min,
    min_balance_day: minDay,
    clears_buffer: min >= buffer,
    min_balance_withheld: minWithheld,
    min_balance_day_withheld: minWithheldDay,
    clears_buffer_withheld: minWithheld >= buffer,
    contingent_total: points.filter((p) => p.contingent).reduce((sum, p) => sum + p.delta, 0),
    plan_echo_days: [...new Set(points.filter((p) => p.plan_created).map((p) => p.day))].sort(
      (a, b) => a - b,
    ),
  };
}
