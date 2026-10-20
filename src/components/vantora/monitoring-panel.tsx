"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle, Clock, FileText, Loader2, Pause, Play, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AiConnectionPanel } from "./ai-connection-panel";

interface Mandate {
  id: string;
  status: "active" | "paused" | "stopped";
  checkIntervalS: number;
  endDate: string | null;
  runsExecuted: number;
  maxRunsTotal: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  activatedAt: number | null;
}

interface Run {
  id: string;
  status: "running" | "completed" | "failed" | "stale";
  trigger: string;
  startedAt: number;
  completedAt: number | null;
  source: "live_model" | "deterministic" | "failed" | null;
  fallbackReason: string | null;
  findingsJson: string | null;
  draftsJson: string | null;
  toolCallsJson: string | null;
  toolCallsUsed: number;
  errorMessage: string | null;
}

async function apiPost(path: string, action: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body;
}

function formatInterval(s: number) {
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

function RunCard({ run }: { run: Run }) {
  const [expanded, setExpanded] = useState(false);
  const findings = run.findingsJson ? JSON.parse(run.findingsJson) as { answer: string; integrityOk: boolean; integrityViolations: string[] } : null;
  const drafts = run.draftsJson ? JSON.parse(run.draftsJson) as { tool: string; text: string }[] : null;
  const toolCalls = run.toolCallsJson ? JSON.parse(run.toolCallsJson) as { tool: string; tier: string; decision: string }[] : null;

  const statusColor = {
    running: "text-blue-600 dark:text-blue-400",
    completed: run.source === "deterministic" ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400",
    failed: "text-rose-600 dark:text-rose-400",
    stale: "text-slate-500",
  }[run.status];

  const sourceLabel = run.source === "live_model" ? "live model" : run.source === "deterministic" ? "deterministic fallback" : "failed";

  return (
    <div className="rounded-md border border-slate-200 text-xs dark:border-slate-700">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 p-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        <span className={`font-medium ${statusColor}`}>{run.status}</span>
        <span className="text-slate-500">{run.trigger}</span>
        <span className="ml-auto text-slate-400">{new Date(run.startedAt).toLocaleString()}</span>
        {run.source ? <span className={`text-[10px] ${run.source === "deterministic" ? "text-amber-500" : "text-slate-400"}`}>{sourceLabel}</span> : null}
        {run.toolCallsUsed > 0 ? <span className="text-slate-400">{run.toolCallsUsed} tools</span> : null}
      </button>

      {expanded ? (
        <div className="flex flex-col gap-2 border-t border-slate-200 p-3 dark:border-slate-700">
          {run.source === "deterministic" ? (
            <p className="text-amber-600 dark:text-amber-400">
              This run used the deterministic fallback — the AI provider was unavailable ({run.fallbackReason ?? "unknown reason"}).
              It does not count as live-model task completion.
            </p>
          ) : null}
          {findings ? (
            <div>
              <p className="mb-1 font-medium text-slate-700 dark:text-slate-300">Findings</p>
              <p className="whitespace-pre-wrap text-slate-600 dark:text-slate-400">{findings.answer}</p>
              {!findings.integrityOk ? (
                <p className="mt-1 text-rose-600">Integrity violations: {findings.integrityViolations.join("; ")}</p>
              ) : null}
            </div>
          ) : null}
          {drafts && drafts.length > 0 ? (
            <div>
              <p className="mb-1 font-medium text-slate-700 dark:text-slate-300">Drafts prepared ({drafts.length})</p>
              {drafts.map((d, i) => (
                <div key={i} className="mb-2 rounded border border-slate-200 p-2 dark:border-slate-700">
                  <p className="mb-1 font-mono text-[10px] text-slate-500">{d.tool}</p>
                  <p className="whitespace-pre-wrap text-slate-600 dark:text-slate-400">{d.text}</p>
                </div>
              ))}
            </div>
          ) : null}
          {toolCalls && toolCalls.length > 0 ? (
            <div>
              <p className="mb-1 font-medium text-slate-700 dark:text-slate-300">Tool calls</p>
              <div className="flex flex-wrap gap-1">
                {toolCalls.map((tc, i) => (
                  <span key={i} className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] dark:border-slate-700 dark:bg-slate-800">
                    {tc.tool} · {tc.decision}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {run.errorMessage ? <p className="text-rose-600 dark:text-rose-400">Error: {run.errorMessage}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function MonitoringPanel({ companyId }: { companyId: string }) {
  const [mandate, setMandate] = useState<Mandate | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [worker, setWorker] = useState<{ online: boolean; lastSeenAt: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"connection" | "monitoring">("connection");
  const [intervalS, setIntervalS] = useState(3600);
  const [endDate, setEndDate] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await apiPost("/api/monitoring", "get") as {
        mandate: Mandate | null;
        runs: Run[];
        worker: { online: boolean; lastSeenAt: number | null };
      };
      setMandate(data.mandate);
      setRuns(data.runs);
      setWorker(data.worker);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  // Refresh while a run is in flight, and also whenever the mandate is active:
  // a worker-triggered run starts with no interaction in this tab at all, so
  // without the second case the owner would have to reload to ever see one.
  useEffect(() => {
    const hasRunning = runs.some((r) => r.status === "running");
    if (!hasRunning && mandate?.status !== "active") return;
    const id = setInterval(() => void load(), hasRunning ? 5_000 : 15_000);
    return () => clearInterval(id);
  }, [runs, mandate?.status, load]);

  const mandateAction = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/monitoring", action, extra);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const INPUT = "h-9 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100";

  const statusBadge = mandate ? {
    active: <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400"><Activity className="size-3" /> Active</span>,
    paused: <span className="flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400"><Pause className="size-3" /> Paused</span>,
    stopped: <span className="flex items-center gap-1 text-xs font-medium text-slate-500"><Square className="size-3" /> Stopped</span>,
  }[mandate.status] : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Section tabs */}
      <div className="flex gap-2 border-b border-slate-200 dark:border-slate-700">
        {(["connection", "monitoring"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-2 text-sm font-medium capitalize ${tab === t ? "border-b-2 border-blue-500 text-blue-600 dark:text-blue-400" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}`}
          >
            {t === "connection" ? "AI Connection" : "Monitoring Mandate"}
          </button>
        ))}
      </div>

      {error ? <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}

      {worker && !worker.online ? (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700/60 dark:bg-amber-950/30">
          <p className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-300">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden /> Monitoring worker is not running
          </p>
          <p className="mt-1 text-amber-700 dark:text-amber-400">
            {mandate?.status === "active"
              ? "This mandate is active but nothing is processing its checks, so no new assessment will be produced until the worker is started."
              : "Scheduled and change-triggered checks will not run until the worker is started."}
          </p>
          <p className="mt-1.5 text-amber-700 dark:text-amber-400">
            Start it with <code className="rounded bg-amber-100 px-1 py-0.5 font-mono dark:bg-amber-900/40">npm run worker</code>,
            or run everything together with <code className="rounded bg-amber-100 px-1 py-0.5 font-mono dark:bg-amber-900/40">npm run dev:all</code>.
          </p>
          <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-500">
            {worker.lastSeenAt
              ? `Last seen ${new Date(worker.lastSeenAt).toLocaleString()}.`
              : "No worker has ever reported in on this database."}
          </p>
        </div>
      ) : null}

      {tab === "connection" ? (
        <AiConnectionPanel companyId={companyId} />
      ) : (
        <div className="flex flex-col gap-4">
          {/* Standing instruction display */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/30 dark:text-slate-400">
            <p className="mb-1 font-medium text-slate-700 dark:text-slate-300">Standing instruction (fixed)</p>
            <p className="italic">
              &ldquo;Monitor this company&rsquo;s cash position. Reassess relevant financial changes, investigate forecast buffer breaches, compare feasible recovery options and prepare counterparty requests for my review.&rdquo;
            </p>
            <p className="mt-2 text-[10px] text-slate-400">The instruction scope is fixed. Free-text additions cannot grant additional permissions.</p>
          </div>

          {mandate ? (
            <div className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                  {statusBadge}
                  <span className="text-xs text-slate-500">
                    Check every {formatInterval(mandate.checkIntervalS)}
                    {mandate.endDate ? ` · ends ${mandate.endDate}` : ""}
                    {" · "}{mandate.runsExecuted}/{mandate.maxRunsTotal} runs used
                  </span>
                  {mandate.lastRunAt ? (
                    <span className="text-xs text-slate-400">Last run: {new Date(mandate.lastRunAt).toLocaleString()}</span>
                  ) : null}
                  {mandate.status === "active" && mandate.nextRunAt ? (
                    <span className="text-xs text-slate-400">Next scheduled: {new Date(mandate.nextRunAt).toLocaleString()}</span>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  {mandate.status !== "active" ? (
                    <Button size="sm" onClick={() => mandateAction("activate")} disabled={busy}>
                      {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                      Activate
                    </Button>
                  ) : null}
                  {mandate.status === "active" ? (
                    <Button size="sm" variant="outline" onClick={() => mandateAction("pause")} disabled={busy}>
                      <Pause className="size-3" /> Pause
                    </Button>
                  ) : null}
                  {mandate.status !== "stopped" ? (
                    <Button size="sm" variant="outline" onClick={() => mandateAction("stop")} disabled={busy} className="text-rose-600">
                      <Square className="size-3" /> Stop
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Create monitoring mandate</p>
              <div className="flex gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-400">
                  Check interval
                  <select className={INPUT} value={intervalS} onChange={(e) => setIntervalS(Number(e.target.value))}>
                    <option value={300}>5 minutes</option>
                    <option value={900}>15 minutes</option>
                    <option value={3600}>1 hour</option>
                    <option value={21600}>6 hours</option>
                    <option value={86400}>Daily</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-400">
                  End date (optional)
                  <input type="date" className={INPUT} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </label>
              </div>
              <Button
                size="sm"
                onClick={() => mandateAction("create", { checkIntervalS: intervalS, endDate: endDate || null })}
                disabled={busy}
              >
                {busy ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle className="size-3" />}
                Create mandate
              </Button>
              <p className="text-xs text-slate-400">After creating, activate to begin monitoring. The AI connection must have passed a capability test.</p>
            </div>
          )}

          {/* Run history */}
          {runs.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                <FileText className="size-4" aria-hidden />
                Recent runs
                {runs.some((r) => r.status === "running") ? (
                  <span className="flex items-center gap-1 text-xs text-blue-500">
                    <Clock className="size-3 animate-pulse" aria-hidden /> running
                  </span>
                ) : null}
              </div>
              {runs.map((r) => <RunCard key={r.id} run={r} />)}
            </div>
          ) : null}

          {mandate && runs.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-slate-200 p-3 text-xs text-slate-500 dark:border-slate-700">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              No runs yet. Activate the mandate to start monitoring.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
