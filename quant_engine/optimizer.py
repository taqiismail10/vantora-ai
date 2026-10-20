"""MILP recovery planner.

Closes the P10 cash gap on the crunch day for the least total dollar + goodwill
cost, choosing among AR early-payment discounts (binary x_i), AP supplier
deferrals (binary y_j, capped by a relationship-risk budget) and bridge draws
(continuous z_f).

ponytail: each lever's contribution is scored against the P10 trajectory (the
pessimistic scenario) rather than re-simulating per candidate plan, so the
program stays linear. Upgrade path if plan interactions start to matter:
re-run the forecaster on the chosen plan and iterate (cutting-plane / SAA).
"""

from __future__ import annotations

import re

import pulp

from .financing_ranker import BRIDGE_TERM_DAYS, effective_cost, rank_financing
from .forecaster import forecast
from .schemas import (
    ApPayable,
    ForecastResultOutput,
    MatchedFinancingOption,
    OptimizationResultOutput,
    PlanAction,
    RecoveryPlan,
    SmeFinancialStateInput,
)

_UNSAFE = re.compile(r"[^A-Za-z0-9_]")


def _var_name(prefix: str, ident: str) -> str:
    return prefix + "_" + _UNSAFE.sub("_", ident)


def _cost_per_dollar(apr: float, origination_fee_pct: float) -> float:
    """Dollar cost of one borrowed dollar held for the 30-day bridge term."""
    return origination_fee_pct + apr * (BRIDGE_TERM_DAYS / 365.0)


def deferral_days(ap: ApPayable) -> int:
    """How far this bill can actually move.

    Trade-credit insurers (Atradius, Coface) withdraw cover once an account runs
    past their cap, which converts the supplier to cash-in-advance and puts the
    SME on a bureau delinquency file. That is not a fee the optimiser may trade
    off, so the window is clamped before the solver ever sees it.
    """
    return min(ap.max_deferral_days, ap.insurance_revocation_day_cap)


def deferral_fee_pct(ap: ApPayable) -> float:
    """Goodwill is a stock, not a rate.

    A three-year partner absorbs the first schedule change at no cash surcharge.
    Once it has been spent, the same request is priced like anyone else's.
    """
    return ap.deferral_fee_pct + (ap.extension_surcharge_pct if ap.past_extension_count >= 1 else 0.0)


def _idle_plan(name: str, p10: float, notes: str) -> RecoveryPlan:
    return RecoveryPlan(
        name=name,
        actions=[PlanAction(kind="none", target_id="-", label="No action required", cash_impact=0.0, cost=0.0)],
        cash_raised=0.0,
        total_cost=0.0,
        post_recovery_p10_balance=round(p10, 2),
        meets_buffer=True,
        notes=notes,
    )


# ------------------------------------------------------------------ counterfactuals


def _do_nothing_plan(
    state: SmeFinancialStateInput, crunch_day: int, required: float, p10: float
) -> RecoveryPlan:
    """Bills go unpaid: late fees on the unpaid balance plus any default penalties.

    Anything due *before* the crunch day was still affordable, so the money runs
    out on the obligations landing on and after it -- payroll first.
    """
    gap = required
    actions: list[PlanAction] = []
    cost = 0.0
    breaches_payroll = False
    due_first = sorted((p for p in state.payables_ap if p.due_day >= crunch_day), key=lambda p: p.due_day)
    for ap in due_first:
        if gap <= 0:
            break
        unpaid = min(ap.amount, gap)
        gap -= unpaid
        penalty = ap.late_fee_pct * unpaid + (ap.default_penalty if ap.is_critical else 0.0)
        cost += penalty
        detail = "{:.1%} late fee".format(ap.late_fee_pct)
        if ap.is_critical:
            detail += " + ${:,.0f} default penalty".format(ap.default_penalty)
        if ap.is_payroll:
            breaches_payroll = True
            detail = "STATUTORY BREACH: wages unpaid on the due date. " + detail
        actions.append(
            PlanAction(
                kind="missed_payable",
                target_id=ap.id,
                label="Miss {} (${:,.0f} unpaid)".format(ap.supplier_name, unpaid),
                cash_impact=0.0,
                cost=round(penalty, 2),
                detail=detail,
            )
        )
    notes = "${:,.0f} of obligations go unfunded on day {}; cash stays below the safe buffer.".format(
        required, crunch_day
    )
    if breaches_payroll:
        # Wages are not a line item to trade off against a late fee: unpaid
        # payroll is a statutory breach, so this baseline is not an option the
        # owner may choose at any price.
        notes += " Payroll goes unpaid, which is a statutory breach -- not a priced trade-off."
    return RecoveryPlan(
        name="Baseline: do nothing",
        actions=actions,
        cash_raised=0.0,
        total_cost=round(cost, 2),
        post_recovery_p10_balance=round(p10, 2),
        meets_buffer=False,
        feasible=not breaches_payroll,
        breaches_statutory_payroll=breaches_payroll,
        notes=notes,
    )


