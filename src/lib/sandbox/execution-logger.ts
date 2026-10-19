/**
 * SHA-256 hash-chained sandbox operation log (Deliverable 06).
 *
 * Every entry commits to its predecessor: currentLogHash = SHA256(fields ||
 * prevLogHash). Rewriting or dropping any entry breaks every hash after it,
 * which `verifyChain` reports.
 *
 * Entries are appended to logs/sandbox_operation_logs.jsonl and, when Supabase
 * is wired up, mirrored into the Prisma `AuditLog` table. The JSONL file is the
 * source of truth for the chain so the audit trail survives without a database.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { getPrismaClient } from "./seed-data";

export const GENESIS_HASH = "0".repeat(64);
/**
 * The application chain. Tests point `VANTORA_AUDIT_LOG` at a temp file (see
 * `vitest.setup.ts`) so a test run can never rewrite the evidence a reviewer
 * is shown.
 */
export const LOG_FILE =
  process.env.VANTORA_AUDIT_LOG ?? join(process.cwd(), "logs", "sandbox_operation_logs.jsonl");

export type PermissionTierName =
  | "TIER_0_AUTO_READ"
  | "TIER_1_DRAFT_ONLY"
  | "TIER_2_HITL_APPROVAL"
  | "TIER_3_PROHIBITED";

export type GateDecisionName = "ALLOWED" | "DRAFTED" | "DENIED";

export interface AuditLogEntry {
  seq: number;
  timestamp: string;
  actorType: string;
  actorId: string;
  operation: string;
  tier: PermissionTierName;
  decision: GateDecisionName;
  reason: string;
  /** SHA-256 of the operation payload; raw payloads never hit the log. */
  payloadDigest: string;
  prevLogHash: string;
  currentLogHash: string;
  smeProfileId?: string;
  recoveryPlanId?: string;
}

export interface LogOperationInput {
  actorId: string;
  operation: string;
  tier: PermissionTierName;
  decision: GateDecisionName;
  reason: string;
  payload?: unknown;
  actorType?: string;
  smeProfileId?: string;
  recoveryPlanId?: string;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function digestPayload(payload: unknown): string {
  return sha256(JSON.stringify(payload ?? null));
}

/** Field order is part of the contract: changing it invalidates every chain. */
export function computeEntryHash(entry: Omit<AuditLogEntry, "currentLogHash">): string {
  return sha256(
    [
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
    ].join("|"),
  );
}

export function readChain(): AuditLogEntry[] {
  if (!existsSync(/* turbopackIgnore: true */ LOG_FILE)) return [];
  return readFileSync(/* turbopackIgnore: true */ LOG_FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditLogEntry);
}

// ponytail: one writer per file is assumed. The cached head is trusted only
// while the file is exactly the size this process last left it; any outside
// change (another process, a restore, a manual edit) makes the next append
// re-read the real tail and continue from it, so the cache can never fork the
// chain onto a head that is no longer in the file. Two processes appending in
// the same instant can still collide — upgrade to an advisory lock or a DB
// sequence before running more than one writer.
let head: { seq: number; hash: string; size: number } | null = null;

const fileSize = () => (existsSync(/* turbopackIgnore: true */ LOG_FILE) ? statSync(/* turbopackIgnore: true */ LOG_FILE).size : 0);

function chainHead(): { seq: number; hash: string } {
  const size = fileSize();
  if (head && head.size === size) return head;
  const existing = readChain();
  const last = existing[existing.length - 1];
  if (head && last && head.seq !== last.seq) {
    console.warn(
      `[audit] ${LOG_FILE} changed outside this process (cached seq ${head.seq}, file tail seq ${last.seq}); continuing from the file`,
    );
  }
  head = last
    ? { seq: last.seq, hash: last.currentLogHash, size }
    : { seq: 0, hash: GENESIS_HASH, size };
  return head;
}

/**
 * Callers sometimes namespace the id themselves ("agent:vantora-copilot").
 * Storing that beside actorType renders as "agent:agent:vantora-copilot", so
 * the prefix is stripped once here rather than in every consumer.
 */
export function normaliseActorId(actorType: string, actorId: string): string {
  return actorId.startsWith(`${actorType}:`) ? actorId.slice(actorType.length + 1) : actorId;
}

/** Append one tamper-evident entry to the JSONL chain (and Prisma, if present). */
export async function logOperation(input: LogOperationInput): Promise<AuditLogEntry> {
  const previous = chainHead();
  const actorType = input.actorType ?? "agent";
  const unhashed: Omit<AuditLogEntry, "currentLogHash"> = {
    seq: previous.seq + 1,
    timestamp: new Date().toISOString(),
    actorType,
    actorId: normaliseActorId(actorType, input.actorId),
    operation: input.operation,
    tier: input.tier,
    decision: input.decision,
    reason: input.reason,
    payloadDigest: digestPayload(input.payload),
    prevLogHash: previous.hash,
    ...(input.smeProfileId ? { smeProfileId: input.smeProfileId } : {}),
    ...(input.recoveryPlanId ? { recoveryPlanId: input.recoveryPlanId } : {}),
  };

  const entry: AuditLogEntry = { ...unhashed, currentLogHash: computeEntryHash(unhashed) };

  mkdirSync(dirname(/* turbopackIgnore: true */ LOG_FILE), { recursive: true });
  appendFileSync(/* turbopackIgnore: true */ LOG_FILE, `${JSON.stringify(entry)}\n`, "utf8");
  head = { seq: entry.seq, hash: entry.currentLogHash, size: fileSize() };

  const prisma = await getPrismaClient();
  if (prisma?.auditLog) {
    try {
      await prisma.auditLog.create({ data: entry });
    } catch {
      // The JSONL chain is authoritative; a DB hiccup must not drop the audit.
    }
  }

  return entry;
}

export interface ChainVerification {
  valid: boolean;
  length: number;
  brokenAtSeq: number | null;
  reason: string | null;
}

/** Recompute every hash and link. Detects edits, deletions and reordering. */
export function verifyChain(entries: AuditLogEntry[] = readChain()): ChainVerification {
  let expectedPrev = GENESIS_HASH;
  for (const [index, entry] of entries.entries()) {
    if (entry.seq !== index + 1) {
      return { valid: false, length: entries.length, brokenAtSeq: entry.seq, reason: "sequence gap or reorder" };
    }
    if (entry.prevLogHash !== expectedPrev) {
      return { valid: false, length: entries.length, brokenAtSeq: entry.seq, reason: "broken link to previous entry" };
    }
    const { currentLogHash, ...rest } = entry;
    if (computeEntryHash(rest) !== currentLogHash) {
      return { valid: false, length: entries.length, brokenAtSeq: entry.seq, reason: "entry contents were altered" };
    }
    expectedPrev = currentLogHash;
  }
  return { valid: true, length: entries.length, brokenAtSeq: null, reason: null };
}

/** Test-only: drop the local chain so a run starts from genesis. */
export function resetAuditLog(): void {
  if (existsSync(/* turbopackIgnore: true */ LOG_FILE)) rmSync(/* turbopackIgnore: true */ LOG_FILE);
  head = null;
}
