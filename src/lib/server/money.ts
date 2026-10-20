/**
 * Money at the authorization boundary is integer cents, never a float.
 *
 * The engines compute in floating-point dollars; every figure that crosses
 * into an approval, a confirmation or an execution record is converted here
 * once and compared as an integer, so `$2,345` typed by a human and `2345.0`
 * from the solver are the same value and `$2,344.999` is not.
 */

export const CURRENCY = "USD" as const;

/**
 * The currencies a company may keep its books in. All three have two-decimal
 * minor units, so integer cents is exact for each and no conversion table is
 * needed. A company holds exactly one: amounts in different currencies are
 * never summed, and there is deliberately no implicit 1:1 fallback.
 */
export const SUPPORTED_CURRENCIES = {
  USD: { symbol: "$", locale: "en-US" },
  BDT: { symbol: "৳", locale: "en-BD" },
  CNY: { symbol: "¥", locale: "zh-CN" },
} as const;

export type CurrencyCode = keyof typeof SUPPORTED_CURRENCIES;

export const isCurrencyCode = (value: unknown): value is CurrencyCode =>
  typeof value === "string" && Object.hasOwn(SUPPORTED_CURRENCIES, value);

/** Largest amount any sandbox action may carry: 100,000,000.00 minor units. */
export const MAX_CENTS = 10_000_000_000;

export const toCents = (dollars: number): number => Math.round(dollars * 100);

export const fromCents = (cents: number): number => cents / 100;

export const formatCents = (cents: number, currency: CurrencyCode = CURRENCY): string => {
  const { symbol, locale } = SUPPORTED_CURRENCIES[currency];
  return `${cents < 0 ? "-" : ""}${symbol}${(Math.abs(cents) / 100).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const DECIMAL = /^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;

/**
 * Parse a human- or client-supplied money value strictly.
 *
 * Accepts `2345`, `2,345`, `2345.00`, `$2,345.00` and finite numbers with at
 * most two decimals. Rejects negatives, zero, NaN, Infinity, exponents, three
 * decimals, malformed grouping and anything above MAX_CENTS — with a reason.
 */
export function parseCents(
  value: unknown,
  currency: CurrencyCode = CURRENCY,
): { ok: true; cents: number } | { ok: false; reason: string } {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, reason: "amount must be a finite number" };
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim().replace(/^[$৳¥]\s?/, "");
  } else {
    return { ok: false, reason: "amount is required" };
  }
  if (text.startsWith("-")) return { ok: false, reason: "amount cannot be negative" };
  if (!DECIMAL.test(text)) return { ok: false, reason: `"${String(value).slice(0, 32)}" is not a valid ${currency} amount` };
  const [whole, fraction = ""] = text.replace(/,/g, "").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: "amount is out of range" };
  if (cents <= 0) return { ok: false, reason: "amount must be greater than zero" };
  if (cents > MAX_CENTS) return { ok: false, reason: "amount exceeds the sandbox ceiling" };
  return { ok: true, cents };
}

export function parseCurrency(value: unknown): { ok: true } | { ok: false; reason: string } {
  if (value === undefined || value === CURRENCY) return { ok: true };
  return { ok: false, reason: `only ${CURRENCY} is supported, not ${String(value).slice(0, 8)}` };
}
