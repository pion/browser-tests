// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fixture: string;
let marker: string;

const listen = async (server: Server, port = 0) => {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
};

const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
};

const freePort = async () => {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
};

const assertPortReleased = async (port: number) => {
  const server = createServer();
  await listen(server, port);
  await close(server);
};

const launch = (port: number, extraEnv: NodeJS.ProcessEnv = {}) => {
  const env = { ...process.env };
  delete env.TEST_SERVER_URL;
  delete env.PION_WEBRTC_SOURCE;
  const child = spawn(process.execPath, ["scripts/run-browser-tests.ts"], {
    cwd: fixture,
    env: {
      ...env,
      GOWORK: "off",
      GOFLAGS: [env.GOFLAGS, "-buildvcs=false"].filter(Boolean).join(" "),
      TESTSERVER_ADDR: `127.0.0.1:${port}`,
      RUNNER_TEST_MARKER: marker,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  const finished = once(child, "close").then(([code]) => ({ code, output }));
  return { child, finished };
};

const waitForMarker = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(marker, "utf8")) as {
        pid: number;
        descendant?: number;
      };
    } catch {
      await delay(25);
    }
  }
  throw new Error("Vitest fixture never started");
};

const assertProcessStopped = async (pid: number) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return;
    }
    await delay(25);
  }
  assert.fail(`Process ${pid} survived runner cleanup`);
};

describe("browser runner lifecycle", { timeout: 120_000 }, () => {
  before(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), "pion-runner-regression-"));
    marker = path.join(fixture, "vitest-started.json");
    await mkdir(path.join(fixture, "scripts"));
    await mkdir(path.join(fixture, "node_modules", "vitest"), { recursive: true });
    for (const file of ["scripts/run-browser-tests.ts", "runner.go", "internal", "go.mod", "go.sum"]) {
      await cp(path.join(rootDir, file), path.join(fixture, file), { recursive: true });
    }
    await writeFile(path.join(fixture, "package.json"), '{"type":"module"}\n');
    // Exit the real server after Vitest starts, without adding test hooks to it.
    await writeFile(path.join(fixture, "crash_fixture.go"), `package main
      import ("os"; "time")
      func init() {
        if os.Getenv("RUNNER_TEST_CRASH_SERVER") == "1" {
          go func() {
            for {
              if _, err := os.Stat(os.Getenv("RUNNER_TEST_MARKER")); err == nil {
                os.Exit(9)
              }
              time.Sleep(10 * time.Millisecond)
            }
          }()
        }
      }
    `);
    const descendantScript = JSON.stringify(`
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      process.send("ready");
    `);
    await writeFile(path.join(fixture, "node_modules", "vitest", "vitest.mjs"), `
      import { spawn } from "node:child_process";
      import { once } from "node:events";
      import { writeFileSync } from "node:fs";
      const response = await fetch(process.env.VITE_TEST_SERVER_URL + "/health");
      if (!response.ok) process.exit(2);
      await response.body.cancel();
      const record = { pid: process.pid };
      if (process.env.RUNNER_TEST_MODE === "hang") {
        const descendant = spawn(process.execPath, ["-e", ${descendantScript}], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        await once(descendant, "message");
        record.descendant = descendant.pid;
        setInterval(() => {}, 1000);
      }
      writeFileSync(process.env.RUNNER_TEST_MARKER, JSON.stringify(record));
      if (process.env.RUNNER_TEST_MODE !== "hang") {
        process.exit(Number(process.env.RUNNER_TEST_EXIT || 0));
      }
    `);
  });

  after(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  it("releases the server port after each of two successful runs", async () => {
    const port = await freePort();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await launch(port).finished;
      assert.equal(result.code, 0, result.output);
      await assertPortReleased(port);
    }
  });

  it("fails instead of running tests against an existing healthy server", async () => {
    await rm(marker, { force: true });
    const existing = createServer((_req, res) => res.end("ok"));
    const port = await listen(existing);
    try {
      const result = await launch(port).finished;
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /Test server exited/);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(await response.text(), "ok");
    } finally {
      await close(existing);
    }
  });

  it("fails immediately on a build error and preserves explicit external-server mode", async () => {
    const source = path.join(fixture, "runner.go");
    const original = await readFile(source);
    await rm(marker, { force: true });
    const external = createServer((_req, res) => res.end("ok"));
    const port = await listen(external);
    try {
      await writeFile(source, "invalid go source\n");
      const failed = await launch(port).finished;
      assert.notEqual(failed.code, 0, failed.output);
      assert.match(failed.output, /Go build exited/);
      await assert.rejects(readFile(marker), { code: "ENOENT" });

      const result = await launch(port, {
        TEST_SERVER_URL: `http://127.0.0.1:${port}`,
      }).finished;
      assert.equal(result.code, 0, result.output);
      assert(external.listening);
    } finally {
      await writeFile(source, original);
      await close(external);
    }
  });

  it("preserves a failing Vitest exit code and stops the server", async () => {
    const port = await freePort();
    const result = await launch(port, { RUNNER_TEST_EXIT: "7" }).finished;
    assert.equal(result.code, 7, result.output);
    await assertPortReleased(port);
  });

  it("fails and stops Vitest when the server exits during testing", async () => {
    await rm(marker, { force: true });
    const port = await freePort();
    const run = launch(port, {
      RUNNER_TEST_MODE: "hang",
      RUNNER_TEST_CRASH_SERVER: "1",
    });
    const result = await run.finished;
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /Test server exited: 9/);
    await assertPortReleased(port);
    const processes = await waitForMarker();
    await assertProcessStopped(processes.pid);
    assert(processes.descendant);
    await assertProcessStopped(processes.descendant);
  });

  it("stops Vitest, its descendants, and the server on SIGTERM", {
    skip: process.platform === "win32" && "Windows does not deliver SIGTERM to Node handlers",
  }, async () => {
    await rm(marker, { force: true });
    const port = await freePort();
    const run = launch(port, { RUNNER_TEST_MODE: "hang" });
    try {
      const processes = await waitForMarker();
      run.child.kill("SIGTERM");
      const result = await run.finished;
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /Interrupted by SIGTERM/);
      await assertPortReleased(port);
      await assertProcessStopped(processes.pid);
      assert(processes.descendant);
      await assertProcessStopped(processes.descendant);
    } finally {
      run.child.kill("SIGTERM");
      await run.finished;
    }
  });
});
