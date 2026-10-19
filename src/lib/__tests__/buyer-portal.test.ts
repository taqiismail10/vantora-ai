import { describe, expect, it } from "vitest";

import { settlementQuote } from "@/components/vantora/buyer-portal";
import { SMART_JEANS_INVOICES_AR } from "@/lib/sandbox/seed-data";

const zara = SMART_JEANS_INVOICES_AR.find((i) => i.id === "INV-2002")!;

describe("buyer-portal settlement quote", () => {
  it("keeps the canonical $645 discount and $42,355 settlement on the $43,000 face", () => {
    const quote = settlementQuote(zara, 2);
    expect(quote.captured).toBeCloseTo(645, 2);
    expect(quote.settlement).toBeCloseTo(42_355, 2);
    // The discount is contractual: sliding the date does not move it.
    expect(settlementQuote(zara, 15).captured).toBeCloseTo(645, 2);
  });

  it("annualises over the forecaster's expected arrival day, not the due day", () => {
    const quote = settlementQuote(zara, 2);
    // ceil(11 + 10 * (2 - 0.8)) = 23 — the same reliability stretch the
    // forecaster and the echo check use.
    expect(quote.arrival).toBe(23);
    expect(quote.accelerated).toBe(21);
    expect(quote.yieldPa).toBeCloseTo((0.015 / 0.985) * (365 / 21), 6);
    expect(quote.spreadBps).toBe(2127);
  });

  it("rises as the settlement date slides later, because fewer days annualise higher", () => {
    const stops = [2, 10, 15].map((day) => settlementQuote(zara, day));
    expect(stops.map((q) => q.yieldPa)).toEqual([...stops.map((q) => q.yieldPa)].sort((a, b) => a - b));
    expect(stops.every((q) => q.spreadBps > 0)).toBe(true);
  });

  it("quotes no yield when the settlement date accelerates nothing", () => {
    const quote = settlementQuote(zara, 23);
    expect(quote.accelerated).toBe(0);
    expect(quote.yieldPa).toBe(0);
    // Still below Zara's own cost of carry, so the arbitrage is negative.
    expect(quote.spreadBps).toBe(-520);
  });

  it("quotes nothing on an invoice carrying no discount terms", () => {
    const quote = settlementQuote({ ...zara, early_payment_discount_pct: undefined }, 2);
    expect(quote.captured).toBe(0);
    expect(quote.settlement).toBe(zara.amount);
    expect(quote.yieldPa).toBe(0);
  });
});
