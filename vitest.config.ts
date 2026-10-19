import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Every run gets its own scratch directory. The application audit chain
// (`logs/`), the app database (`data/`) and the frozen submission evidence
// (`docs/evidence/`) are never opened by a test, and `vitest.global-setup.ts`
// fails the run if any of them changes anyway.
const RUN_DIR = mkdtempSync(join(tmpdir(), "vantora-test-"));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    env: {
      VANTORA_AUDIT_LOG: join(RUN_DIR, "sandbox_operation_logs.jsonl"),
      // One in-memory database per test file: module isolation gives every
      // file its own connection, so suites cannot see each other's users.
      VANTORA_DB_PATH: ":memory:",
      BETTER_AUTH_SECRET: "test-only-better-auth-secret-0123456789abcdef",
      BETTER_AUTH_URL: "http://localhost:3000",
      HITL_SIGNING_SECRET: "test-only-hitl-signing-secret-32-chars",
      // No provider is ever reached from a test: each adapter is driven through
      // an injected fake (Gemini client factory, OpenRouter fetch).
      AI_PROVIDER: "",
      GEMINI_API_KEY: "",
      GEMINI_MODEL: "",
      OPENROUTER_API_KEY: "",
      OPENROUTER_MODEL: "",
      OPENROUTER_BASE_URL: "",
      DATABASE_URL: "",
    },
    // The audit chain is a single append-only file, so the suites that write to
    // it must not race each other.
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
