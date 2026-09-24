// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverAddr = process.env.TESTSERVER_ADDR || "127.0.0.1:38481";
const serverUrl = process.env.TEST_SERVER_URL || `http://${serverAddr}`;
const cancellation = new AbortController();
const children: ManagedChild[] = [];
let shuttingDown = false;
let buildDir: string | undefined;

type ExitResult = { code: number | null; signal?: string | null; error?: Error };
type ManagedChild = {
  process: ChildProcess;
  result: Promise<ExitResult>;
  exited: boolean;
};

const start = (command: string, args: string[], env = process.env) => {
  const child = spawn(command, args, {
    cwd: rootDir,
    env,
    stdio: "inherit",
    // Give each child its own process group so interruption also stops descendants.
    detached: process.platform !== "win32",
  });
  const managed: ManagedChild = {
    process: child,
    exited: false,
    result: new Promise((resolve) => {
      child.once("error", (error) => {
        managed.exited = true;
        resolve({ code: null, error });
      });
      child.once("exit", (code, signal) => {
        managed.exited = true;
        resolve({ code, signal });
      });
    }),
  };
  children.push(managed);
  return managed;
};

const exitError = (name: string, result: ExitResult) =>
  new Error(`${name} exited: ${result.error?.message ?? result.signal ?? result.code}`);

const whileRunning = async <T>(operation: Promise<T>): Promise<T> => {
  const { signal } = cancellation;
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

const stop = async (child: ManagedChild) => {
  const pid = child.process.pid;
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    if (child.exited) {
      return;
    }
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      killer.once("error", reject);
      killer.once("exit", (code) => {
        if (code === 0 || child.exited) {
          resolve();
        } else {
          reject(new Error(`Could not stop process tree ${pid}: taskkill exited ${code}`));
        }
      });
    });
    await child.result;
    return;
  }

  const killGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  };
  const timeout = setTimeout(() => killGroup("SIGKILL"), 5_000);
  try {
    killGroup("SIGTERM");
    await child.result;
    killGroup("SIGKILL");
  } finally {
    clearTimeout(timeout);
  }
};

const waitForHealth = async (id: string) => {
  const signal = AbortSignal.any([
    cancellation.signal,
    AbortSignal.timeout(30_000),
  ]);
  while (true) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`${serverUrl}/health`, { signal });
      const ready = response.ok && response.headers.get("X-Test-Server-ID") === id;
      await response.body?.cancel();
      if (ready) {
        return;
      }
    } catch {
      signal.throwIfAborted();
    }
    await delay(250, undefined, { signal });
  }
};

const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const onSignal = (signal: NodeJS.Signals) => {
  cancellation.abort(new Error(`Interrupted by ${signal}`));
};
for (const signal of signals) {
  process.on(signal, onSignal);
}

try {
  if (!process.env.TEST_SERVER_URL) {
    buildDir = await mkdtemp(path.join(tmpdir(), "pion-browser-tests-"));
    const executable = path.join(buildDir, process.platform === "win32" ? "server.exe" : "server");
    const build = start("go", ["build", "-o", executable, "."]);
    const result = await whileRunning(build.result);
    if (result.code !== 0) {
      throw exitError("Go build", result);
    }

    cancellation.signal.throwIfAborted();
    const id = randomUUID();
    const server = start(executable, [], {
      ...process.env,
      TESTSERVER_ADDR: serverAddr,
      TESTSERVER_ID: id,
    });
    void server.result.then((result) => {
      if (!shuttingDown) {
        cancellation.abort(exitError("Test server", result));
      }
    });
    await waitForHealth(id);
  }

  cancellation.signal.throwIfAborted();
  // Invoke Node directly instead of introducing a .cmd shell process on Windows.
  const vitest = start(process.execPath, [
    path.join(rootDir, "node_modules", "vitest", "vitest.mjs"),
    "run",
    ...process.argv.slice(2),
  ], { ...process.env, VITE_TEST_SERVER_URL: serverUrl });
  const result = await whileRunning(vitest.result);
  cancellation.signal.throwIfAborted();
  if (result.error) {
    throw exitError("Vitest", result);
  }
  process.exitCode = result.code ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  shuttingDown = true;
  const results = await Promise.allSettled(children.map(stop));
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Failed to stop child process:", result.reason);
      process.exitCode = 1;
    }
  }
  if (buildDir) {
    await rm(buildDir, { recursive: true, force: true });
  }
  for (const signal of signals) {
    process.off(signal, onSignal);
  }
}
