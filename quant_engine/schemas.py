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


MatchStatus = Literal["MATCH_CLEAN", "QTY_VARIANCE", "PRICE_VARIANCE", "MEMO_QUARANTINED"]
SupplierArchetype = Literal[
    "MONOPOLY_STRICT", "FLEXIBLE_PARTNER", "COMMERCIAL_NEGOTIATOR", "STATUTORY", "OVERHEAD"
]


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

    # --- buyer-power and 3-way-match metadata. Descriptive, except match_status,
    # which the seed uses to switch early_payment_discount_eligible off: an
    # invoice sitting in a GR/IR exception queue cannot be discounted or factored.
    revenue_concentration_pct: float = Field(
        default=0.0, ge=0, le=1, description="Share of plant revenue this buyer represents"
    )
    match_status: MatchStatus = Field(default="MATCH_CLEAN", description="3-way match (PO/GRN/invoice) state")
    match_exception_detail: str = Field(default="", description="What the receiving dock actually disputed")
    invoice_stated_terms: str = Field(default="", description="Payment terms as printed on the invoice")
    msa_governed_terms: str = Field(default="", description="Terms the Master Service Agreement actually governs at")
    terms_conflict_note: str = Field(default="", description="Why the modelled schedule differs from the print")
    allowed_signatory_role: str = Field(
        default="", description="Who may sign outbound collection text to this buyer"
    )
    # A drawdown already submitted to a lender is modelled as a deterministic
    # inflow on its funding day. It is cash in flight, not a receivable: it is
    # never discountable and never factoring collateral.
    inflow_kind: Literal["invoice", "expected_funding"] = Field(
        default="invoice", description="What this inflow is: a customer invoice or an in-flight facility draw"
    )


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
    is_payroll: bool = Field(
        default=False,
        description="Wages. Missing it is a statutory breach, not a late fee -- declared, never inferred from the name",
    )
    payroll_lock_day: int | None = Field(
        default=None,
        description="Day the bank direct-deposit file locks. The real deadline, earlier than the due day",
    )

    # --- supplier behaviour. These three are the only new fields the solver
    # reads: archetype and line-stop risk are descriptive, but goodwill memory
    # and the insurance cap change what a deferral costs and how far it can go.
    supplier_archetype: SupplierArchetype = Field(default="OVERHEAD")
    past_extension_count: int = Field(
        default=0, ge=0, description="Extensions already granted. Goodwill is a stock, not a rate"
    )
    extension_surcharge_pct: float = Field(
        default=0.0,
        ge=0,
        le=0.2,
        description="Added to deferral_fee_pct once past_extension_count >= 1",
    )
    line_stop_risk: str = Field(default="", description="Production consequence of not paying, if any")
    credit_insured_by: str = Field(default="", description="Trade-credit insurer covering this supplier")
    insurance_revocation_day_cap: int = Field(
        default=30,
        ge=0,
        description="Deferring past this triggers bureau reporting and cash-in-advance terms, so it caps the window",
    )


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
    is_existing_facility: bool = Field(
        default=False, description="Already underwritten: no fresh application, no new hard credit pull"
    )
    requires_notice_of_assignment: bool = Field(
        default=False,
        description="Factor notifies the buyer directly. Confidential (non-notification) lines do not",
    )
    notice_of_assignment_note: str = Field(default="", description="What the buyer would be told, and the cost of that")


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
    gross_margin: float = Field(
        default=0.35,
        ge=0,
        lt=1,
        description="Gross margin. DPO is AP over daily COGS, not daily revenue, so this is required to state it",
    )
    correlation_rho: float = Field(
        default=0.0,
        ge=0.0,
        le=0.95,
        description="Systemic correlation between customer payment delays. 0 keeps every invoice independent",
    )


# -------------------------------------------------------------------------- output


class WorkingCapitalMetrics(_Model):
    # None, not inf/nan, when monthly revenue isn't recorded: not computable, not zero.
    days_sales_outstanding: float | None
    days_payable_outstanding: float | None
    cash_conversion_gap_days: float | None
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
    decision_day: int | None = Field(
        default=None,
        description="Last day the full lever set is still open: 72h before the crunch, when the payroll file locks",
    )
    p10_ci_95: list[float] = Field(
        default_factory=lambda: [0.0, 0.0],
        description="Distribution-free 95% confidence interval on the crunch-day P10 estimate",
    )
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
    feasible: bool = Field(default=True, description="False when no admissible combination of levers closes the gap")
    breaches_statutory_payroll: bool = Field(
        default=False, description="A payroll run goes unpaid on its due date: a statutory breach, not a trade-off"
    )
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
