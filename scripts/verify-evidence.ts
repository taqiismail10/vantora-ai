/**
 * Independently re-verify a frozen audit chain and print it.
 *
 *   npm run verify-evidence -- docs/evidence/session-2026-10-19/sandbox_operation_logs.jsonl
 *
 * Recomputes every SHA-256 entry hash and link with the same function the
 * server uses; exits non-zero if anything does not verify.
 */

import { resolve } from "node:path";

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: npm run verify-evidence -- <path to .jsonl>");
  // The logger reads its path at import time, so set it before importing.
  process.env.VANTORA_AUDIT_LOG = resolve(file);
  const { readChain, verifyChain } = await import("../src/lib/sandbox/execution-logger");
  const entries = readChain();
  const verification = verifyChain(entries);
  for (const e of entries) {
    console.log(
      [String(e.seq).padStart(3), e.timestamp, e.actorType.padEnd(5), e.operation.padEnd(32), e.decision.padEnd(7), e.actorId].join("  "),
    );
  }
  console.log(JSON.stringify(verification));
  if (!verification.valid) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