def _naive_borrowing_plan(
    state: SmeFinancialStateInput,
    matched: list[MatchedFinancingOption],
    crunch_day: int,
    required: float,
    p10: float,
) -> RecoveryPlan:
    """Borrow the whole shortfall from the most expensive quick loan on offer."""
    usable = [m for m in matched if m.eligible and m.max_available > 0]
    if not usable:
        plan = _do_nothing_plan(state, crunch_day, required, p10)
        plan.name = "Naive: borrow everything"
        plan.notes = "No eligible lender could fund in time, so naive borrowing degenerates to doing nothing."
        return plan

    worst = max(usable, key=lambda m: m.effective_apr)
    option = next(o for o in state.financing_options if o.id == worst.id)
    draw = min(required, worst.max_available)
    cost = effective_cost(option, draw)

    action = PlanAction(
        kind="bridge_draw",
        target_id=option.id,
        label="Draw ${:,.0f} from {}".format(draw, option.provider),
        cash_impact=round(draw, 2),
        cost=round(cost, 2),
        detail="{:.1%} fee + {:.1%} APR for {}d = {:.1%} effective APR".format(
            option.origination_fee_pct, option.apr, BRIDGE_TERM_DAYS, worst.effective_apr
        ),
    )
    return RecoveryPlan(
        name="Naive: borrow everything",
        actions=[action],
        cash_raised=round(draw, 2),
        total_cost=round(cost, 2),
        post_recovery_p10_balance=round(p10 + draw, 2),
        meets_buffer=p10 + draw >= state.minimum_safe_buffer - 1e-6,
        feasible=p10 + draw >= state.minimum_safe_buffer - 1e-6,
        notes="Covers the gap but ignores free working-capital levers and takes the costliest capital.",
    )


ESCALATION_NOTE = (
    "No combination of AR discounts, AP deferrals and eligible facilities closes the gap. "
    "Escalate to a bank workout or an equity injection; drawing more debt into an unclosed "
    "gap buys days and adds a creditor."
)


def _infeasible_result(
    state: SmeFinancialStateInput,
    matched: list[MatchedFinancingOption],
    crunch_day: int,
    required: float,
    p10: float,
    status: str,
) -> OptimizationResultOutput:
    headroom = sum(m.max_available for m in matched if m.eligible)
    plan = RecoveryPlan(
        name="Vantora optimal plan",
        actions=[],
        cash_raised=0.0,
        total_cost=0.0,
        post_recovery_p10_balance=round(p10, 2),
        meets_buffer=False,
        feasible=False,
        notes=ESCALATION_NOTE,
    )
    do_nothing = _do_nothing_plan(state, crunch_day, required, p10)
    naive = _naive_borrowing_plan(state, matched, crunch_day, required, p10)
    return OptimizationResultOutput(
        company_name=state.company_name,
        crunch_day=crunch_day,
        required_cash=round(required, 2),
        optimal_plan=plan,
        baseline_do_nothing_plan=do_nothing,
        naive_borrowing_plan=naive,
        matched_financing_options=matched,
        solver_status="INFEASIBLE",
        mathematical_proof_summary="\n".join(
            [
                "Crunch day {}: P10 cash ${:,.0f} vs safe buffer ${:,.0f} -> gap ${:,.0f}.".format(
                    crunch_day, p10, state.minimum_safe_buffer, required
                ),
                "MILP status: {} -- the restore-to-buffer constraint admits no solution.".format(status),
                "Total eligible facility headroom is ${:,.0f} against a ${:,.0f} gap.".format(headroom, required),
                ESCALATION_NOTE,
            ]
        ),
        savings_vs_naive=0.0,
        savings_vs_do_nothing=0.0,
    )


# ------------------------------------------------------------------------- the MILP


