"use client";

import { useState } from "react";
import { CheckCircle, ChevronDown, ChevronRight, KeyRound, LoaderCircle, Trash2, Wifi, WifiOff } from "lucide-react";

import { Button } from "@/components/ui/button";

interface AiConnectionData {
  id: string;
  provider: "gemini" | "openrouter";
  model: string;
  testedAt: number | null;
  testRevision: number;
  updatedAt: number;
}

async function apiPost(action: string, extra: Record<string, unknown> = {}) {
  const res = await fetch("/api/ai-connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

const BASE_URL = "https://openrouter.ai/api/v1";

export function AiConnectionPanel({ companyId }: { companyId: string }) {
  void companyId; // scoped server-side; passed for future multi-company tabs
  const [connection, setConnection] = useState<AiConnectionData | null | "loading">("loading");
  const [provider, setProvider] = useState<"gemini" | "openrouter">("gemini");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [providerOrder, setProviderOrder] = useState("");
  const [busy, setBusy] = useState(false);
  const [testStatus, setTestStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Load on first render
  if (connection === "loading") {
    setConnection(null);
    apiPost("get")
      .then((d: { connection: AiConnectionData | null }) => {
        setConnection(d.connection);
        if (!d.connection) setShowForm(true);
      })
      .catch((e: Error) => setError(e.message));
  }

  const save = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setTestStatus(null);
    try {
      const data = await apiPost("save", {
        provider,
        model: model.trim(),
        apiKey: apiKey.trim(),
        ...(provider === "openrouter" && providerOrder.trim()
          ? { providerRestrictions: { order: providerOrder.split(",").map((s) => s.trim()).filter(Boolean), require_parameters: true } }
          : {}),
      }) as { connection: AiConnectionData };
      setConnection(data.connection);
      setApiKey("");
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setTestStatus(null);
    try {
      const result = await apiPost("test") as { ok: boolean; detail: string };
      setTestStatus(result);
      if (result.ok) {
        // Refresh connection to show updated testedAt
        const fresh = await apiPost("get") as { connection: AiConnectionData | null };
        setConnection(fresh.connection);
      }
    } catch (err) {
      setTestStatus({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm("Remove this AI connection? Monitoring will be paused.")) return;
    setBusy(true);
    try {
      await apiPost("remove");
      setConnection(null);
      setShowForm(true);
      setTestStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const INPUT = "h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100";
  const SELECT = INPUT + " cursor-pointer";

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-200">
        <strong>Your API key, your account.</strong> When monitoring is active, Vantora sends your company&apos;s financial context (cash position, invoices, payables and optimization results) to the selected provider on your behalf. Provider usage costs apply to your account. Keys are stored encrypted and never appear in logs, audit payloads or model prompts.
      </div>

      {error ? (
        <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
      ) : null}

      {/* Existing connection summary */}
      {connection && connection !== "loading" ? (
        <div className="flex items-start justify-between rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100">
              {connection.testedAt ? (
                <CheckCircle className="size-4 text-emerald-500" aria-hidden />
              ) : (
                <WifiOff className="size-4 text-amber-500" aria-hidden />
              )}
              {connection.provider === "gemini" ? "Google Gemini" : "OpenRouter"}
              <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{connection.model}</span>
            </div>
            {connection.testedAt ? (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Last tested {new Date(connection.testedAt).toLocaleString()}
              </span>
            ) : (
              <span className="text-xs text-amber-600 dark:text-amber-400">Not yet tested — run a capability test before enabling monitoring</span>
            )}
            {testStatus ? (
              <span className={`text-xs ${testStatus.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                Test: {testStatus.detail}
              </span>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={test} disabled={busy}>
              {busy ? <LoaderCircle className="size-3 animate-spin" aria-hidden /> : <Wifi className="size-3" aria-hidden />}
              Test
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowForm((v) => !v)}
              aria-expanded={showForm}
              className="gap-1"
            >
              {showForm ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
              Replace
            </Button>
            <Button size="sm" variant="outline" onClick={remove} disabled={busy} className="text-rose-600 hover:text-rose-700">
              <Trash2 className="size-3" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}

      {/* Connection form */}
      {showForm ? (
        <form onSubmit={save} className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {connection ? "Replace connection" : "Add AI connection"}
          </h3>

          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-400">
            API service
            <select className={SELECT} value={provider} onChange={(e) => setProvider(e.target.value as "gemini" | "openrouter")}>
              <option value="gemini">Google Gemini</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-400">
            Model ID
            <input
              className={INPUT}
              placeholder={provider === "gemini" ? "gemini-2.0-flash" : "openai/gpt-4o-mini"}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
            />
            <span className="text-[10px] text-slate-400">Enter the exact model identifier. Vantora does not substitute a different model if this one is unavailable.</span>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-400">
            API key
            <input
              type="password"
              className={INPUT}
              placeholder="Paste your key here"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>

          {provider === "openrouter" ? (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-400">
                Base URL
                <input className={INPUT} value={BASE_URL} readOnly aria-readonly="true" />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-400">
                Inference provider order (optional)
                <input
                  className={INPUT}
                  placeholder="openai,anthropic (comma-separated)"
                  value={providerOrder}
                  onChange={(e) => setProviderOrder(e.target.value)}
                />
                <span className="text-[10px] text-slate-400">Restricts OpenRouter to these underlying providers in order. Leave blank to use OpenRouter&apos;s default routing.</span>
              </label>
            </>
          ) : null}

          <div className="flex gap-2 pt-1">
            <Button type="submit" size="sm" disabled={busy || !model.trim() || !apiKey.trim()}>
              {busy ? <LoaderCircle className="size-3 animate-spin" aria-hidden /> : <KeyRound className="size-3" aria-hidden />}
              Save connection
            </Button>
            {connection ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
