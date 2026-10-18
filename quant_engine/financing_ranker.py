"""Deterministic eligibility screen + effective-cost ranking of financing quotes.

A quote is only usable if the credit score clears, the money lands before the
crunch day, and (for secured products) there is enough AR to pledge.
"""

from __future__ import annotations

from .schemas import (
    ForecastResultOutput,
    FinancingOption,
    MatchedFinancingOption,
    SmeFinancialStateInput,
)

BRIDGE_TERM_DAYS = 30


def effective_cost(option: FinancingOption, amount: float, days: int = BRIDGE_TERM_DAYS) -> float:
    """Origination fee plus pro-rata interest for a `days`-long bridge."""
    if amount <= 0:
        return 0.0
    return option.origination_fee_pct * amount + amount * option.apr * (days / 365.0)


def effective_apr(option: FinancingOption, amount: float, days: int = BRIDGE_TERM_DAYS) -> float:
    """All-in cost annualised, so a 2% fee on 30 days is not mistaken for 2% APR."""
    if amount <= 0:
        return 0.0
    return effective_cost(option, amount, days) / amount * (365.0 / days)


def _screen(
    option: FinancingOption,
    state: SmeFinancialStateInput,
    pledgeable_ar: float,
    crunch_day: int | None,
) -> tuple[float, str | None]:
    """Return (max_available, rejection_reason)."""
    if state.credit_score < option.min_credit_score:
        return 0.0, f"credit score {state.credit_score} below minimum {option.min_credit_score}"
    if crunch_day is not None and option.funding_days >= crunch_day:
        return 0.0, f"funds in {option.funding_days}d, needed by day {crunch_day}"

    available = option.max_amount
    if option.requires_ar_collateral:
        available = min(available, option.ar_coverage_ratio * pledgeable_ar)
        if available <= 0:
            return 0.0, "no AR available to pledge as collateral"
    return available, None


def rank_financing(
    state: SmeFinancialStateInput, forecast_result: ForecastResultOutput
) -> list[MatchedFinancingOption]:
    pledgeable_ar = sum(i.amount for i in state.invoices_ar)
    crunch_day = forecast_result.first_shortfall_day

    matched = []
    for option in state.financing_options:
        available, reason = _screen(option, state, pledgeable_ar, crunch_day)
        matched.append(
            MatchedFinancingOption(
                id=option.id,
                provider=option.provider,
                product_type=option.product_type,
                eligible=reason is None,
                rejection_reason=reason,
                max_available=round(available, 2),
                effective_cost_30d=round(effective_cost(option, available), 2),
                effective_apr=round(effective_apr(option, available or option.max_amount), 4),
                funding_days=option.funding_days,
                rank=0,
            )
        )

    # Cheapest usable capital first; rejected quotes keep their order at the bottom.
    matched.sort(key=lambda m: (not m.eligible, m.effective_apr))
    for i, m in enumerate(matched, start=1):
        m.rank = i
    return matched
