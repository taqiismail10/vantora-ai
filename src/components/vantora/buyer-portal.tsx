"use client";

/**
 * Tab B of the Tier 1 draft modal — what the *buyer* sees.
 *
 * An early-payment offer is a sell, and the counterparty it has to clear is
 * Zara's treasury desk, not Smart Jeans' CFO. That desk does not care that a
 * denim plant has a payroll run on day 14; it cares whether parking cash in a
 * supplier invoice beats its own commercial-paper book. So the portal is
 * priced from Zara's side of the table, and the supplier-side verdict is shown
 * underneath rather than instead.
 *
 * Nothing here rides the quant wire. A purchase-order reference and a set of
 * bank coordinates are buyer-portal artefacts; `quant_engine/schemas.py` has no
 * business carrying them into a MILP, and a security review would ask why a
 * solver request contained an account number.
 */

import { useEffect, useState } from "react";
import { CircleCheck, Fingerprint, Lock, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ArInvoiceInput } from "@/lib/quant-client";
import { scheduledArrival } from "@/lib/recovery-scenarios";
import { cn } from "@/lib/utils";

import { money, pct } from "./primitives";

/** Settlement figures are quoted to the cent, round number or not. */
const exact = (value: number) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The buyer's own reference for this shipment, and where the money goes. */
const PORTAL_RECORD = {
  purchaseOrder: "PO #44817",
  vendorNumber: "SJM-0417",
  goodsReceipt: "GR 44817-A · 3 lines · no quantity or price variance",
  /**
   * The digest is taken over the *full* coordinates; the UI only ever renders
   * the mask. That split is the control: the buyer compares the digest against
   * the one their vendor master holds, out of band, so swapping the account
   * number for a fraudster's changes the fingerprint even though the masked
   * display would look identical.
   */
  remitTo: {
    beneficiary: "Smart Jeans Manufacturing Ltd.",
    bank: "Dockside Commercial Bank, N.A.",
    account: "0041884417",
    routing: "121140288",
  },
  accountMask: "••••4417",
};

/** Zara's internal cost of carry — the return the offer has to beat. */
const HURDLE_RATE = 0.052;

/** Negotiable settlement dates. The discount is contractual and does not move. */
const SETTLEMENT_STOPS = [2, 10, 15];

export interface SettlementQuote {
  settleDay: number;
  /** What Zara wires. */
  settlement: number;
  /** What Zara keeps. */
  captured: number;
  /** When this buyer would otherwise have paid, per the forecaster's own model. */
  arrival: number;
  accelerated: number;
  yieldPa: number;
  spreadBps: number;
}

/**
 * Price the offer from the buyer's side.
 *
 * Zara's annualised return is the discount as a yield on the cash actually
 * outlaid, over the days it is out of pocket ahead of when it would otherwise
 * have paid — so the denominator is the forecaster's expected arrival day, not
 * the invoice due date. A buyer who was going to pay 12 days late is being
 * asked to fund 12 extra days, and that is what it gets paid for.
 *
 * It rises as the settlement date slides later: the same 1.5% earned over
 * fewer days annualises higher. That is not a glitch, it is the tension the
 * slider exists to show.
 */
export function settlementQuote(invoice: ArInvoiceInput, settleDay: number): SettlementQuote {
  const discountPct = invoice.early_payment_discount_pct ?? 0;
  const captured = invoice.amount * discountPct;
  const arrival = scheduledArrival(invoice);
  const accelerated = arrival - settleDay;
  // A settlement date at or past the expected arrival accelerates nothing, so
  // there is no holding period to annualise over and no yield to quote.
  const yieldPa = accelerated > 0 ? (discountPct / (1 - discountPct)) * (365 / accelerated) : 0;
  return {
    settleDay,
    settlement: invoice.amount - captured,
    captured,
    arrival,
    accelerated,
    yieldPa,
    spreadBps: Math.round((yieldPa - HURDLE_RATE) * 10_000),
  };
}

