"""Seeded Monte Carlo Cash-Flow-at-Risk simulator.

Every invoice is paid late by a customer-specific amount: a truncated normal
around the customer's historical delay, plus a log-normal "dispute tail" that
fires with probability (1 - reliability_score). Payables are deterministic.
1,000 trajectories, seed 42, so the same input always yields the same P10/P50/P90.
"""

from __future__ import annotations

import numpy as np
from scipy.stats import norm, truncnorm

from .schemas import (
    N_SIMULATIONS,
    SEED,
    ForecastResultOutput,
    SmeFinancialStateInput,
    WorkingCapitalMetrics,
)

DISPUTE_TAIL_MEDIAN_DAYS = 7.0
DISPUTE_TAIL_SIGMA = 0.5
#: 72h before the crunch: the payroll file locks, so the last day the full lever set is open.
DECISION_LEAD_DAYS = 3


def _payment_days(state: SmeFinancialStateInput, rng: np.random.Generator, n_sims: int) -> dict[str, np.ndarray]:
    """Sample the day each invoice's cash actually arrives, per simulation.

    With `correlation_rho > 0` every invoice shares one systemic factor per
    trajectory -- a bad month for the sector pushes the whole book late
    together, which is what actually kills an SME. The independent path is kept
    byte-for-byte as it was: a Gaussian copula reaches the same marginal through
    `ppf(cdf(z))`, but not through the same RNG draws, and the canonical Apex
    numbers are pinned to the independent sampler.
    """
    rho = state.correlation_rho
    z_sys = rng.standard_normal(n_sims) if rho > 0 else None

    out: dict[str, np.ndarray] = {}
    for inv in state.invoices_ar:
        # An unreliable payer is slower on average and more dispersed.
        stretch = 2.0 - inv.reliability_score
        loc = inv.expected_delay_days_mean * stretch
        scale = max(inv.expected_delay_days_std * stretch, 1e-6)
        a = -loc / scale

        if z_sys is None:
            delay = truncnorm.rvs(a=a, b=np.inf, loc=loc, scale=scale, size=n_sims, random_state=rng)
        else:
            z_id = rng.standard_normal(n_sims)
            z = np.sqrt(rho) * z_sys + np.sqrt(1.0 - rho) * z_id
            delay = truncnorm.ppf(norm.cdf(z), a=a, b=np.inf, loc=loc, scale=scale)

        disputed = rng.random(n_sims) < (1.0 - inv.reliability_score)
        delay = delay + disputed * rng.lognormal(np.log(DISPUTE_TAIL_MEDIAN_DAYS), DISPUTE_TAIL_SIGMA, n_sims)

        out[inv.id] = np.ceil(inv.due_day + delay).astype(np.int64)
    return out


def quantile_ci_95(column: np.ndarray, q: float = 0.10) -> list[float]:
    """Distribution-free 95% CI on a sample quantile, from the order statistics.

    The rank of the q-quantile is Binomial(n, q); its normal approximation gives
    the two order statistics that bracket it. No bootstrap, so the interval is
    exactly reproducible and costs one sort.
    """
    n = column.size
    sorted_column = np.sort(column)
    half_width = 1.96 * np.sqrt(n * q * (1.0 - q))
    lower = int(np.clip(np.floor(n * q - half_width), 0, n - 1))
    upper = int(np.clip(np.ceil(n * q + half_width), 0, n - 1))
    return [round(float(sorted_column[lower]), 2), round(float(sorted_column[upper]), 2)]


def _trajectories(state: SmeFinancialStateInput, n_sims: int) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Return (n_sims, horizon) end-of-day balances and the sampled arrival days."""
    horizon = state.horizon_days
    rng = np.random.default_rng(SEED)
    pay_days = _payment_days(state, rng, n_sims)

    # Column horizon + 1 is the "arrives after the horizon" sink.
    inflow = np.zeros((n_sims, horizon + 2))
    rows = np.arange(n_sims)
    for inv in state.invoices_ar:
        day = np.clip(pay_days[inv.id], 1, horizon + 1)
        np.add.at(inflow, (rows, day), inv.amount)

    outflow = np.zeros(horizon + 2)
    for ap in state.payables_ap:
        outflow[ap.due_day] += ap.amount

    net = inflow[:, 1 : horizon + 1] - outflow[1 : horizon + 1]
    return state.current_cash + np.cumsum(net, axis=1), pay_days


def _working_capital(state: SmeFinancialStateInput, p50: np.ndarray) -> WorkingCapitalMetrics:
    total_ar = sum(i.amount for i in state.invoices_ar)
    total_ap = sum(p.amount for p in state.payables_ap)
    daily_revenue = state.monthly_revenue / 30.0
    # DSO is receivables over daily sales; DPO is payables over daily *COGS*.
    # Dividing AP by revenue understates DPO by the whole gross margin and makes
    # the cash-conversion gap look wider than it is.
    daily_cogs = (state.monthly_revenue * (1.0 - state.gross_margin)) / 30.0
    dso = total_ar / daily_revenue
    dpo = total_ap / daily_cogs
    burn = total_ap / state.horizon_days

    below_zero = np.flatnonzero(p50 < 0)
    runway = float(below_zero[0] + 1) if below_zero.size else float(state.horizon_days)

    return WorkingCapitalMetrics(
        days_sales_outstanding=round(dso, 2),
        days_payable_outstanding=round(dpo, 2),
        cash_conversion_gap_days=round(dso - dpo, 2),
        total_ar_outstanding=round(total_ar, 2),
        total_ap_due=round(total_ap, 2),
        average_daily_burn=round(burn, 2),
        runway_days_p50=runway,
    )


def forecast(state: SmeFinancialStateInput, n_sims: int = N_SIMULATIONS) -> ForecastResultOutput:
    balances, pay_days = _trajectories(state, n_sims)

    p10, p50, p90 = (np.percentile(balances, q, axis=0) for q in (10, 50, 90))
    buffer = state.minimum_safe_buffer

    breaches = np.flatnonzero(p10 < buffer)
    first_day = int(breaches[0] + 1) if breaches.size else None

    return ForecastResultOutput(
        company_name=state.company_name,
        horizon_days=state.horizon_days,
        p10_trajectory=[round(v, 2) for v in p10],
        p50_trajectory=[round(v, 2) for v in p50],
        p90_trajectory=[round(v, 2) for v in p90],
        shortfall_detected=first_day is not None,
        first_shortfall_day=first_day,
        decision_day=max(1, first_day - DECISION_LEAD_DAYS) if first_day else None,
        p10_ci_95=quantile_ci_95(balances[:, (first_day or state.horizon_days) - 1]),
        p10_shortfall_amount=round(max(0.0, buffer - p10.min()), 2),
        p50_shortfall_amount=round(max(0.0, buffer - p50.min()), 2),
        shortfall_probability=round(float((balances.min(axis=1) < buffer).mean()), 4),
        working_capital_metrics=_working_capital(state, p50),
        minimum_safe_buffer=buffer,
        n_simulations=n_sims,
        invoice_p90_payment_day={k: float(np.percentile(v, 90)) for k, v in pay_days.items()},
    )
