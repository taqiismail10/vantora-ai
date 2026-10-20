import Link from "next/link";
import { ArrowRight, Calculator, FileCheckCorner, ShieldCheck } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

import { VantoraMark } from "./vantora-mark";

const HOW = [
  {
    icon: Calculator,
    title: "Forecast from your own records",
    body: "Enter your accounts, what you are owed and what you owe. A 1,000-path simulation projects your cash over the next 30 days and shows the day it runs short.",
  },
  {
    icon: FileCheckCorner,
    title: "Compare real options",
    body: "A mixed-integer solver prices every combination of collecting earlier, paying later and drawing on facilities you have entered, and shows the cash cost of each.",
  },
  {
    icon: ShieldCheck,
    title: "Approve before anything happens",
    body: "Nothing executes until a person types the amount back to confirm it. Every AI answer is labelled with what produced it and checked against the engine's own figures.",
  },
];

const LIMITS = [
  "A sandbox. No money moves, and nothing is sent to any real supplier, buyer or lender.",
  "One currency per company — US dollars, Bangladeshi taka or Chinese yuan. Amounts in different currencies are never mixed or converted.",
  "You type your data in. There is no bank connection, no statement import and no document scanning.",
  "The forecast window is 30 days. A 13-week view is not built yet.",
  "Balances are what you enter. Nothing is reconciled against a bank statement.",
  "No compliance claim is made for any country. Choosing a country sets formatting and defaults, nothing more.",
];

/**
 * The page canvas is fixed dark, so the quiet action style behind the
 * "Create an account" CTA is pinned here too: a white-alpha surface that
 * reads as a secondary button next to the lime primary, whatever the way
 * an OS theme would resolve the design tokens.
 */
const SECONDARY_ON_DARK = {
  background: "rgba(255,255,255,0.08)",
  color: "white",
  border: "1px solid rgba(255,255,255,0.12)",
};

export function Landing({ signupEnabled }: { signupEnabled: boolean }) {
  return (
    <main className="flex-1 bg-[#0a0a0a]">
      <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:py-16">
        <div className="flex items-center justify-between gap-2.5 border-b border-white/10 pb-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <VantoraMark />
            <p className="text-sm font-semibold tracking-tight text-white">Vantora AI</p>
          </div>
          {/* Signed-out navigation: both entry points must survive at 390px
              without crowding the logo, hence the compact size and the fixed
              secondary surface instead of a token-dependent one. */}
          <nav className="flex shrink-0 items-center gap-2">
            <Link href="/login" className={buttonVariants({ size: "sm" })} style={SECONDARY_ON_DARK}>
              Sign in
            </Link>
            {signupEnabled ? (
              <Link href="/signup" className={buttonVariants({ size: "sm" })}>
                Sign up
              </Link>
            ) : null}
          </nav>
        </div>

        <span className="mt-8 inline-flex items-center rounded-full border border-[#cdf632]/30 bg-[#cdf632]/10 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[#cdf632]">
          Sandbox build
        </span>

        <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Know the day you run short of cash — and what it costs to fix it.
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-white/60">
          Vantora is a treasury copilot for small and mid-sized businesses whose money is tied up in invoices. It
          forecasts your cash position from the records you enter, then prices the ways out — collect earlier, pay
          later, or borrow — so you can compare them before anything is agreed.
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link href="/login" className={buttonVariants({ size: "lg" })}>
            Sign in
            <ArrowRight className="size-4" aria-hidden />
          </Link>
          {signupEnabled ? (
            <Link href="/signup" className={buttonVariants({ size: "lg" })} style={SECONDARY_ON_DARK}>
              Create an account
            </Link>
          ) : null}
          <Link
            href="/login?reason=demo"
            className={buttonVariants({ variant: "ghost", size: "lg" })}
            style={{ color: "rgba(255,255,255,0.45)" }}
          >
            See the demonstration
          </Link>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-white/35">
          The demonstration uses Smart Jeans Ltd., a fictional garment manufacturer with invented figures. Its buyers,
          suppliers, lenders and insurers are illustrative and no real company&apos;s data appears in it. It is read-only;
          you cannot enter your own records into it.
        </p>

        <section aria-labelledby="how" className="mt-12">
          <h2 id="how" className="text-sm font-semibold tracking-tight text-white/70">
            How it works
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {HOW.map((step) => (
              <div
                key={step.title}
                className="rounded-xl border border-white/8 bg-white/[0.03] p-4"
              >
                <step.icon className="size-4 text-[#cdf632]/60" aria-hidden />
                <h3 className="mt-2 text-sm font-medium text-white">{step.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-white/45">{step.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="limits" className="mt-10">
          <h2 id="limits" className="text-sm font-semibold tracking-tight text-white/70">
            What it does not do
          </h2>
          <p className="mt-1 text-xs text-white/40">
            Read this before you decide whether it is useful to you.
          </p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {LIMITS.map((limit) => (
              <li
                key={limit}
                className="rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5 text-xs leading-relaxed text-white/45"
              >
                {limit}
              </li>
            ))}
          </ul>
        </section>

        <footer className="mt-12 border-t border-white/10 pt-5 text-[11px] leading-relaxed text-white/25">
          Vantora runs its calculations in a deterministic engine, not a language model. The copilot can explain and
          draft, but every figure it quotes is checked against the engine&apos;s output before you see it, and an answer
          that fails that check is withheld rather than shown.
        </footer>
      </div>
    </main>
  );
}
