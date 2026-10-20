/**
 * Guard rail: a test run must leave the application audit chain and the frozen
 * submission evidence byte-identical.
 *
 * Digests are taken before any suite runs and compared after the last one. A
 * mismatch fails the run rather than warning, because a silently regenerated
 * evidence file is exactly the failure this exists to prevent.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The app database (data/) is not listed: tests never open it (they use an
// in-memory database), and a dev server left running legitimately writes to it.
const PROTECTED = ["logs", join("docs", "evidence")];

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

function snapshot(): Map<string, string> {
  const digests = new Map<string, string>();
  for (const root of PROTECTED) {
    for (const file of files(join(process.cwd(), root))) {
      digests.set(file, createHash("sha256").update(readFileSync(file)).digest("hex"));
    }
  }
  return digests;
}

export default function setup() {
  const before = snapshot();
  return () => {
    const after = snapshot();
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
      (file) => before.get(file) !== after.get(file),
    );
    if (changed.length) {
      throw new Error(`test run modified protected files:\n  ${changed.join("\n  ")}`);
    }
  };
}
