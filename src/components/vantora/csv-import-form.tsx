"use client";

/**
 * CSV import: choose a record type, map columns, preview, then confirm.
 *
 * Parsing and validation are entirely server-side (`csv-import.ts`) — this
 * component only reads the file's header line, client-side, to populate the
 * column-mapping dropdowns. The server never trusts the preview it already
 * sent back: confirming re-sends the same file and mapping, and the server
 * re-validates from scratch before writing anything.
 */

import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { companyAction, formatMinor } from "./company-api";
import { INPUT } from "./company-forms";

type Kind = "receivable" | "payable";

interface ImportRowResult {
  rowNumber: number;
  status: "new" | "duplicate_identical" | "duplicate_conflict" | "error";
  errors: string[];
  counterpartyName?: string;
  externalId?: string;
  amountCents?: number;
  dueDate?: string;
}

interface ImportPreview {
  rows: ImportRowResult[];
  counts: { new: number; duplicateIdentical: number; duplicateConflict: number; error: number };
}

const RECEIVABLE_FIELDS = [
  { key: "counterpartyName", label: "Buyer", required: true },
  { key: "amount", label: "Amount", required: true },
  { key: "dueDate", label: "Due date", required: true },
  { key: "externalId", label: "Reference", required: true },
  { key: "issueDate", label: "Issue date", required: false },
] as const;

const PAYABLE_FIELDS = [
  { key: "counterpartyName", label: "Supplier", required: true },
  { key: "amount", label: "Amount", required: true },
  { key: "dueDate", label: "Due date", required: true },
  { key: "externalId", label: "Reference", required: true },
] as const;

