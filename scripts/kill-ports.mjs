#!/usr/bin/env node
/**
 * Kill any stale processes listening on the dev-server ports (3000 & 8000)
 * so `npm run dev:all` can bind cleanly every time.
 *
 * Works on Windows (netstat + taskkill) and POSIX (lsof + kill).
 * Silently succeeds if nothing is listening.
 */

import { execSync } from "node:child_process";

const PORTS = [3000, 8000];

function killPortWindows(port) {
  try {
    const out = execSync(
      `netstat -ano | findstr ":${port} " | findstr LISTENING`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const pids = new Set();
    for (const line of out.trim().split(/\r?\n/)) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && pid !== "0") pids.add(pid);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, {
          stdio: ["pipe", "pipe", "pipe"],
        });
        console.log(`  Killed PID ${pid} on port ${port}`);
      } catch {
        // already exited — fine
      }
    }
  } catch {
    // nothing listening — fine
  }
}

function killPortPosix(port) {
  try {
    const out = execSync(`lsof -ti :${port}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const pid of out.trim().split(/\s+/)) {
      if (pid) {
        try {
          execSync(`kill -9 ${pid}`, { stdio: ["pipe", "pipe", "pipe"] });
          console.log(`  Killed PID ${pid} on port ${port}`);
        } catch {
          // already exited
        }
      }
    }
  } catch {
    // nothing listening
  }
}

const killPort = process.platform === "win32" ? killPortWindows : killPortPosix;

console.log("Cleaning up stale processes on ports:", PORTS.join(", "));
for (const port of PORTS) {
  killPort(port);
}
console.log("Ports clear ✓\n");
