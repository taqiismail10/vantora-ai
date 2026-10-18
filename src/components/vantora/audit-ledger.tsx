"use client";

/** Tab 4 — the verifiable execution ledger: logs/sandbox_operation_logs.jsonl, live. */

import { useMemo, useState } from "react";
import { Link2, Loader2, ShieldCheck, ShieldX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AuditLogEntry, ChainVerification } from "@/lib/sandbox/execution-logger";
import type { DashboardState } from "@/lib/dashboard-state";
import { cn } from "@/lib/utils";

import { verifyAuditChain } from "./client-api";
import { DecisionBadge, SectionHeading, TierBadge } from "./primitives";

const FILTERS = ["ALL", "ALLOWED", "DRAFTED", "DENIED"] as const;

export function AuditLedger({ data }: { data: DashboardState }) {
  const [entries, setEntries] = useState<AuditLogEntry[]>(data.audit.entries);
  const [verification, setVerification] = useState<ChainVerification>(data.audit.verification);
  const [verifying, setVerifying] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [expanded, setExpanded] = useState<number | null>(null);

  // The incoming props win whenever the parent refetches after an action.
  const shown = useMemo(() => {
    const source = data.audit.entries.length >= entries.length ? data.audit.entries : entries;
    return filter === "ALL" ? source : source.filter((entry) => entry.decision === filter);
  }, [data.audit.entries, entries, filter]);

  const counts = useMemo(() => {
    const source = data.audit.entries.length >= entries.length ? data.audit.entries : entries;
    return {
      total: source.length,
      allowed: source.filter((e) => e.decision === "ALLOWED").length,
      drafted: source.filter((e) => e.decision === "DRAFTED").length,
      denied: source.filter((e) => e.decision === "DENIED").length,
    };
  }, [data.audit.entries, entries]);

  const verify = async () => {
    setVerifying(true);
    try {
      const result = await verifyAuditChain();
      setEntries(result.entries);
      setVerification(result.verification);
    } finally {
      setVerifying(false);
    }
  };

  const download = () => {
    const jsonl = shown.map((entry) => JSON.stringify(entry)).join("\n");
    const url = URL.createObjectURL(new Blob([jsonl], { type: "application/x-ndjson" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "sandbox_operation_logs.jsonl";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="border-slate-200 dark:border-slate-800">
      <CardHeader>
        <SectionHeading
          title="Verifiable execution ledger"
          hint="logs/sandbox_operation_logs.jsonl · SHA-256 hash chain"
        />
        <CardDescription className="text-xs">
          Each entry commits to its predecessor: currentLogHash = SHA-256(seq │ timestamp │ actor │ operation │
          tier │ decision │ reason │ payloadDigest │ prevLogHash). Editing, deleting or reordering any row breaks
          every hash after it. Payloads are stored only as digests, so no figure or account number is ever written
          to the log.
        </CardDescription>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" onClick={verify} disabled={verifying} className="text-[11px]">
            {verifying ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            Verify SHA-256 chain integrity
          </Button>
          <Button size="sm" variant="outline" onClick={download} className="text-[11px]">
            Download .jsonl
          </Button>
          <Badge
            variant="outline"
            className={cn(
              "border-transparent font-mono text-[10px]",
              verification.valid
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                : "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
            )}
          >
            {verification.valid ? (
              <>
                VERIFIED ({verification.length}/{verification.length})
              </>
            ) : (
              <>
                BROKEN at seq {verification.brokenAtSeq} — {verification.reason}
              </>
            )}
          </Badge>
          <span className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
            {counts.total} entries · {counts.allowed} allowed · {counts.drafted} drafted · {counts.denied} denied
          </span>
          <div className="ml-auto flex gap-1">
            {FILTERS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={filter === option ? "secondary" : "ghost"}
                onClick={() => setFilter(option)}
                className="h-6 font-mono text-[10px]"
              >
                {option}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">seq</TableHead>
              <TableHead className="w-44">timestamp</TableHead>
              <TableHead>operation</TableHead>
              <TableHead>tier</TableHead>
              <TableHead>decision</TableHead>
              <TableHead>reason</TableHead>
              <TableHead className="w-28">chain</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((entry) => (
              <TableRow
                key={entry.currentLogHash}
                onClick={() => setExpanded(expanded === entry.seq ? null : entry.seq)}
                className={cn(
                  "cursor-pointer",
                  entry.decision === "DENIED" && "bg-rose-50/50 dark:bg-rose-950/20",
                  entry.tier === "TIER_3_PROHIBITED" && "bg-rose-100/70 dark:bg-rose-950/40",
                )}
              >
                <TableCell className="font-mono tabular-nums text-slate-400">{entry.seq}</TableCell>
                <TableCell className="font-mono text-[10px] tabular-nums text-slate-500 dark:text-slate-400">
                  {entry.timestamp.replace("T", " ").replace("Z", "")}
                </TableCell>
                <TableCell className="font-medium">
                  <div className="whitespace-nowrap">{entry.operation}</div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">
                    {entry.actorType}:{entry.actorId}
                  </div>
                </TableCell>
                <TableCell>
                  <TierBadge tier={entry.tier} />
                </TableCell>
                <TableCell>
                  <DecisionBadge decision={entry.decision} />
                </TableCell>
                <TableCell className="max-w-[28rem] text-slate-600 dark:text-slate-400">
                  <span className={cn(expanded === entry.seq ? "" : "line-clamp-2")}>{entry.reason}</span>
                  {expanded === entry.seq ? (
                    <div className="mt-2 flex flex-col gap-0.5 font-mono text-[10px] text-slate-500 dark:text-slate-500">
                      <span>payloadDigest {entry.payloadDigest}</span>
                      <span className="flex items-center gap-1">
                        prev {entry.prevLogHash} <Link2 className="size-3" />
                      </span>
                      <span>curr {entry.currentLogHash}</span>
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-[10px] text-slate-400">
                  {entry.prevLogHash === "0".repeat(64) ? (
                    <span className="text-emerald-600 dark:text-emerald-400">genesis</span>
                  ) : (
                    <>…{entry.prevLogHash.slice(-6)}</>
                  )}
                  <div>→ …{entry.currentLogHash.slice(-6)}</div>
                </TableCell>
              </TableRow>
            ))}
            {shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-slate-500 dark:text-slate-400">
                  No entries for this filter yet.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
        {!verification.valid ? (
          <div className="m-4 flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            <ShieldX className="mt-0.5 size-4 shrink-0" />
            <span>
              The chain does not verify: {verification.reason} at seq {verification.brokenAtSeq}. Every entry from
              that point on is untrustworthy.
            </span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
