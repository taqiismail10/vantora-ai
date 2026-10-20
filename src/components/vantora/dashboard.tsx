"use client";

/**
 * The dashboard shell.
 *
 * The first payload is rendered on the server and handed in as `initial`;
 * every button that changes the audit chain refetches `/api/state` through the
 * same builder, so there is no loading flash and no duplicated query logic.
 */

import { useCallback, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DashboardState, RedTeamResult } from "@/lib/dashboard-state";
import { BASELINE_STRESS, type StressControls } from "@/lib/stress-controls";
import { cn } from "@/lib/utils";

import { ActionCenter } from "./action-center";
import { AuditLedger } from "./audit-ledger";
import { fetchDashboardState, runRedTeamDrill, scenarioOf, SessionExpiredError } from "./client-api";
import { CoveragePanel } from "./coverage-panel";
import { LiquidityRadar } from "./liquidity-radar";
import { CurrencyProvider, DecisionBadge, SectionHeading, TierBadge } from "./primitives";
import { RecoveryOptimizer } from "./recovery-optimizer";
import { StatusBar } from "./status-bar";
import { ProgressRail, VerdictBar } from "./verdict-bar";

export function VantoraDashboard({ initial }: { initial: DashboardState }) {
  const [data, setData] = useState<DashboardState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [redTeam, setRedTeam] = useState<RedTeamResult | null>(null);
  const [redTeamBusy, setRedTeamBusy] = useState(false);
  const [tab, setTab] = useState("liquidity");
  // The preset and the four stress controls live here, not in the tabs: every
  // refresh has to carry them or an action would silently snap the dashboard
  // back to the baseline scenario on the next append to the chain.
  const [preset, setPreset] = useState(initial.profile.id);
  const [stress, setStress] = useState<StressControls>(initial.stress);
  const [expired, setExpired] = useState(false);
  const [openPlanApproval, setOpenPlanApproval] = useState(false);
  const clearPlanApproval = useCallback(() => setOpenPlanApproval(false), []);

  // No state is set before the first `await`, so the mount effect below does not
  // trigger a cascading render (react-hooks/set-state-in-effect).
  const refresh = useCallback(
    async (next: { profile?: string } & Partial<StressControls> = {}) => {
      try {
        setData(await fetchDashboardState({ profile: preset, ...stress, ...next }));
        setError(null);
      } catch (cause) {
        if (cause instanceof SessionExpiredError) setExpired(true);
        else setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [preset, stress],
  );

  const refreshWithSpinner = async (next: { profile?: string } & Partial<StressControls> = {}) => {
    setRefreshing(true);
    try {
      await refresh(next);
    } finally {
      setRefreshing(false);
    }
  };

  const switchPreset = async (next: DashboardState["profile"]["id"]) => {
    setPreset(next);
    setTab("liquidity"); // a new scenario's verdict belongs on the first tab
    // A preset is a scenario in its own right, so selecting one resets the
    // dials: otherwise "healthy runway" would quietly arrive pre-stressed.
    setStress(BASELINE_STRESS);
    await refreshWithSpinner({ profile: next, ...BASELINE_STRESS });
  };

  const applyStressControls = async (next: Partial<StressControls>) => {
    const merged = { ...stress, ...next };
    setStress(merged);
    await refreshWithSpinner(merged);
  };

  const drill = async () => {
    setRedTeamBusy(true);
    try {
      setRedTeam(await runRedTeamDrill(scenarioOf(data)));
      await refresh();
    } catch (cause) {
      if (cause instanceof SessionExpiredError) setExpired(true);
      else setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRedTeamBusy(false);
    }
  };

  return (
    // Every figure below is this company's, in this company's currency. The
    // binding is per subtree, so a second render for another company cannot
    // pick up this one's symbol.
    <CurrencyProvider currency={data.company.currency}>
    <div className="flex min-h-full flex-col bg-slate-50 dark:bg-slate-950">
      {expired ? (
        <div role="alert" className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Your session has expired, so nothing further can be read or approved.{" "}
          <a href="/login?reason=expired" className="font-medium underline">
            Sign in again
          </a>
          .
        </div>
      ) : null}
      {error ? (
        <div className="border-b border-rose-300 bg-rose-50 px-4 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          Last refresh failed: <span className="font-mono">{error}</span>
        </div>
      ) : null}
      <StatusBar
        data={data}
        onRedTeam={drill}
        redTeamBusy={redTeamBusy}
        refreshing={refreshing}
        onRefresh={() => refreshWithSpinner()}
        onSwitchPreset={switchPreset}
        onStress={applyStressControls}
      />

      {/* overflow-x-hidden is the page-level guarantee: any child that
          overflows scrolls inside itself rather than moving the whole page. */}
      <main className="mx-auto w-full max-w-[1600px] flex-1 overflow-x-hidden px-4 py-4">
        <div className="flex flex-col gap-4">
          <VerdictBar data={data} onReviewPlan={() => setTab("optimizer")} />
          <ProgressRail data={data} onNavigate={setTab} />
          <CoveragePanel coverage={data.coverage} />

          <Tabs value={tab} onValueChange={setTab}>
            {/* A 2x2 grid on phones so all four workspaces are visible at
                360px without a hidden horizontal scroll; one row from sm up. */}
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:flex sm:h-9 sm:justify-start">
              <TabsTrigger value="liquidity" className="shrink-0">
                Liquidity radar
              </TabsTrigger>
              <TabsTrigger value="optimizer" className="shrink-0">
                Recovery optimizer
              </TabsTrigger>
              <TabsTrigger value="copilot" className="shrink-0">
                Copilot action center
              </TabsTrigger>
              <TabsTrigger value="ledger" className="shrink-0">
                Security &amp; ledger
              </TabsTrigger>
            </TabsList>

            <TabsContent value="liquidity" className="pt-4">
              <LiquidityRadar data={data} />
            </TabsContent>
            <TabsContent value="optimizer" className="pt-4">
              <RecoveryOptimizer
                data={data}
                onApprove={() => {
                  setOpenPlanApproval(true);
                  setTab("copilot");
                }}
              />
            </TabsContent>
            <TabsContent value="copilot" className="pt-4">
              <ActionCenter
                data={data}
                onLedgerChanged={() => refresh()}
                openPlanApproval={openPlanApproval}
                onPlanApprovalHandled={clearPlanApproval}
              />
            </TabsContent>
            <TabsContent value="ledger" className="pt-4">
              <AuditLedger data={data} />
            </TabsContent>
          </Tabs>
        </div>
      </main>

      <footer className="border-t border-slate-200 px-4 py-3 text-[11px] leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <div className="mx-auto max-w-[1600px]">
          {data.company.is_demo ? (
            <>
              <strong className="font-medium">Synthetic sandbox.</strong> Smart Jeans Manufacturing Ltd. and its ledger
              are invented for this demonstration (dataset {data.scenario.dataset_version}, day 0 ={" "}
              {data.scenario.as_of_date}). Buyer, supplier, lender and insurer names are used illustratively; no
              affiliation with, or data from, any real company is implied. The canonical day-14 scenario was
              hand-designed to illustrate a payroll collision; behaviour is also exercised across three regimes and
              every stress-dial combination by the test suite. Nothing here moves real money or contacts a real
              counterparty.
            </>
          ) : (
            <>
              <strong className="font-medium">Your records, sandbox execution.</strong> Every figure above is computed
              from what you entered for {data.company.name} (data version {data.scenario.dataset_version}, day 0 ={" "}
              {data.scenario.as_of_date}), over a {30}-day window. Balances are as entered and are not reconciled
              against a bank statement. Approving and submitting an action records it here and moves the simulated
              position — nothing is sent to a real buyer, supplier or lender, and no money moves.
            </>
          )}
        </div>
      </footer>

      <Dialog open={redTeam !== null} onOpenChange={(open) => (open ? null : setRedTeam(null))}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              {redTeam?.summary.passed ? (
                <ShieldCheck className="size-4 text-emerald-700" />
              ) : (
                <ShieldAlert className="size-4 text-rose-600" />
              )}
              Red-team security drill
            </DialogTitle>
            <DialogDescription className="text-xs">
              {redTeam?.summary.attacks_blocked} of {redTeam?.summary.attacks_run} attacks blocked, control
              operation {redTeam?.summary.control_allowed ? "allowed" : "wrongly blocked"}. Every row below is a
              real gate decision appended to the audit chain just now.
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-auto">
            {[...(redTeam?.attacks ?? []), ...(redTeam?.control ? [redTeam.control] : [])].map((entry) => {
              const expected = entry.name.startsWith("Control") ? entry.result.ok : !entry.result.ok;
              return (
                <div
                  key={entry.name}
                  className={cn(
                    "rounded-lg border p-3",
                    expected
                      ? "border-emerald-200 dark:border-emerald-900"
                      : "border-rose-300 dark:border-rose-800",
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <SectionHeading title={entry.name} hint={entry.expectation} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <TierBadge tier={entry.result.tier} />
                    <DecisionBadge decision={entry.result.decision} />
                    <Badge variant="outline" className="font-mono text-[10px]">
                      seq #{entry.result.seq}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={cn(
                        "border-transparent font-mono text-[10px]",
                        expected
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                          : "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
                      )}
                    >
                      {expected ? "as expected" : "UNEXPECTED"}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
                    {entry.result.reason}
                  </p>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
    </CurrencyProvider>
  );
}
