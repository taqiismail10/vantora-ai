"""Sprint 1A acceptance tests for the Vantora quantitative engine."""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from quant_engine.financing_ranker import effective_apr, effective_cost, rank_financing
from quant_engine.forecaster import forecast
from quant_engine.main import app
from quant_engine.optimizer import optimize
from quant_engine.schemas import N_SIMULATIONS, SEED, ArInvoice, SmeFinancialStateInput

CRUNCH_DAY = 14
SAFE_BUFFER = 25_000.0


# --------------------------------------------------------------- Monte Carlo forecast


def test_forecast_is_reproducible(apex):
    """Seed 42 + 1,000 runs must give byte-identical trajectories every time."""
    a, b = forecast(apex), forecast(apex)
    assert a.n_simulations == N_SIMULATIONS == 1_000
    assert a.seed == SEED == 42
    assert a.p10_trajectory == b.p10_trajectory
    assert a.p50_trajectory == b.p50_trajectory
    assert a.p90_trajectory == b.p90_trajectory
    assert a.shortfall_probability == b.shortfall_probability
    assert a.invoice_p90_payment_day == b.invoice_p90_payment_day


def test_forecast_shape_and_percentile_ordering(apex):
    result = forecast(apex)
    assert len(result.p10_trajectory) == len(result.p50_trajectory) == 30
    assert len(result.p90_trajectory) == 30
    p10, p50, p90 = (np.array(t) for t in (result.p10_trajectory, result.p50_trajectory, result.p90_trajectory))
    assert np.all(p10 <= p50 + 1e-9)
    assert np.all(p50 <= p90 + 1e-9)


def test_stochastic_delays_actually_disperse(apex):
    """A log-normal/truncated-normal delay model must not collapse to a point mass."""
    result = forecast(apex)
    assert result.p90_trajectory[-1] > result.p10_trajectory[-1]
    # The unreliable payer (reliability 0.60) should sit far past its day-26 due date.
    assert result.invoice_p90_payment_day["INV-1005"] > 26


def test_day_14_liquidity_crunch_detected(apex):
    result = forecast(apex)
    assert result.shortfall_detected is True
    assert result.first_shortfall_day == CRUNCH_DAY
    # Day 13 still safe, day 14 breached: the payroll run is the trigger.
    assert result.p10_trajectory[CRUNCH_DAY - 2] >= SAFE_BUFFER
    assert result.p10_trajectory[CRUNCH_DAY - 1] < SAFE_BUFFER
    assert result.p10_shortfall_amount > 0
    assert result.p50_shortfall_amount > 0
    assert 0.9 < result.shortfall_probability <= 1.0


def test_no_shortfall_when_cash_rich(apex):
    apex.current_cash = 500_000.0
    result = forecast(apex)
    assert result.shortfall_detected is False
    assert result.first_shortfall_day is None
    assert result.p10_shortfall_amount == 0.0


def test_working_capital_metrics(apex):
    wc = forecast(apex).working_capital_metrics
    assert wc.total_ar_outstanding == pytest.approx(sum(i.amount for i in apex.invoices_ar))
    assert wc.total_ap_due == pytest.approx(sum(p.amount for p in apex.payables_ap))
    assert wc.days_sales_outstanding == pytest.approx(
        wc.total_ar_outstanding / (apex.monthly_revenue / 30), rel=1e-3
    )
    assert wc.cash_conversion_gap_days == pytest.approx(
        wc.days_sales_outstanding - wc.days_payable_outstanding, abs=0.02
    )


# ------------------------------------------------------------------ financing ranker


def test_effective_cost_is_fee_plus_pro_rata_interest(apex):
    option = next(o for o in apex.financing_options if o.id == "FIN-MERIDIAN")
    expected = 0.02 * 80_000 + 80_000 * 0.14 * (30 / 365)
    assert effective_cost(option, 80_000) == pytest.approx(expected)
    assert effective_apr(option, 80_000) == pytest.approx(expected / 80_000 * (365 / 30))
    assert effective_cost(option, 0) == 0.0


def test_ranker_screens_credit_score_and_funding_speed(apex):
    matched = {m.id: m for m in rank_financing(apex, forecast(apex))}

    assert matched["FIN-GRANITE"].eligible is False
    assert "credit score" in matched["FIN-GRANITE"].rejection_reason

    # Cheapest capital on the table, but it lands a week after payroll.
    assert matched["FIN-SBA"].eligible is False
    assert "day 14" in matched["FIN-SBA"].rejection_reason

    assert matched["FIN-MERIDIAN"].eligible is True
    assert matched["FIN-QUICKFLOAT"].eligible is True


def test_ranker_orders_eligible_options_cheapest_first(apex):
    matched = rank_financing(apex, forecast(apex))
    assert [m.rank for m in matched] == [1, 2, 3, 4]
    eligible = [m for m in matched if m.eligible]
    assert eligible[0].id == "FIN-MERIDIAN"
    assert eligible == sorted(eligible, key=lambda m: m.effective_apr)
    # Rejected quotes are pushed below every usable one.
    assert all(not m.eligible for m in matched[len(eligible) :])


def test_ar_collateral_caps_secured_facilities(apex):
    apex.invoices_ar = [
        ArInvoice(
            id="INV-TINY",
            customer_name="Tiny Co",
            amount=10_000.0,
            due_day=9,
            expected_delay_days_mean=4.0,
            expected_delay_days_std=2.0,
            reliability_score=0.9,
        )
    ]
    meridian = next(m for m in rank_financing(apex, forecast(apex)) if m.id == "FIN-MERIDIAN")
    assert meridian.max_available == pytest.approx(0.8 * 10_000)  # advance rate, not the $80k headline


