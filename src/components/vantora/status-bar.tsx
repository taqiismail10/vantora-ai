"use client";

/** The top status bar: which SME is loaded, what is serving the numbers, and is the ledger intact. */

import { useState } from "react";
import { Activity, Cpu, Download, Loader2, LogOut, Shield, ShieldAlert, ShieldCheck, Table2, UserRound } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import type { DashboardState } from "@/lib/dashboard-state";
import type { StressControls } from "@/lib/stress-controls";
import { PROVIDER_LABEL } from "@/lib/agent/llm";
import { cn } from "@/lib/utils";

import { CompanySwitcher } from "./company-switcher";
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
  const [signingOut, setSigningOut] = useState(false);
  const canAnalyze = data.viewer.capabilities.includes("analyze");
  const expires = new Date(data.viewer.session_expires_at);

  const signOut = async () => {
    setSigningOut(true);
    await authClient.signOut();
    // Full navigation so nothing of this session survives in the client cache.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full reload on an identity change
    window.location.assign("/login?reason=signed_out");
  };

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
    <header className="relative z-20 border-b sm:sticky sm:top-0 border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            {data.company.name || data.company_name || "SME"}
          </h1>
          <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
            {data.profile.industry} · {data.company.is_demo ? "synthetic sandbox ledger" : data.seed.source} · plan{" "}
            {data.plan_id} · v{data.plan_version.slice(0, 8)}
          </p>
        </div>

        <CompanySwitcher activeId={data.company.id} activeName={data.company.name} isDemo={data.company.is_demo} />

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

        {/* Configuration, not a claim that the model answered: each copilot
            turn carries its own source badge. */}
        <Badge
          variant="outline"
          className="gap-1.5 font-mono text-[10px]"
          title={
            data.ai.configured
              ? `${PROVIDER_LABEL[data.ai.provider!]} (${data.ai.model}) is configured. Each answer is labelled with what actually produced it.`
              : `${data.ai.problem ?? "No AI provider is configured"}, so the copilot answers from the deterministic synthesiser.`
          }
        >
          <Activity className="size-3" aria-hidden />
          {data.ai.configured
            ? `AI: ${PROVIDER_LABEL[data.ai.provider!]} · ${data.ai.model} configured`
            : data.ai.provider
              ? `AI: deterministic only (${PROVIDER_LABEL[data.ai.provider]} not configured)`
              : "AI: configuration error"}
        </Badge>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {data.company.is_demo ? null : (
            <Link href="/records" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "text-[11px]")}>
              <Table2 className="size-4" aria-hidden />
              Records
            </Link>
          )}
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing} className="text-[11px]">
            {refreshing ? <Loader2 className="size-4 animate-spin" /> : null}
            Refresh
          </Button>
          {/* Outline, not destructive: running the drill is a safe, routine
              check. Alarm red is reserved for an actual shortfall or breach. */}
          <Button
            size="sm"
            variant="outline"
            onClick={onRedTeam}
            disabled={redTeamBusy || !canAnalyze}
            title={canAnalyze ? undefined : "Viewers have read-only access; the drill writes to the audit chain."}
            className="text-[11px]"
          >
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
          <div className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 dark:border-slate-800">
            <UserRound className="size-3.5 text-slate-500" aria-hidden />
            <span className="max-w-[12rem] truncate text-[11px]" title={data.viewer.email}>
              {data.viewer.name}
            </span>
            <Badge variant="outline" className="font-mono text-[10px]">
              {data.viewer.role}
            </Badge>
            <span className="hidden text-[10px] text-slate-500 sm:inline dark:text-slate-400">
              session until {expires.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
            </span>
            <Button size="sm" variant="ghost" onClick={signOut} disabled={signingOut} className="h-6 px-1.5 text-[11px]">
              {signingOut ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <LogOut className="size-3.5" aria-hidden />}
              Sign out
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
