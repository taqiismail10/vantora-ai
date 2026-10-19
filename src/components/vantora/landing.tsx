/**
 * The public entry page.
 *
 * Every claim here is one the product can actually meet today, and the limits
 * section is not a disclaimer at the bottom — it is the second thing a visitor
 * reads. A landing page that oversells is the cheapest way to make the rest of
 * the product dishonest.
 */

import Link from "next/link";
import { ArrowRight, Calculator, FileCheck2, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

const HOW = [
  {
    icon: Calculator,
    title: "Forecast from your own records",
    body: "Enter your accounts, what you are owed and what you owe. A 1,000-path simulation projects your cash over the next 30 days and shows the day it runs short.",
  },
  {
    icon: FileCheck2,
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

export function Landing({ signupEnabled }: { signupEnabled: boolean }) {
  return (
    <main className="flex-1 bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:py-16">
        <Badge variant="outline" className="font-mono text-[10px]">
          Sandbox build
        </Badge>
        <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl dark:text-slate-50">
          Know the day you run short of cash — and what it costs to fix it.
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-slate-300">
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
            <Link href="/signup" className={buttonVariants({ variant: "outline", size: "lg" })}>
              Create an account
            </Link>
          ) : null}
          <Link href="/login?reason=demo" className={buttonVariants({ variant: "ghost", size: "lg" })}>
            See the demonstration
          </Link>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          The demonstration uses Smart Jeans Ltd., a fictional garment manufacturer with invented figures. Its buyers,
          suppliers, lenders and insurers are illustrative and no real company&apos;s data appears in it. It is read-only;
          you cannot enter your own records into it.
        </p>

        <section aria-labelledby="how" className="mt-12">
          <h2 id="how" className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            How it works
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {HOW.map((step) => (
              <div
                key={step.title}
                className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950"
              >
                <step.icon className="size-4 text-slate-500 dark:text-slate-400" aria-hidden />
                <h3 className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">{step.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400">{step.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="limits" className="mt-10">
          <h2 id="limits" className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            What it does not do
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Read this before you decide whether it is useful to you.
          </p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {LIMITS.map((limit) => (
              <li
                key={limit}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs leading-relaxed text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400"
              >
                {limit}
              </li>
            ))}
          </ul>
        </section>

        <footer className="mt-12 border-t border-slate-200 pt-5 text-[11px] leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
          Vantora runs its calculations in a deterministic engine, not a language model. The copilot can explain and
          draft, but every figure it quotes is checked against the engine&apos;s output before you see it, and an answer
          that fails that check is withheld rather than shown.
        </footer>
      </div>
    </main>
  );
}