async function fingerprint(record: object): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function PortalRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "good" | "warn";
}) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-x-3 border-t border-slate-100 py-1.5 first:border-t-0 dark:border-slate-800">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <span
        className={cn(
          "text-xs tabular-nums",
          tone === "good" && "font-medium text-emerald-600 dark:text-emerald-400",
          tone === "warn" && "font-medium text-amber-700 dark:text-amber-400",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function BuyerPortalPreview({
  invoice,
  crunchDay,
  payrollLockDay,
}: {
  invoice: ArInvoiceInput;
  crunchDay: number;
  /** Bank file cutoff. Cash arriving after it cannot fund the run it was raised for. */
  payrollLockDay: number | null;
}) {
  const [stop, setStop] = useState(0);
  const [digest, setDigest] = useState<string | null>(null);

  useEffect(() => {
    // Non-secure contexts have no SubtleCrypto; show the mask alone rather
    // than inventing a hash nobody could reproduce.
    fingerprint(PORTAL_RECORD.remitTo)
      .then(setDigest)
      .catch(() => setDigest(null));
  }, []);

  const discountPct = invoice.early_payment_discount_pct ?? 0;
  const { settleDay, settlement, captured, arrival, accelerated, yieldPa, spreadBps } = settlementQuote(
    invoice,
    SETTLEMENT_STOPS[stop],
  );
  // The deadline is the bank file cutoff, not the payroll date: money landing
  // on day 12 is money the day-11 file never saw.
  const deadline = payrollLockDay ?? crunchDay;
  const fundsTheRun = settleDay <= deadline;
  const shortDigest = digest ? `sha256:${digest.slice(0, 6)}…` : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-950">
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/60">
          <div>
            <p className="text-xs font-semibold tracking-tight">Zara International — Corporate Treasury</p>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              Supplier Early Settlement · magic-link session · vendor {PORTAL_RECORD.vendorNumber}
            </p>
          </div>
          <Badge variant="outline" className="shrink-0 text-[10px]">
            read-only preview
          </Badge>
        </div>

        <div className="px-3 py-1">
          <PortalRow label="Invoice" value={`${invoice.id} · ${PORTAL_RECORD.purchaseOrder}`} />
          <PortalRow label="Face value" value={exact(invoice.amount)} />
          <PortalRow
            label="3-way match"
            value={
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <CircleCheck className="size-3.5 shrink-0" aria-hidden />
                VERIFIED CLEAN — {PORTAL_RECORD.goodsReceipt}
              </span>
            }
            tone="good"
          />
          <PortalRow
            label="Remit-to"
            value={
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <Fingerprint className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden />
                <span className="font-mono text-[11px]">{shortDigest ?? "sha256 unavailable"}</span>
                <span className="text-slate-500 dark:text-slate-400">
                  acct {PORTAL_RECORD.accountMask} · BEC protected
                </span>
              </span>
            }
          />
        </div>
      </div>

      <fieldset className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <legend className="px-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Early settlement
        </legend>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">
            Settle in <span className="tabular-nums">{settleDay}</span> days
            <span className="ml-1.5 font-normal text-slate-500 dark:text-slate-400">
              · discount held at {pct(discountPct)} of face
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={SETTLEMENT_STOPS.length - 1}
            step={1}
            value={stop}
            onChange={(event) => setStop(Number(event.target.value))}
            aria-label="Settlement date"
            aria-valuetext={`Settle in ${settleDay} days`}
            className="w-full accent-sky-600 dark:accent-sky-400"
          />
          <span className="flex justify-between text-[10px] tabular-nums text-slate-500 dark:text-slate-400">
            {SETTLEMENT_STOPS.map((days) => (
              <span key={days}>{days}d</span>
            ))}
          </span>
        </label>

        <div className="mt-2">
          <PortalRow label="Settlement amount" value={exact(settlement)} />
          <PortalRow label="Discount captured" value={`${exact(captured)} · ${pct(discountPct)} of face`} tone="good" />
          <PortalRow
            label="Implied yield"
            value={`${pct(yieldPa)} p.a. · ${accelerated} days early vs. expected day ${arrival}`}
          />
          <PortalRow label="Zara CP hurdle" value={`${pct(HURDLE_RATE, 2)} commercial paper`} />
          <PortalRow
            label="Net arbitrage"
            value={`${spreadBps >= 0 ? "+" : ""}${spreadBps.toLocaleString("en-US")} bps`}
            tone={spreadBps >= 0 ? "good" : "warn"}
          />
        </div>
      </fieldset>

      {/* The seller's side of the same slider. Zara's return improves the later
          it settles, because the same 1.5% over fewer days annualises higher —
          which is exactly why the offer has to be anchored at the near stop. */}
      <p
        className={cn(
          "flex items-start gap-2 rounded-md border p-2.5 text-[11px] leading-relaxed",
          fundsTheRun
            ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200"
            : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200",
        )}
      >
        {fundsTheRun ? (
          <CircleCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        ) : (
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
        )}
        <span>
          <strong className="font-semibold">Seller side:</strong>{" "}
          {fundsTheRun
            ? `day ${settleDay} clears the day-${deadline} bank file cutoff, so the ${money(
                settlement,
              )} is in the account before the day-${crunchDay} payroll run.`
            : `day ${settleDay} misses the day-${deadline} bank file cutoff. Zara earns more at this stop and the day-${crunchDay} gap stays open — the offer is only worth making at the near stop.`}
        </span>
      </p>

      <div className="flex flex-col gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5 dark:border-slate-800 dark:bg-slate-900/60">
        <Button size="sm" disabled aria-disabled className="w-fit text-[11px]">
          <Lock className="size-4" aria-hidden />
          Confirm Early Settlement — {exact(settlement)}
        </Button>
        <p className="font-mono text-[10px] leading-relaxed break-all text-slate-500 dark:text-slate-400">
          POST /settle · HMAC bound to ({invoice.id}, {settlement.toFixed(2)}, day {settleDay},{" "}
          {shortDigest ?? "remit-to digest"}) · CSRF double-submit · single use.
        </p>
        <p className="text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
          Inert in this preview. Changing the amount, the date or the remit-to account changes the digest the
          token commits to, so a tampered link fails closed instead of paying the wrong party.
        </p>
      </div>
    </div>
  );
}
