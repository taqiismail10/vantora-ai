/**
 * Environment loading for standalone (non-Next.js) processes.
 *
 * `tsx worker/…` loads nothing on its own, and `import "dotenv/config"` reads
 * only `.env` — so a worker started that way silently disagrees with the Next.js
 * server about anything set in `.env.local`. For this feature that disagreement
 * is not cosmetic: a different AI_CREDENTIAL_ENCRYPTION_KEY makes every stored
 * credential undecryptable, and a different VANTORA_DB_PATH makes the worker
 * poll a database nobody is writing to. Both fail quietly.
 *
 * So the same cascade Next.js uses is reproduced here, in Next's precedence
 * order. `dotenv` never overwrites a variable that is already set, so loading
 * the highest-priority file first makes it win — which also means a real shell
 * variable still beats every file, as it does under Next.
 *
 * The load happens as an import side effect, not in an exported function:
 * `db.ts` resolves `DB_PATH` as a module-level constant, so the cascade has to
 * be in place before that module is *evaluated*. ES modules evaluate imports in
 * source order before the importing module's body runs, so importing this file
 * above the database-touching imports is what makes the ordering correct —
 * calling a function from the body would already be too late.
 */

import { existsSync } from "node:fs";
import { config } from "dotenv";

/** Highest precedence first; `dotenv` keeps the first value it sees. */
const FILES = [".env.local", ".env.development", ".env"];

const loaded: string[] = [];
for (const file of FILES) {
  if (!existsSync(file)) continue;
  config({ path: file, quiet: true });
  loaded.push(file);
}

/**
 * What was resolved, for the startup banner. Never carries a secret value —
 * only whether the encryption key is present at all.
 */
export const ENV_REPORT = {
  loaded,
  dbPath: process.env.VANTORA_DB_PATH ?? "data/vantora.db (default)",
  hasEncryptionKey: Boolean(process.env.AI_CREDENTIAL_ENCRYPTION_KEY),
} as const;
