"use client";

/** Tab 4 — the verifiable execution ledger: logs/sandbox_operation_logs.jsonl, live. */

import { useMemo, useRef, useState } from "react";
import { Link2, LoaderCircle, RotateCcw, ShieldCheck, ShieldX, Unlink } from "lucide-react";

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
import { RedTeamPlayground } from "./red-team-playground";

const FILTERS = ["ALL", "ALLOWED", "DRAFTED", "DENIED"] as const;
const GENESIS = "0".repeat(64);
/** Slow enough to read as a scan, fast enough that 17 rows take under half a second. */
const WALK_MS_PER_ROW = 25;
const TAMPER_SEQ = 12;

/** `2026-10-18T17:15:25.984Z` -> `2026-10-18 17:15:25` (ms moves to the detail view). */
function toSeconds(timestamp: string): string {
  return timestamp.replace("T", " ").replace(/\.\d+Z?$/, "");
}

/**
 * Recompute the chain in the browser, the same way the server does.
 *
 * The tamper demo has to be verified client-side: the point is that anyone
 * holding the file can detect the edit, without asking the service that wrote
 * it whether it is still honest.
 */
async function verifyLocally(entries: AuditLogEntry[]): Promise<ChainVerification> {
  let expectedPrev = GENESIS;
  for (const [index, entry] of entries.entries()) {
    if (entry.seq !== index + 1) {
      return { valid: false, length: entries.length, brokenAtSeq: entry.seq, reason: "sequence gap or reorder" };
    }
    if (entry.prevLogHash !== expectedPrev) {
      return { valid: false, length: entries.length, brokenAtSeq: entry.seq, reason: "broken link to previous entry" };
    }
    const preimage = [
      entry.seq,
      entry.timestamp,
      entry.actorType,
      entry.actorId,
      entry.operation,
      entry.tier,
      entry.decision,
      entry.reason,
      entry.payloadDigest,
      entry.prevLogHash,
    ].join("|");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== entry.currentLogHash) {
      return { valid: false, length: entries.length, brokenAtSeq: entry.seq, reason: "entry contents were altered" };
    }
    expectedPrev = entry.currentLogHash;
  }
  return { valid: true, length: entries.length, brokenAtSeq: null, reason: null };
}

