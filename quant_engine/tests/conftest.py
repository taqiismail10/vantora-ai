"""Apex Manufacturing Ltd -- the reference SME with a Day 14 liquidity crunch.

Two reliable invoices land early and cover the first fortnight of bills, so P10
cash holds above the $25,000 buffer until the day-14 payroll run blows through
it. The slow B2B receivables (Northwind, Harbor, Cascade) only arrive in week 4.
"""

from __future__ import annotations

import pytest

from quant_engine.schemas import (
    ApPayable,
    ArInvoice,
    FinancingOption,
    SmeFinancialStateInput,
)


def apex_manufacturing_state() -> SmeFinancialStateInput:
    return SmeFinancialStateInput(
        company_name="Apex Manufacturing Ltd",
        current_cash=48_000.0,
        minimum_safe_buffer=25_000.0,
        credit_score=672,
        monthly_revenue=310_000.0,
        max_relationship_risk=0.4,
        relationship_risk_price=2_000.0,
        invoices_ar=[
            ArInvoice(
                id="INV-1001",
                customer_name="Northwind Logistics",
                amount=62_000.0,
                due_day=8,
                expected_delay_days_mean=12.0,
                expected_delay_days_std=5.0,
                reliability_score=0.72,
                early_payment_discount_eligible=True,
                early_payment_discount_pct=0.02,
                early_payment_settles_in_days=3,
            ),
            ArInvoice(
                id="INV-1002",
                customer_name="Harbor Freight Co",
                amount=44_500.0,
                due_day=12,
                expected_delay_days_mean=9.0,
                expected_delay_days_std=4.0,
                reliability_score=0.85,
                early_payment_discount_eligible=True,
                early_payment_discount_pct=0.015,
                early_payment_settles_in_days=2,
            ),
            ArInvoice(
                id="INV-1003",
                customer_name="Cascade Industrial",
                amount=38_000.0,
                due_day=20,
                expected_delay_days_mean=6.0,
                expected_delay_days_std=3.0,
                reliability_score=0.90,
                early_payment_discount_eligible=True,
                early_payment_discount_pct=0.025,
                early_payment_settles_in_days=4,
            ),
            ArInvoice(
                id="INV-1004",
                customer_name="Sterling Parts",
                amount=25_500.0,
                due_day=2,
                expected_delay_days_mean=2.0,
                expected_delay_days_std=1.0,
                reliability_score=0.99,
            ),
            ArInvoice(
                id="INV-1005",
                customer_name="Veritas Mining",
                amount=15_000.0,
                due_day=26,
                expected_delay_days_mean=15.0,
                expected_delay_days_std=8.0,
                reliability_score=0.60,
                early_payment_discount_eligible=True,
                early_payment_discount_pct=0.03,
                early_payment_settles_in_days=5,
            ),
            ArInvoice(
                id="INV-1006",
                customer_name="Gateway Tooling",
                amount=36_000.0,
                due_day=3,
                expected_delay_days_mean=3.0,
                expected_delay_days_std=1.5,
                reliability_score=0.98,
            ),
        ],
        payables_ap=[
            ApPayable(
                id="AP-RENT",
                supplier_name="Dockside Industrial Park (rent)",
                amount=9_500.0,
                due_day=3,
                late_fee_pct=0.05,
            ),
            ApPayable(
                id="AP-UTILITIES",
                supplier_name="Metro Power & Water",
                amount=4_200.0,
                due_day=7,
                is_flexible=True,
                max_deferral_days=14,
                deferral_fee_pct=0.01,
                relationship_risk=0.10,
                late_fee_pct=0.04,
            ),
            ApPayable(
                id="AP-RAW-STEEL",
                supplier_name="Ironclad Steel Supply",
                amount=34_000.0,
                due_day=10,
                is_flexible=True,
                max_deferral_days=21,
                deferral_fee_pct=0.005,
                relationship_risk=0.25,
                late_fee_pct=0.08,
            ),
            ApPayable(
                id="AP-LOGISTICS",
                supplier_name="Redline Freight Partners",
                amount=16_800.0,
                due_day=12,
                is_flexible=True,
                max_deferral_days=30,
                deferral_fee_pct=0.0075,
                relationship_risk=0.15,
                late_fee_pct=0.06,
            ),
            ApPayable(
                id="AP-PAYROLL",
                supplier_name="Monthly factory payroll (100 staff)",
                amount=78_000.0,
                due_day=14,
                late_fee_pct=0.02,
                is_critical=True,
                is_payroll=True,
                default_penalty=18_000.0,
            ),
            ApPayable(
                id="AP-TAX",
                supplier_name="Quarterly VAT remittance",
                amount=21_000.0,
                due_day=22,
                late_fee_pct=0.10,
                is_critical=True,
                default_penalty=6_000.0,
            ),
        ],
        financing_options=[
            FinancingOption(
                id="FIN-MERIDIAN",
                provider="Meridian Capital",
                product_type="invoice_factoring",
                max_amount=80_000.0,
                apr=0.14,
                origination_fee_pct=0.02,
                min_credit_score=640,
                funding_days=4,
                requires_ar_collateral=True,
                ar_coverage_ratio=0.80,
            ),
            FinancingOption(
                id="FIN-GRANITE",
                provider="Granite Bank",
                product_type="bridge_loan",
                max_amount=60_000.0,
                apr=0.11,
                origination_fee_pct=0.015,
                min_credit_score=700,  # above Apex's 672 -> screened out
                funding_days=7,
            ),
            FinancingOption(
                id="FIN-QUICKFLOAT",
                provider="QuickFloat Advance",
                product_type="merchant_advance",
                max_amount=75_000.0,
                apr=0.46,
                origination_fee_pct=0.04,
                min_credit_score=550,
                funding_days=2,
            ),
            FinancingOption(
                id="FIN-SBA",
                provider="Heritage SBA Program",
                product_type="bridge_loan",
                max_amount=100_000.0,
                apr=0.08,
                origination_fee_pct=0.01,
                min_credit_score=600,
                funding_days=21,  # cheapest capital, arrives a week after payroll
            ),
        ],
    )


@pytest.fixture
def apex() -> SmeFinancialStateInput:
    return apex_manufacturing_state()
