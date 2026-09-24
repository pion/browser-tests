// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
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
  output: string;
};

type CommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean };

const start = (command: string, args: string[], options: CommandOptions = {}) => {
  const child = spawn(command, args, {
    cwd: options.cwd ?? rootDir,
    env: options.env ?? process.env,
    stdio: ["inherit", options.capture ? "pipe" : "inherit", "inherit"],
    // Give each child its own process group so interruption also stops descendants.
    detached: process.platform !== "win32",
  });
  const managed: ManagedChild = {
    process: child,
    exited: false,
    output: "",
    result: new Promise((resolve) => {
      child.once("error", (error) => {
        managed.exited = true;
        resolve({ code: null, error });
      });
      child.once("exit", () => { managed.exited = true; });
      child.once("close", (code, signal) => {
        managed.exited = true;
        resolve({ code, signal });
      });
    }),
  };
  child.stdout?.on("data", (data: Buffer) => { managed.output += data.toString(); });
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

const execute = async (command: string, args: string[], options: CommandOptions = {}) => {
  cancellation.signal.throwIfAborted();
  const child = start(command, args, options);
  const result = await whileRunning(child.result);
  if (result.code !== 0) {
    throw exitError(`${command === "go" ? "Go" : command} ${args[0]}`, result);
  }
  return child.output.trim();
};

const parseArguments = () => {
  let source = process.env.PION_WEBRTC_SOURCE || "";
  let selected = false;
  const args = process.argv.slice(2);
  const vitestArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--webrtc" || arg.startsWith("--webrtc=")) {
      if (selected) {
        throw new Error("Specify --webrtc only once");
      }
      source = arg === "--webrtc" ? args[++index] : arg.slice("--webrtc=".length);
      if (!source || source.startsWith("-")) {
        throw new Error("--webrtc requires a checkout path, branch, tag, or commit");
      }
      selected = true;
    } else {
      vitestArgs.push(arg);
    }
  }
  return { source, vitestArgs };
};

const prepareWorkspace = async (source: string, directory: string) => {
  const env = { ...process.env, GOWORK: "off" };
  if (!source) {
    return env;
  }

  let checkout = path.resolve(source);
  const info = await stat(checkout).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  });
  if (info) {
    if (!info.isDirectory()) {
      throw new Error(`WebRTC checkout is not a directory: ${checkout}`);
    }
  } else {
    if (path.isAbsolute(source) || /^\.{1,2}([/\\]|$)/.test(source)) {
      throw new Error(`WebRTC checkout does not exist: ${checkout}`);
    }
    checkout = path.join(directory, "webrtc");
    const repository = process.env.PION_WEBRTC_REPOSITORY || "https://github.com/pion/webrtc.git";
    await execute("git", ["init", "--quiet", checkout]);
    await execute("git", ["-C", checkout, "fetch", "--quiet", "--depth=1", repository, "--", source]);
    await execute("git", ["-C", checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const commit = await execute("git", ["-C", checkout, "rev-parse", "HEAD"], { capture: true });
    console.log(`Testing Pion WebRTC ref ${source} at ${commit}`);
  }

  checkout = await realpath(checkout);
  const modulePath = await execute("go", ["list", "-m", "-f", "{{.Path}}"], {
    cwd: checkout, env, capture: true,
  });
  if (modulePath !== "github.com/pion/webrtc/v4") {
    throw new Error(`Expected github.com/pion/webrtc/v4 checkout, got ${modulePath}`);
  }
  console.log(`Testing Pion WebRTC checkout: ${checkout}`);
  await execute("go", ["work", "init", rootDir, checkout], { cwd: directory, env });
  return { ...env, GOWORK: path.join(directory, "go.work") };
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
  const { source, vitestArgs } = parseArguments();
  if (source && process.env.TEST_SERVER_URL) {
    throw new Error("Cannot select a WebRTC checkout/ref when TEST_SERVER_URL uses an external server");
  }
  if (!process.env.TEST_SERVER_URL) {
    buildDir = await mkdtemp(path.join(tmpdir(), "pion-browser-tests-"));
    const env = await prepareWorkspace(source, buildDir);
    const executable = path.join(buildDir, process.platform === "win32" ? "server.exe" : "server");
    await execute("go", ["build", "-o", executable, "."], { env });

    cancellation.signal.throwIfAborted();
    const id = randomUUID();
    const server = start(executable, [], {
      env: { ...process.env, TESTSERVER_ADDR: serverAddr, TESTSERVER_ID: id },
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
    ...vitestArgs,
  ], { env: { ...process.env, VITE_TEST_SERVER_URL: serverUrl } });
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