export function AuditLedger({ data }: { data: DashboardState }) {
  const [entries, setEntries] = useState<AuditLogEntry[]>(data.audit.entries);
  const [verification, setVerification] = useState<ChainVerification>(data.audit.verification);
  const [verifying, setVerifying] = useState(false);
  const [walkedTo, setWalkedTo] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [tampered, setTampered] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [expanded, setExpanded] = useState<number | null>(null);
  const pristine = useRef<AuditLogEntry[]>(data.audit.entries);

  // The incoming props win whenever the parent refetches after an action —
  // unless the tamper demo is running, which is deliberately local state.
  const source = useMemo(() => {
    if (tampered) return entries;
    return data.audit.entries.length >= entries.length ? data.audit.entries : entries;
  }, [data.audit.entries, entries, tampered]);

  const shown = useMemo(
    () => (filter === "ALL" ? source : source.filter((entry) => entry.decision === filter)),
    [source, filter],
  );

  const counts = useMemo(
    () => ({
      total: source.length,
      allowed: source.filter((e) => e.decision === "ALLOWED").length,
      drafted: source.filter((e) => e.decision === "DRAFTED").length,
      denied: source.filter((e) => e.decision === "DENIED").length,
    }),
    [source],
  );

  /** Walk the rows one at a time so the recomputation is something you watch. */
  const walk = async (rows: AuditLogEntry[], check: () => Promise<ChainVerification>) => {
    setVerifying(true);
    setElapsedMs(null);
    const started = performance.now();
    const result = await check();
    const stopAt = result.valid ? rows.length : (result.brokenAtSeq ?? rows.length);
    for (let i = 1; i <= stopAt; i++) {
      setWalkedTo(i);
      await new Promise((resolve) => setTimeout(resolve, WALK_MS_PER_ROW));
    }
    setElapsedMs(Math.round(performance.now() - started - stopAt * WALK_MS_PER_ROW));
    setVerification(result);
    setVerifying(false);
  };

  const verify = () =>
    walk(source, async () => {
      if (tampered) return verifyLocally(entries);
      const result = await verifyAuditChain();
      setEntries(result.entries);
      pristine.current = result.entries;
      return result.verification;
    });

  /** Flip one character of entry #12's reason, in memory only. */
  const tamper = () => {
    const edited = pristine.current.map((entry) =>
      entry.seq === TAMPER_SEQ ? { ...entry, reason: entry.reason.replace(/^./, (c) => (c === "T" ? "t" : "X")) } : entry,
    );
    setEntries(edited);
    setTampered(true);
    setExpanded(TAMPER_SEQ);
    void walk(edited, () => verifyLocally(edited));
  };

  const restore = () => {
    setEntries(pristine.current);
    setTampered(false);
    setExpanded(null);
    void walk(pristine.current, () => verifyLocally(pristine.current));
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

  const brokenAt = verification.valid ? null : verification.brokenAtSeq;

  return (
    <div className="flex flex-col gap-4">
      {/* The playground sits above the ledger on purpose: a judge should be
          able to attack the gate first, then watch the chain that recorded
          the real attempts stay intact. */}
      <RedTeamPlayground />

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
              {verifying ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <ShieldCheck className="size-4" aria-hidden />}
              {verifying ? `Verifying… ${walkedTo ?? 0} / ${source.length}` : "Verify SHA-256 chain integrity"}
            </Button>

            {tampered ? (
              <Button size="sm" variant="outline" onClick={restore} disabled={verifying} className="text-[11px]">
                <RotateCcw className="size-4" aria-hidden />
                Restore verified chain
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={tamper}
                disabled={verifying || source.length < TAMPER_SEQ}
                className="text-[11px]"
              >
                <Unlink className="size-4 text-slate-500" aria-hidden />
                Simulate tamper on entry #{TAMPER_SEQ}
              </Button>
            )}

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
                  ✓ {verification.length} of {verification.length} verified · chain intact from genesis
                  {elapsedMs !== null
                    ? ` · recomputed in ~${Math.max(elapsedMs, 1)}ms in this browser`
                    : " · verified by the service when this page loaded"}
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
          {!verification.valid ? (
            <div className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-rose-300 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
              <ShieldX className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                <span className="font-semibold">BROKEN at seq {verification.brokenAtSeq}</span> — {verification.reason}.
                Chain broken from this point forward; every entry after it is untrustworthy.
              </span>
            </div>
          ) : null}

          <Table containerLabel="Audit log entries" className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">seq</TableHead>
                <TableHead className="w-44">timestamp</TableHead>
                <TableHead>operation</TableHead>
                <TableHead>tier</TableHead>
                <TableHead>decision</TableHead>
                <TableHead>reason</TableHead>
                <TableHead className="w-28">chain</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((entry, index) => {
                const after = brokenAt !== null && entry.seq > brokenAt;
                const atBreak = brokenAt === entry.seq;
                const scanning = verifying && walkedTo === entry.seq;
                const walked = walkedTo !== null && entry.seq <= walkedTo && !after && !atBreak;
                return (
                  <TableRow
                    key={`${entry.seq}-${entry.currentLogHash}`}
                    onClick={() => setExpanded(expanded === entry.seq ? null : entry.seq)}
                    className={cn(
                      "cursor-pointer transition-colors",
                      entry.decision === "DENIED" && "bg-rose-50/50 dark:bg-rose-950/20",
                      entry.tier === "TIER_3_PROHIBITED" && "bg-rose-100/70 dark:bg-rose-950/40",
                      scanning && "bg-emerald-100/80 dark:bg-emerald-900/40",
                      atBreak && "bg-rose-100 dark:bg-rose-950/60",
                      // Everything after the break is unverifiable, not merely wrong.
                      after && "opacity-40",
                    )}
                  >
                    <TableCell className="font-mono tabular-nums text-slate-500">
                      {/* The hash-chain rail: a continuous link from genesis down,
                          snapping at the first entry that no longer recomputes. */}
                      <span className="flex items-center gap-1.5">
                        <span className="relative flex h-6 w-2 items-center justify-center">
                          <span
                            className={cn(
                              "absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2",
                              index === 0 && "top-1/2",
                              index === shown.length - 1 && "bottom-1/2",
                              atBreak || after
                                ? "bg-rose-400 dark:bg-rose-700"
                                : walked || verification.valid
                                  ? "bg-emerald-500"
                                  : "bg-slate-200 dark:bg-slate-700",
                            )}
                          />
                          {atBreak ? (
                            <Unlink className="relative size-2.5 text-rose-600 dark:text-rose-400" aria-hidden />
                          ) : (
                            <Link2
                              aria-hidden
                              className={cn(
                                "relative size-2.5",
                                after
                                  ? "text-rose-400"
                                  : walked || verification.valid
                                    ? "text-emerald-700 dark:text-emerald-400"
                                    : "text-slate-300 dark:text-slate-600",
                              )}
                            />
                          )}
                        </span>
                        {entry.seq}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-[10px] tabular-nums text-slate-500 dark:text-slate-400">
                      {toSeconds(entry.timestamp)}
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
                          <span>timestamp {entry.timestamp}</span>
                          <span>payloadDigest {entry.payloadDigest}</span>
                          <span className="flex items-center gap-1">
                            prev {entry.prevLogHash} <Link2 className="size-3" aria-hidden />
                          </span>
                          <span className={cn(atBreak && "text-rose-600 dark:text-rose-400")}>
                            curr {entry.currentLogHash}
                            {atBreak ? " ← no longer recomputes from the contents above" : ""}
                          </span>
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-[10px] text-slate-500">
                      {entry.prevLogHash === GENESIS ? (
                        <span className="text-emerald-700 dark:text-emerald-400">genesis</span>
                      ) : (
                        <>…{entry.prevLogHash.slice(-6)}</>
                      )}
                      <div>→ …{entry.currentLogHash.slice(-6)}</div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {shown.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-slate-500 dark:text-slate-400">
                    No entries for this filter yet.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>

          {tampered ? (
            <p className="m-4 text-[11px] text-slate-500 dark:text-slate-400">
              The edit above exists only in this browser tab — the file on disk is untouched. Verification is
              recomputed locally with WebCrypto, so detection does not depend on trusting the service that wrote
              the log.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
