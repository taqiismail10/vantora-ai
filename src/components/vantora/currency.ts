/**
 * Currency presentation and the typed-confirmation rule.
 *
 * Kept free of React so both the dashboard's context-bound formatter and the
 * entry screens' explicit one are built from the same table, and so the rules
 * that matter — what a figure looks like, and what counts as typing it back —
 * can be tested directly rather than through a rendered component.
 */

export const CURRENCY_DISPLAY: Record<string, { symbol: string; locale: string }> = {
  USD: { symbol: "$", locale: "en-US" },
  BDT: { symbol: "৳", locale: "en-BD" },
  CNY: { symbol: "¥", locale: "zh-CN" },
};

export const displayFor = (code: string) => CURRENCY_DISPLAY[code] ?? CURRENCY_DISPLAY.USD;

/** Whole-unit amounts, as the dashboard shows them. */
export function makeMoney(code: string) {
  const { symbol, locale } = displayFor(code);
  const money = (value: number, maxFractionDigits = 0) =>
    `${value < 0 ? "-" : ""}${symbol}${Math.abs(value).toLocaleString(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxFractionDigits,
    })}`;
  return { money, money2: (value: number) => money(value, 2), symbol, locale, code };
}

/** Minor units, for the entry screens, which know their company's currency. */
export const formatMinor = (cents: number, code: string) => {
  const { symbol, locale } = displayFor(code);
  return `${cents < 0 ? "-" : ""}${symbol}${(Math.abs(cents) / 100).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

/** The figure a person must type back, grouped as their own figures are. */
export const confirmationTarget = (expectedCents: number, code: string) =>
  (expectedCents / 100).toLocaleString(displayFor(code).locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * Separators a real locale can emit — ASCII space, NO-BREAK SPACE, NARROW
 * NO-BREAK SPACE, comma — plus the supported symbols.
 *
 * Stripping is not the validation. What makes the check below safe is the
 * ASCII-digit pattern and the integer comparison: anything this does not
 * recognise survives, fails the pattern and is refused.
 */
const SEPARATORS = /[,   $৳¥]/gu;

const PLAIN_DECIMAL = /^\d+(\.\d{1,2})?$/;

/**
 * Does `typed` mean exactly `expectedCents`?
 *
 * Compared as integers, so "2,345", "2345" and "2345.00" all match 234500 and
 * "2345.001" does not. Non-ASCII digits (Arabic-Indic, Bengali, fullwidth) are
 * deliberately refused rather than mapped to values: a confirmation has to be
 * the figure the person actually typed, not one inferred on their behalf.
 */
export function confirmationMatches(typed: string, expectedCents: number): boolean {
  const normalised = typed.replace(SEPARATORS, "");
  if (!PLAIN_DECIMAL.test(normalised)) return false;
  return Math.round(Number(normalised) * 100) === expectedCents;
}