def optimize(
    state: SmeFinancialStateInput, forecast_result: ForecastResultOutput | None = None
) -> OptimizationResultOutput:
    fc = forecast_result or forecast(state)
    matched = rank_financing(state, fc)

    if not fc.shortfall_detected or fc.first_shortfall_day is None:
        p10 = fc.p10_trajectory[-1]
        return OptimizationResultOutput(
            company_name=state.company_name,
            crunch_day=0,
            required_cash=0.0,
            optimal_plan=_idle_plan("Vantora optimal plan", p10, "P10 cash stays above the safe buffer."),
            baseline_do_nothing_plan=_idle_plan("Baseline: do nothing", p10, "Nothing to recover from."),
            naive_borrowing_plan=_idle_plan("Naive: borrow everything", p10, "Borrowing would be pure cost."),
            matched_financing_options=matched,
            solver_status="Optimal",
            mathematical_proof_summary="No liquidity shortfall detected across 1,000 simulated trajectories.",
            savings_vs_naive=0.0,
            savings_vs_do_nothing=0.0,
        )

    crunch_day = fc.first_shortfall_day
    p10_at_crunch = fc.p10_trajectory[crunch_day - 1]
    required = state.minimum_safe_buffer - p10_at_crunch

    problem = pulp.LpProblem("vantora_recovery", pulp.LpMinimize)
    gains: list = []
    costs: list = []

    # x_i: offer an early-payment discount on eligible invoice i.
    ar_vars: dict[str, tuple] = {}
    for inv in state.invoices_ar:
        if not inv.early_payment_discount_eligible or inv.early_payment_settles_in_days > crunch_day:
            continue
        # Only a lever if the P10 scenario does not already have this cash in hand.
        if fc.invoice_p90_payment_day.get(inv.id, 0.0) <= crunch_day:
            continue
        gain = inv.amount * (1.0 - inv.early_payment_discount_pct)
        cost = inv.amount * inv.early_payment_discount_pct
        var = problem.add_variable(_var_name("x", inv.id), cat="Binary")
        ar_vars[inv.id] = (var, gain, cost)
        gains.append(gain * var)
        costs.append(cost * var)

    # y_j: defer flexible supplier bill j past the crunch day.
    ap_vars: dict[str, tuple] = {}
    risk_terms: list = []
    for ap in state.payables_ap:
        # Wages are never a lever, whatever the record says. A seed that marked
        # payroll flexible -- or a stress scenario that produced one -- would
        # otherwise let the MILP buy three days of runway by deferring wages,
        # which is a statutory breach rather than an expensive option. The
        # boundary belongs to the engine, not to whichever fixture it is fed.
        if ap.is_payroll:
            continue
        if not ap.is_flexible or ap.due_day > crunch_day:
            continue
        if ap.due_day + deferral_days(ap) <= crunch_day:
            continue  # deferral window closes before the crunch, so it frees nothing
        fee = ap.amount * deferral_fee_pct(ap)
        risk_cost = ap.relationship_risk * state.relationship_risk_price
        var = problem.add_variable(_var_name("y", ap.id), cat="Binary")
        ap_vars[ap.id] = (var, ap.amount, fee, risk_cost)
        gains.append(ap.amount * var)
        costs.append((fee + risk_cost) * var)
        risk_terms.append(ap.relationship_risk * var)

    # z_f: dollars drawn from eligible financing option f.
    fin_vars: dict[str, tuple] = {}
    for m in matched:
        if not m.eligible or m.max_available <= 0:
            continue
        option = next(o for o in state.financing_options if o.id == m.id)
        var = problem.add_variable(_var_name("z", m.id), lowBound=0, upBound=m.max_available)
        per_dollar = _cost_per_dollar(option.apr, option.origination_fee_pct)
        fin_vars[m.id] = (var, per_dollar, option)
        gains.append(var)
        costs.append(per_dollar * var)

    problem += pulp.lpSum(costs), "total_recovery_cost"
    problem += pulp.lpSum(gains) >= required, "restore_p10_to_safe_buffer"
    if risk_terms:
        problem += pulp.lpSum(risk_terms) <= state.max_relationship_risk, "relationship_risk_budget"

    # pulp 4 ships no bundled CBC; HiGHS comes from the highspy wheel.
    stats = problem.solve(pulp.getSolver("HiGHS", msg=False))
    status = stats.status.name

    if status.upper() != "OPTIMAL":
        # No admissible combination of levers reaches the buffer. Returning a
        # best-effort partial draw would recommend taking predatory debt into a
        # gap it cannot close; the honest output is that this is not a
        # working-capital problem any more.
        return _infeasible_result(state, matched, crunch_day, required, p10_at_crunch, status)

    actions: list[PlanAction] = []
    cash_raised = 0.0
    total_cost = 0.0

    for inv in state.invoices_ar:
        if inv.id not in ar_vars:
            continue
        var, gain, cost = ar_vars[inv.id]
        if (var.value() or 0.0) < 0.5:
            continue
        cash_raised += gain
        total_cost += cost
        actions.append(
            PlanAction(
                kind="ar_early_discount",
                target_id=inv.id,
                label="Offer {:.1%} early-pay discount to {}".format(
                    inv.early_payment_discount_pct, inv.customer_name
                ),
                cash_impact=round(gain, 2),
                cost=round(cost, 2),
                detail="${:,.0f} invoice settles in {}d instead of ~day {:.0f} (P90)".format(
                    inv.amount,
                    inv.early_payment_settles_in_days,
                    fc.invoice_p90_payment_day.get(inv.id, 0.0),
                ),
            )
        )

    for ap in state.payables_ap:
        if ap.id not in ap_vars:
            continue
        var, amount, fee, risk_cost = ap_vars[ap.id]
        if (var.value() or 0.0) < 0.5:
            continue
        cash_raised += amount
        total_cost += fee + risk_cost
        actions.append(
            PlanAction(
                kind="ap_deferral",
                target_id=ap.id,
                label="Defer {} by {}d".format(ap.supplier_name, deferral_days(ap)),
                cash_impact=round(amount, 2),
                cost=round(fee + risk_cost, 2),
                detail="${:,.0f} deferral fee + ${:,.0f} relationship risk ({:.2f} of {:.2f} budget){}".format(
                    fee,
                    risk_cost,
                    ap.relationship_risk,
                    state.max_relationship_risk,
                    "; includes a {:.1%} step surcharge, goodwill already spent".format(ap.extension_surcharge_pct)
                    if ap.past_extension_count >= 1 and ap.extension_surcharge_pct > 0
                    else "",
                ),
            )
        )

    for m_id, (var, per_dollar, option) in fin_vars.items():
        draw = var.value() or 0.0
        if draw <= 1e-6:
            continue
        cost = effective_cost(option, draw)
        cash_raised += draw
        total_cost += cost
        actions.append(
            PlanAction(
                kind="bridge_draw",
                target_id=m_id,
                label="Draw ${:,.0f} from {}".format(draw, option.provider),
                cash_impact=round(draw, 2),
                cost=round(cost, 2),
                detail="{:.1%} fee + {:.1%} APR for {}d".format(
                    option.origination_fee_pct, option.apr, BRIDGE_TERM_DAYS
                ),
            )
        )

    optimal = RecoveryPlan(
        name="Vantora optimal plan",
        actions=actions,
        cash_raised=round(cash_raised, 2),
        total_cost=round(total_cost, 2),
        post_recovery_p10_balance=round(p10_at_crunch + cash_raised, 2),
        meets_buffer=p10_at_crunch + cash_raised >= state.minimum_safe_buffer - 1e-6,
        feasible=p10_at_crunch + cash_raised >= state.minimum_safe_buffer - 1e-6,
        notes="MILP minimum-cost mix closing a ${:,.0f} gap on day {}.".format(required, crunch_day),
    )

    do_nothing = _do_nothing_plan(state, crunch_day, required, p10_at_crunch)
    naive = _naive_borrowing_plan(state, matched, crunch_day, required, p10_at_crunch)

    proof = "\n".join(
        [
            "Crunch day {}: P10 cash ${:,.0f} vs safe buffer ${:,.0f} -> gap ${:,.0f}.".format(
                crunch_day, p10_at_crunch, state.minimum_safe_buffer, required
            ),
            "MILP status: {}. Decision variables: {} AR discounts (binary x_i), {} AP deferrals "
            "(binary y_j), {} financing draws (continuous z_f).".format(
                status, len(ar_vars), len(ap_vars), len(fin_vars)
            ),
            "Optimal plan raises ${:,.0f} for ${:,.0f} -> post-recovery P10 ${:,.0f} >= ${:,.0f}.".format(
                cash_raised, total_cost, p10_at_crunch + cash_raised, state.minimum_safe_buffer
            ),
            "Naive borrowing of the full gap costs ${:,.0f} (saving ${:,.0f}).".format(
                naive.total_cost, naive.total_cost - total_cost
            ),
            "Doing nothing costs ${:,.0f} in late fees and default penalties (saving ${:,.0f}) "
            "and still breaches the buffer.".format(do_nothing.total_cost, do_nothing.total_cost - total_cost),
        ]
    )

    return OptimizationResultOutput(
        company_name=state.company_name,
        crunch_day=crunch_day,
        required_cash=round(required, 2),
        optimal_plan=optimal,
        baseline_do_nothing_plan=do_nothing,
        naive_borrowing_plan=naive,
        matched_financing_options=matched,
        solver_status=status,
        mathematical_proof_summary=proof,
        savings_vs_naive=round(naive.total_cost - total_cost, 2),
        savings_vs_do_nothing=round(do_nothing.total_cost - total_cost, 2),
    )
