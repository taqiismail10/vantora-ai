"use client";

/** The top status bar: which SME is loaded, what is serving the numbers, and is the ledger intact. */

import { Activity, Cpu, Download, Loader2, Shield, ShieldAlert, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DashboardState } from "@/lib/dashboard-state";
import type { StressControls } from "@/lib/stress-controls";
import { cn } from "@/lib/utils";

import { StressController } from "./stress-controller";

type PresetId = DashboardState["profile"]["id"];

/**
 * A broken chain is not one state.
 *
 * A truncated log (entries removed from the end) and a tampered one (a hash
 * that no longer recomputes) need different responses, so they must not share
 * a badge.
 */
function chainStatus(verification: DashboardState["audit"]["verification"]) {
  if (verification.valid) {
    return {
      label: `VERIFIED (${verification.length}/${verification.length})`,
      className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
      icon: <ShieldCheck className="size-3" />,
    };
  }
  const truncated = verification.reason === "sequence gap or reorder";
  return truncated
    ? {
        label: `TRUNCATED at seq ${verification.brokenAtSeq}`,
        className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
        icon: <ShieldAlert className="size-3" />,
      }
    : {
        label: `TAMPERED at seq ${verification.brokenAtSeq}`,
        className: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
        icon: <ShieldAlert className="size-3" />,
      };
}

export function StatusBar({
  data,
  onRedTeam,
  redTeamBusy,
  refreshing,
  onRefresh,
  onSwitchPreset,
  onStress,
}: {
  data: DashboardState;
  onRedTeam: () => void;
  redTeamBusy: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onSwitchPreset: (preset: PresetId) => void;
  onStress: (next: Partial<StressControls>) => void;
}) {
  const live = data.engine.optimization_source === "python-fastapi";
  const chain = chainStatus(data.audit.verification);

  const download = () => {
    const jsonl = data.audit.entries.map((entry) => JSON.stringify(entry)).join("\n");
    const url = URL.createObjectURL(new Blob([jsonl], { type: "application/x-ndjson" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "sandbox_operation_logs.jsonl";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            {data.company_name ?? "SME"}
          </h1>
          <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
            {data.profile.industry} · Vantora treasury &amp; liquidity copilot · plan {data.plan_id}
          </p>
        </div>

        <StressController
          data={data}
          busy={refreshing}
          onPreset={onSwitchPreset}
          onStress={onStress}
        />

        <Badge
          variant="outline"
          className={cn(
            "gap-1.5 border-transparent font-mono text-[10px]",
            live
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
              : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
          )}
        >
          <Cpu className="size-3" />
          {live ? "Python HiGHS MILP Engine: Connected" : "Deterministic TS Mirror: Active"}
        </Badge>

        <Badge variant="outline" className={cn("gap-1.5 border-transparent font-mono text-[10px]", chain.className)}>
          {chain.icon}
          SHA-256 Audit Chain: {chain.label}
        </Badge>

        <Badge variant="outline" className="gap-1.5 font-mono text-[10px]">
          <Activity className="size-3" />
          {data.copilot.anthropic_key_present ? data.copilot.model : "Deterministic copilot"}
        </Badge>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing} className="text-[11px]">
            {refreshing ? <Loader2 className="size-4 animate-spin" /> : null}
            Refresh
          </Button>
          {/* Outline, not destructive: running the drill is a safe, routine
              check. Alarm red is reserved for an actual shortfall or breach. */}
          <Button size="sm" variant="outline" onClick={onRedTeam} disabled={redTeamBusy} className="text-[11px]">
            {redTeamBusy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Shield className="size-4 text-slate-500 dark:text-slate-400" />
            )}
            Run red-team security drill
          </Button>
          <Button size="sm" variant="outline" onClick={download} className="text-[11px]">
            <Download className="size-4" />
            Download audit logs (.jsonl)
          </Button>
        </div>
      </div>
    </header>
  );
}
