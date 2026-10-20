/**
 * Company-scoped money presentation and the typed-confirmation rule.
 *
 * Two things are proved here. First, that formatters are independent values
 * rather than shared state, so one company's currency cannot leak into
 * another's figures. Second, that whatever a company's locale renders is
 * something a person can actually type back — the approval gate refuses
 * non-ASCII digits, so a locale that emits them would make approval
 * impossible. That coupling is easy to break by changing one table entry, so
 * it is asserted rather than assumed.
 */

import { describe, expect, it } from "vitest";

import {
  CURRENCY_DISPLAY,
  confirmationMatches,
  confirmationTarget,
  displayFor,
  formatMinor,
  makeMoney,
} from "../../components/vantora/currency";

const CODES = Object.keys(CURRENCY_DISPLAY);

describe("currency presentation", () => {
  it("gives each supported currency its own symbol", () => {
    expect(makeMoney("USD").money(1234)).toBe("$1,234");
    expect(makeMoney("BDT").money(1234)).toBe("৳1,234");
    expect(makeMoney("CNY").money(1234)).toBe("¥1,234");
  });

  it("formats minor units to the cent", () => {
    expect(formatMinor(123456, "USD")).toBe("$1,234.56");
    expect(formatMinor(123456, "BDT")).toBe("৳1,234.56");
    expect(formatMinor(123456, "CNY")).toBe("¥1,234.56");
  });

  it("keeps the sign outside the symbol", () => {
    expect(makeMoney("USD").money2(-12.5)).toBe("-$12.5");
    expect(formatMinor(-1250, "CNY")).toBe("-¥12.50");
  });

  it("distinguishes the two rounding contracts the dashboard relies on", () => {
    // money2 shows up to two decimals and drops a trailing zero; formatMinor
    // always shows both, because an entry screen quotes an exact amount.
    expect(makeMoney("USD").money2(12.5)).toBe("$12.5");
    expect(makeMoney("USD").money2(12)).toBe("$12");
    expect(formatMinor(1250, "USD")).toBe("$12.50");
    expect(formatMinor(1200, "USD")).toBe("$12.00");
  });

  it("falls back to USD for an unknown code rather than rendering a bare number", () => {
    expect(displayFor("XYZ")).toEqual(CURRENCY_DISPLAY.USD);
    expect(makeMoney("XYZ").money(10)).toBe("$10");
  });
});

describe("formatters are per-company values, not shared state", () => {
  it("does not let one company's formatter change another's", () => {
    const usd = makeMoney("USD");
    const bdt = makeMoney("BDT");
    const cny = makeMoney("CNY");
    // Interleave the calls: with shared mutable state, whichever ran last
    // would win and these would not all hold at once.
    expect(usd.money(1000)).toBe("$1,000");
    expect(bdt.money(1000)).toBe("৳1,000");
    expect(usd.money(1000)).toBe("$1,000");
    expect(cny.money(1000)).toBe("¥1,000");
    expect(bdt.money(1000)).toBe("৳1,000");
    expect(usd.money(1000)).toBe("$1,000");
  });

  it("carries its own code, so a caller can rebuild the same formatting", () => {
    expect(makeMoney("BDT").code).toBe("BDT");
    expect(makeMoney("CNY").symbol).toBe("¥");
  });
});

describe("the figure shown for confirmation can actually be typed back", () => {
  // The approval gate refuses non-ASCII digits on purpose. A locale that
  // renders them (bn-BD gives ১২,৩৪,৫৬৭.৫০) would show an amount nobody could
  // confirm, so no supported currency may use one.
  it.each(CODES)("%s renders only ASCII digits and known separators", (code) => {
    const target = confirmationTarget(123456789, code);
    expect(target).toMatch(/^[\d,.   ]+$/u);
  });

  it.each(CODES)("%s round-trips: what is displayed is accepted", (code) => {
    for (const cents of [1_00, 123_45, 1_234_567_89]) {
      expect(confirmationMatches(confirmationTarget(cents, code), cents)).toBe(true);
    }
  });
});

describe("typed confirmation", () => {
  const expected = 234_500; // 2,345.00

  it("accepts the amount however it was grouped", () => {
    for (const typed of ["2345", "2345.00", "2,345", "2,345.00", " 2,345.00 ", "$2,345.00", "৳2,345", "¥2345"]) {
      expect(confirmationMatches(typed, expected)).toBe(true);
    }
  });

  it("accepts non-breaking separators, which some locales emit", () => {
    expect(confirmationMatches("2 345.00", expected)).toBe(true);
    expect(confirmationMatches("2 345.00", expected)).toBe(true);
  });

  it("refuses a different amount, including one cent out", () => {
    for (const typed of ["2344.99", "2345.01", "234500", "23.45", "0", ""]) {
      expect(confirmationMatches(typed, expected)).toBe(false);
    }
  });

  it("refuses more precision than the figure carries", () => {
    expect(confirmationMatches("2345.000", expected)).toBe(false);
  });

  it("refuses non-ASCII digits rather than guessing what they meant", () => {
    // Bengali, Arabic-Indic and fullwidth forms of 2345.
    for (const typed of ["২৩৪৫", "٢٣٤٥", "２３４５"]) {
      expect(confirmationMatches(typed, expected)).toBe(false);
    }
  });

  it("refuses anything that is not a plain decimal", () => {
    for (const typed of ["2345e0", "2.345,00", "-2345", "+2345", "2345 USD", "two thousand", "0x929", "NaN", "Infinity"]) {
      expect(confirmationMatches(typed, expected)).toBe(false);
    }
  });

  it("refuses a value that only matches after a separator strip changes its meaning", () => {
    // "2.345" is two thousand three hundred and forty-five in a comma-decimal
    // locale, but here it is two point three four five — and it is refused
    // rather than silently reinterpreted.
    expect(confirmationMatches("2.345", expected)).toBe(false);
  });
});
