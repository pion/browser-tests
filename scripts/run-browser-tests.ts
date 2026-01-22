// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultAddr = "127.0.0.1:38481";
const shouldStartServer = !process.env.TEST_SERVER_URL;
const serverAddr = process.env.TESTSERVER_ADDR || defaultAddr;

const vitestBin = path.resolve(
  rootDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vitest.cmd" : "vitest",
);

let serverProcess: ReturnType<typeof spawn> | null = null;

const shutdown = () => {
  if (!serverProcess) {
    return;
  }
  serverProcess.kill();
  serverProcess = null;
};

const exitHandlers = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
for (const signal of exitHandlers) {
  process.on(signal, () => {
    shutdown();
    process.exit(1);
  });
}

process.on("exit", () => {
  shutdown();
});

const waitForHealth = async (url: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the timeout is reached.
    }

    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const serverUrl = process.env.TEST_SERVER_URL || `http://${serverAddr}`;

if (shouldStartServer) {
  serverProcess = spawn("go", ["run", "."], {
    cwd: rootDir,
    env: { ...process.env, TESTSERVER_ADDR: serverAddr },
    stdio: "inherit",
  });

  await waitForHealth(`${serverUrl}/health`, 30_000);
}

const vitestProcess = spawn(vitestBin, ["run", ...process.argv.slice(2)], {
  cwd: rootDir,
  env: { ...process.env, VITE_TEST_SERVER_URL: serverUrl },
  stdio: "inherit",
  shell: process.platform === "win32",
});

const exitCode = await new Promise<number>((resolve) => {
  vitestProcess.on("exit", (code) => {
    resolve(code ?? 1);
  });
});

shutdown();
process.exit(exitCode);
