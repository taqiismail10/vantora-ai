"""Pydantic v2 contracts shared by the quant engine and the Next.js client."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

HORIZON_DAYS = 30
N_SIMULATIONS = 1_000
SEED = 42


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------- input


class ArInvoice(_Model):
    """An outstanding customer invoice (accounts receivable)."""

    id: str
    customer_name: str
    amount: float = Field(gt=0)
    due_day: int = Field(ge=1, le=HORIZON_DAYS, description="Day in the horizon the invoice is contractually due")
    expected_delay_days_mean: float = Field(ge=0, description="Mean days paid past due for this customer")
    expected_delay_days_std: float = Field(ge=0)
    reliability_score: float = Field(gt=0, le=1, description="1.0 = always pays as modelled, lower = heavier tail")
    early_payment_discount_eligible: bool = False
    early_payment_discount_pct: float = Field(default=0.02, ge=0, le=0.2, description="Discount offered to pull cash forward")
    early_payment_settles_in_days: int = Field(default=3, ge=1, description="Days until an accepted discount lands as cash")


class ApPayable(_Model):
    """A supplier bill, payroll run or other scheduled outflow."""

    id: str
    supplier_name: str
    amount: float = Field(gt=0)
    due_day: int = Field(ge=1, le=HORIZON_DAYS)
    is_flexible: bool = Field(default=False, description="Supplier will accept a negotiated deferral")
    max_deferral_days: int = Field(default=0, ge=0)
    deferral_fee_pct: float = Field(default=0.0, ge=0, le=0.2)
    relationship_risk: float = Field(default=0.0, ge=0, le=1, description="Goodwill cost of deferring this supplier")
    late_fee_pct: float = Field(default=0.0, ge=0, le=1, description="Penalty if simply missed (do-nothing baseline)")
    is_critical: bool = Field(default=False, description="Payroll/tax: missing it triggers default_penalty")
    default_penalty: float = Field(default=0.0, ge=0)


class FinancingOption(_Model):
    """A bridge facility quote available to the SME."""

    id: str
    provider: str
    product_type: Literal["invoice_factoring", "bridge_loan", "line_of_credit", "merchant_advance"]
    max_amount: float = Field(gt=0)
    apr: float = Field(ge=0, description="Annualised interest rate, e.g. 0.18")
    origination_fee_pct: float = Field(default=0.0, ge=0, le=0.2)
    min_credit_score: int = Field(default=0, ge=0, le=850)
    funding_days: int = Field(ge=0, description="Days from acceptance to money in the account")
    requires_ar_collateral: bool = False
    ar_coverage_ratio: float = Field(default=0.8, gt=0, le=1, description="Advance rate against pledged AR")


class SmeFinancialStateInput(_Model):
    current_cash: float = Field(ge=0)
    minimum_safe_buffer: float = Field(ge=0)
    credit_score: int = Field(ge=0, le=850)
    monthly_revenue: float = Field(gt=0)
    invoices_ar: list[ArInvoice]
    payables_ap: list[ApPayable]
    financing_options: list[FinancingOption] = Field(default_factory=list)
    company_name: str = "SME"
    horizon_days: int = Field(default=HORIZON_DAYS, ge=7, le=HORIZON_DAYS)
    max_relationship_risk: float = Field(default=1.0, ge=0, description="Total relationship_risk the owner will spend")
    relationship_risk_price: float = Field(default=2_000.0, ge=0, description="$ the owner implicitly pays to avoid 1.0 of risk")


# -------------------------------------------------------------------------- output


class WorkingCapitalMetrics(_Model):
    days_sales_outstanding: float
    days_payable_outstanding: float
    cash_conversion_gap_days: float
    total_ar_outstanding: float
    total_ap_due: float
    average_daily_burn: float
    runway_days_p50: float


class ForecastResultOutput(_Model):
    company_name: str
    horizon_days: int
    p10_trajectory: list[float]
    p50_trajectory: list[float]
    p90_trajectory: list[float]
    shortfall_detected: bool
    first_shortfall_day: int | None
    p10_shortfall_amount: float
    p50_shortfall_amount: float
    shortfall_probability: float
    working_capital_metrics: WorkingCapitalMetrics
    minimum_safe_buffer: float
    n_simulations: int = N_SIMULATIONS
    seed: int = SEED
    invoice_p90_payment_day: dict[str, float] = Field(
        default_factory=dict, description="Pessimistic (P90) arrival day per invoice, used by the optimizer"
    )


class PlanAction(_Model):
    kind: Literal["ar_early_discount", "ap_deferral", "bridge_draw", "missed_payable", "none"]
    target_id: str
    label: str
    cash_impact: float = Field(description="Cash made available on or before the crunch day")
    cost: float = Field(description="Dollar cost of taking this action")
    detail: str = ""


class RecoveryPlan(_Model):
    name: str
    actions: list[PlanAction]
    cash_raised: float
    total_cost: float
    post_recovery_p10_balance: float
    meets_buffer: bool
    notes: str = ""


class MatchedFinancingOption(_Model):
    id: str
    provider: str
    product_type: str
    eligible: bool
    rejection_reason: str | None
    max_available: float
    effective_cost_30d: float = Field(description="Cost of drawing max_available for 30 days")
    effective_apr: float
    funding_days: int
    rank: int


class OptimizationResultOutput(_Model):
    company_name: str
    crunch_day: int
    required_cash: float
    optimal_plan: RecoveryPlan
    baseline_do_nothing_plan: RecoveryPlan
    naive_borrowing_plan: RecoveryPlan
    matched_financing_options: list[MatchedFinancingOption]
    solver_status: str
    mathematical_proof_summary: str
    savings_vs_naive: float
    savings_vs_do_nothing: float
