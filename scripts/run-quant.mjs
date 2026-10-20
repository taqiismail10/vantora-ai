#!/usr/bin/env node
/**
 * Start the Python quantitative engine.
 *
 * `npm run quant` used to hard-code the Windows venv path, which broke on
 * POSIX and gave a useless error when the venv had never been created. This
 * resolves the interpreter for the current platform from the repo root, checks
 * it exists first, and forwards the child's exit code.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const python =
  process.platform === "win32"
    ? resolve(repoRoot, "quant_engine/.venv/Scripts/python.exe")
    : resolve(repoRoot, "quant_engine/.venv/bin/python");

if (!existsSync(python)) {
  console.error(
    [
      `No Python interpreter at ${python}`,
      "",
      "Create the engine venv first:",
      "  python -m venv quant_engine/.venv",
      process.platform === "win32"
        ? "  quant_engine/.venv/Scripts/python.exe -m pip install -r quant_engine/requirements.txt"
        : "  quant_engine/.venv/bin/python -m pip install -r quant_engine/requirements.txt",
      "",
      "The app still runs without it: src/lib/quant-client.ts falls back to the",
      "deterministic TypeScript mirror.",
    ].join("\n"),
  );
  process.exit(1);
}

const args = [
  "-m",
  "uvicorn",
  "quant_engine.main:app",
  "--host",
  "127.0.0.1",
  "--port",
  process.env.QUANT_ENGINE_PORT ?? "8000",
  ...process.argv.slice(2),
];

// cwd is the repo root so `quant_engine.main` resolves as a package.
const child = spawn(python, args, { cwd: repoRoot, stdio: "inherit" });

const stop = (signal) => child.kill(signal);
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

child.on("error", (error) => {
  console.error(`Could not start the quant engine: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