function downloadTemplate(kind: Kind) {
  const header =
    kind === "receivable" ? "counterparty_name,amount,due_date,reference,issue_date" : "counterparty_name,amount,due_date,reference";
  const example =
    kind === "receivable"
      ? '"Example Buyer Ltd.",1000.00,2026-12-01,INV-1001,2026-11-01'
      : '"Example Supplier Ltd.",500.00,2026-12-15,BILL-2001';
  const blob = new Blob([`${header}\n${example}\n`], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${kind}_import_template.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Naive split of the header line only, to populate mapping dropdowns. The
 * authoritative parse of the actual data (quotes, embedded commas, Unicode)
 * happens server-side and never relies on this. */
function sniffHeader(text: string): string[] {
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? "";
  return firstLine.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
}

const STATUS_LABEL: Record<ImportRowResult["status"], string> = {
  new: "new",
  duplicate_identical: "already recorded — skipped",
  duplicate_conflict: "conflicts with an existing record",
  error: "error",
};

const STATUS_STYLE: Record<ImportRowResult["status"], string> = {
  new: "",
  duplicate_identical: "text-slate-500",
  duplicate_conflict: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  error: "border-transparent bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

export function CsvImportForm({ currency, onImported }: { currency: string; onImported: () => void }) {
  const [kind, setKind] = useState<Kind>("receivable");
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [header, setHeader] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; skippedIdentical: number; skippedConflict: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const fields = kind === "receivable" ? RECEIVABLE_FIELDS : PAYABLE_FIELDS;

  const reset = () => {
    setFileName(null);
    setCsvText(null);
    setHeader([]);
    setMapping({});
    setPreview(null);
    setResult(null);
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  const onFile = async (file: File) => {
    reset();
    setFileName(file.name);
    const text = await file.text();
    setCsvText(text);
    const cols = sniffHeader(text);
    setHeader(cols);
    // Best-effort default mapping by matching names, so the common case
    // (headers that already look like the template's) needs no clicking.
    const guess: Record<string, string> = {};
    for (const field of fields) {
      const hit = cols.find((c) => c.toLowerCase().replace(/[^a-z]/g, "") === field.key.toLowerCase());
      if (hit) guess[field.key] = hit;
    }
    setMapping(guess);
  };

  const canPreview = csvText && fields.filter((f) => f.required).every((f) => mapping[f.key]);

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await companyAction<{ ok: boolean } & ImportPreview>("csv_import_preview", {
        kind,
        csvText,
        mapping,
      });
      setPreview(response);
      setResult(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await companyAction<{ ok: boolean; created: number; skippedIdentical: number; skippedConflict: number }>(
        "csv_import_confirm",
        { kind, csvText, mapping },
      );
      setResult(response);
      setPreview(null);
      onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-slate-200 dark:border-slate-800">
      <CardHeader>
        <CardTitle className="text-sm">Import from a spreadsheet</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-xs">
        <p className="text-slate-500 dark:text-slate-400">
          Each row becomes one invoice or bill, matched to a buyer or supplier already on this company. A row never
          creates a new counterparty — add it first if it is missing. Nothing is written until you confirm the
          preview below.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5">
            <span className="font-medium text-slate-700 dark:text-slate-300">Importing</span>
            <select
              className={INPUT}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as Kind);
                reset();
              }}
            >
              <option value="receivable">What you are owed (receivables)</option>
              <option value="payable">What you owe (payables)</option>
            </select>
          </label>
          <Button type="button" variant="outline" size="sm" onClick={() => downloadTemplate(kind)}>
            Download {kind} template
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            className="text-xs"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
            }}
          />
          {fileName ? <span className="text-slate-500 dark:text-slate-400">{fileName}</span> : null}
        </div>

        {header.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {fields.map((field) => (
              <label key={field.key} className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-slate-700 dark:text-slate-300">
                  {field.label}
                  {field.required ? <span className="ml-1 text-rose-600 dark:text-rose-400">*</span> : " (optional)"}
                </span>
                <select
                  className={INPUT}
                  value={mapping[field.key] ?? ""}
                  onChange={(e) => setMapping((m) => ({ ...m, [field.key]: e.target.value }))}
                >
                  <option value="">Select a column…</option>
                  {header.map((col) => (
                    <option key={col} value={col}>
                      {col}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        ) : null}

        {header.length > 0 ? (
          <>
            <Button
              type="button"
              size="sm"
              disabled={!canPreview || busy}
              aria-disabled={!canPreview || busy}
              onClick={() => void runPreview()}
              className="w-fit"
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />}
              Preview import
            </Button>
            {!canPreview ? (
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Map every required column (*) above before previewing.</p>
            ) : null}
          </>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 p-2 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
            {error}
          </p>
        ) : null}

        {preview ? (
          <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="font-mono text-[10px]">
                {preview.counts.new} new
              </Badge>
              {preview.counts.duplicateIdentical ? (
                <Badge variant="outline" className="font-mono text-[10px] text-slate-500">
                  {preview.counts.duplicateIdentical} already recorded
                </Badge>
              ) : null}
              {preview.counts.duplicateConflict ? (
                <Badge variant="outline" className="border-transparent bg-amber-100 font-mono text-[10px] text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  {preview.counts.duplicateConflict} conflict
                </Badge>
              ) : null}
              {preview.counts.error ? (
                <Badge variant="outline" className="border-transparent bg-rose-100 font-mono text-[10px] text-rose-800 dark:bg-rose-950 dark:text-rose-300">
                  {preview.counts.error} error
                </Badge>
              ) : null}
            </div>
            <ul className="max-h-64 divide-y divide-slate-200 overflow-y-auto text-[11px] dark:divide-slate-800">
              {preview.rows.map((row) => (
                <li key={row.rowNumber} className="flex flex-wrap items-center gap-2 py-1.5">
                  <span className="font-mono text-slate-400">row {row.rowNumber}</span>
                  <span className="min-w-0 flex-1">{row.counterpartyName ?? "—"}</span>
                  {row.amountCents !== undefined ? <span className="tabular-nums">{formatMinor(row.amountCents, currency)}</span> : null}
                  {row.dueDate ? <span className="text-slate-500 dark:text-slate-400">due {row.dueDate}</span> : null}
                  <Badge variant="outline" className={`font-mono text-[10px] ${STATUS_STYLE[row.status]}`}>
                    {STATUS_LABEL[row.status]}
                  </Badge>
                  {row.errors.length > 0 ? <span className="w-full text-rose-700 dark:text-rose-300">{row.errors.join("; ")}</span> : null}
                </li>
              ))}
            </ul>
            <Button
              type="button"
              size="sm"
              disabled={busy || preview.counts.error > 0 || preview.counts.new === 0}
              onClick={() => void confirmImport()}
              className="w-fit"
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {preview.counts.error > 0 ? "Fix errors before confirming" : `Confirm — add ${preview.counts.new} record${preview.counts.new === 1 ? "" : "s"}`}
            </Button>
          </div>
        ) : null}

        {result ? (
          <p className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Added {result.created} record{result.created === 1 ? "" : "s"}.
            {result.skippedIdentical ? ` ${result.skippedIdentical} already on file, skipped.` : ""}
            {result.skippedConflict ? ` ${result.skippedConflict} conflicted with an existing record and were not imported.` : ""}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