# ------------------------------------------------------------------------- the MILP


def test_milp_reaches_optimality(apex):
    result = optimize(apex)
    assert result.solver_status == "Optimal"
    assert result.crunch_day == CRUNCH_DAY
    assert result.required_cash == pytest.approx(SAFE_BUFFER - forecast(apex).p10_trajectory[CRUNCH_DAY - 1])


def test_optimal_plan_restores_p10_to_safe_buffer(apex):
    plan = optimize(apex).optimal_plan
    assert plan.meets_buffer is True
    assert plan.post_recovery_p10_balance >= SAFE_BUFFER
    assert plan.cash_raised >= optimize(apex).required_cash
    assert plan.actions, "an optimal recovery plan must contain at least one action"
    assert plan.total_cost == pytest.approx(sum(a.cost for a in plan.actions), abs=0.01)


def test_vantora_beats_naive_borrowing_and_doing_nothing(apex):
    r = optimize(apex)
    assert r.optimal_plan.total_cost < r.naive_borrowing_plan.total_cost
    assert r.naive_borrowing_plan.total_cost < r.baseline_do_nothing_plan.total_cost
    assert r.savings_vs_naive > 0
    assert r.savings_vs_do_nothing > 0
    assert r.baseline_do_nothing_plan.meets_buffer is False


def test_naive_plan_uses_the_worst_eligible_lender(apex):
    r = optimize(apex)
    assert [a.target_id for a in r.naive_borrowing_plan.actions] == ["FIN-QUICKFLOAT"]
    assert r.naive_borrowing_plan.cash_raised == pytest.approx(r.required_cash)


def test_do_nothing_plan_charges_the_payroll_default_penalty(apex):
    plan = optimize(apex).baseline_do_nothing_plan
    assert [a.kind for a in plan.actions] == ["missed_payable"]
    assert plan.actions[0].target_id == "AP-PAYROLL"
    assert plan.total_cost == pytest.approx(0.02 * 58_000 + 18_000)


def test_optimal_plan_never_draws_on_an_ineligible_facility(apex):
    drawn = {a.target_id for a in optimize(apex).optimal_plan.actions if a.kind == "bridge_draw"}
    assert "FIN-SBA" not in drawn  # too slow, despite being the cheapest APR
    assert "FIN-GRANITE" not in drawn  # credit score too low


def test_relationship_risk_budget_is_respected(apex):
    apex.max_relationship_risk = 0.12
    r = optimize(apex)
    risk_by_id = {p.id: p.relationship_risk for p in apex.payables_ap}
    spent = sum(risk_by_id[a.target_id] for a in r.optimal_plan.actions if a.kind == "ap_deferral")
    assert spent <= apex.max_relationship_risk + 1e-9
    assert r.solver_status == "Optimal"
    assert r.optimal_plan.meets_buffer is True


def test_costlier_goodwill_pushes_the_plan_off_deferrals(apex):
    """Pricing relationship risk high enough must make deferrals unattractive."""
    apex.relationship_risk_price = 500_000.0
    r = optimize(apex)
    assert r.solver_status == "Optimal"
    assert not [a for a in r.optimal_plan.actions if a.kind == "ap_deferral"]
    assert r.optimal_plan.meets_buffer is True


def test_proof_summary_is_populated(apex):
    r = optimize(apex)
    assert "Crunch day 14" in r.mathematical_proof_summary
    assert "Optimal" in r.mathematical_proof_summary
    assert len(r.matched_financing_options) == 4


def test_optimizer_short_circuits_when_there_is_no_shortfall(apex):
    apex.current_cash = 500_000.0
    r = optimize(apex)
    assert r.crunch_day == 0
    assert r.required_cash == 0.0
    assert r.optimal_plan.total_cost == 0.0
    assert r.optimal_plan.meets_buffer is True
    assert r.savings_vs_naive == 0.0


# ------------------------------------------------------------------- schemas and API


def test_schemas_reject_unknown_and_invalid_fields(apex):
    with pytest.raises(ValidationError):
        SmeFinancialStateInput(**{**apex.model_dump(), "unexpected_field": 1})
    with pytest.raises(ValidationError):
        ArInvoice(
            id="X",
            customer_name="X",
            amount=-5.0,  # must be > 0
            due_day=4,
            expected_delay_days_mean=1.0,
            expected_delay_days_std=1.0,
            reliability_score=0.9,
        )
    with pytest.raises(ValidationError):
        ArInvoice(
            id="X",
            customer_name="X",
            amount=100.0,
            due_day=99,  # outside the 30-day horizon
            expected_delay_days_mean=1.0,
            expected_delay_days_std=1.0,
            reliability_score=0.9,
        )


def test_api_endpoints(apex):
    client = TestClient(app)
    payload = apex.model_dump()

    assert client.get("/health").json()["status"] == "ok"

    fc = client.post("/api/quant/forecast", json=payload)
    assert fc.status_code == 200
    assert fc.json()["first_shortfall_day"] == CRUNCH_DAY

    opt = client.post("/api/quant/optimize", json=payload)
    assert opt.status_code == 200
    body = opt.json()
    assert body["solver_status"] == "Optimal"
    assert body["optimal_plan"]["post_recovery_p10_balance"] >= SAFE_BUFFER
    assert body["optimal_plan"]["total_cost"] < body["naive_borrowing_plan"]["total_cost"]

    assert client.post("/api/quant/forecast", json={"current_cash": 1}).status_code == 422
