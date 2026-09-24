// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fixture: string;
let upstream: string;
let mainCommit: string;

const git = async (...args: string[]) => {
  const { stdout } = await exec("git", ["-C", upstream, ...args]);
  return stdout.trim();
};

const commit = async () => {
  await git("add", ".");
  await git("-c", "user.name=Browser test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "test fixture");
};

const sourceFile = () => path.join(upstream, "source.go");
const setSource = (value: string) => writeFile(sourceFile(), `package webrtc\nconst SourceMarker = ${JSON.stringify(value)}\n`);

const run = async (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const env = { ...process.env };
  delete env.TEST_SERVER_URL;
  delete env.PION_WEBRTC_SOURCE;
  return exec(process.execPath, ["scripts/run-browser-tests.ts", ...args], {
    cwd: fixture,
    timeout: 120_000,
    env: {
      ...env,
      GOFLAGS: [env.GOFLAGS, "-buildvcs=false"].filter(Boolean).join(" "),
      // Selection must be isolated from any workspace inherited by the caller.
      GOWORK: path.join(fixture, "nonexistent-caller.go.work"),
      PION_WEBRTC_REPOSITORY: upstream,
      TESTSERVER_ADDR: `127.0.0.1:${address.port}`,
      ...extraEnv,
    },
  });
};

describe("WebRTC source selection", { timeout: 300_000 }, () => {
  before(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), "pion source selection "));
    upstream = path.join(fixture, "local checkout");
    await mkdir(path.join(fixture, "scripts"));
    await mkdir(path.join(fixture, "node_modules", "vitest"), { recursive: true });
    await mkdir(upstream);
    await cp(path.join(rootDir, "scripts/run-browser-tests.ts"), path.join(fixture, "scripts/run-browser-tests.ts"));
    await writeFile(path.join(fixture, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(fixture, "go.mod"), `module github.com/pion/browsertests

go 1.24.0

require github.com/pion/webrtc/v4 v4.2.20
`);
    await writeFile(path.join(fixture, "go.sum"), "");
    await writeFile(path.join(fixture, "runner.go"), `package main
      import ("net/http"; "os"; "github.com/pion/webrtc/v4")
      func main() {
        http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
          w.Header().Set("X-Test-Server-ID", os.Getenv("TESTSERVER_ID"))
          w.Write([]byte("ok"))
        })
        http.HandleFunc("/source", func(w http.ResponseWriter, r *http.Request) {
          w.Write([]byte(webrtc.SourceMarker))
        })
        if err := http.ListenAndServe(os.Getenv("TESTSERVER_ADDR"), nil); err != nil { panic(err) }
      }
    `);
    await writeFile(path.join(fixture, "node_modules", "vitest", "vitest.mjs"), `
      import assert from "node:assert/strict";
      const response = await fetch(process.env.VITE_TEST_SERVER_URL + "/source");
      assert.equal(await response.text(), process.env.EXPECTED_SOURCE);
      assert.deepEqual(process.argv.slice(2), ["run", "--reporter", "dot"]);
    `);
    await writeFile(path.join(upstream, "go.mod"), "module github.com/pion/webrtc/v4\n\ngo 1.24.0\n");
    await git("init", "--quiet", "-b", "main");
    await setSource("main");
    await commit();
    mainCommit = await git("rev-parse", "HEAD");
    await git("checkout", "--quiet", "-b", "feature/source-test");
    await setSource("feature");
    await commit();
    await git("tag", "v4.99.0");
    await setSource("uncommitted local changes");
  });

  after(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  it("builds against a local checkout including uncommitted changes without editing either module", async () => {
    const files = [path.join(fixture, "go.mod"), path.join(fixture, "go.sum"), path.join(upstream, "go.mod"), sourceFile()];
    const before = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const status = await git("status", "--porcelain");
    await run(["--webrtc", "./local checkout", "--reporter", "dot"], {
      EXPECTED_SOURCE: "uncommitted local changes",
      // CLI selection must override the environment.
      PION_WEBRTC_SOURCE: "a-ref-that-does-not-exist",
    });
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), before);
    assert.equal(await git("status", "--porcelain"), status);
    await assert.rejects(readFile(path.join(fixture, "go.work")), { code: "ENOENT" });
  });

  it("accepts an absolute checkout path through the environment", async () => {
    await run(["--reporter", "dot"], {
      PION_WEBRTC_SOURCE: upstream,
      EXPECTED_SOURCE: "uncommitted local changes",
    });
  });

  it("fetches branches, tags, and commit SHAs into disposable checkouts", async () => {
    for (const [ref, expected] of [["feature/source-test", "feature"], ["v4.99.0", "feature"], [mainCommit, "main"]]) {
      const { stdout } = await run([`--webrtc=${ref}`, "--reporter", "dot"], { EXPECTED_SOURCE: expected });
      const checkout = stdout.match(/Testing Pion WebRTC checkout: (.+)/)?.[1];
      assert(checkout, stdout);
      assert.notEqual(checkout, upstream);
      await assert.rejects(readFile(path.join(checkout, "go.mod")), { code: "ENOENT" });
    }
  });

  it("fetches the current branch head on each run", async () => {
    await setSource("updated feature");
    await commit();
    await run(["--webrtc", "feature/source-test", "--reporter", "dot"], { EXPECTED_SOURCE: "updated feature" });
  });

  it("rejects missing paths, wrong modules, invalid refs, and conflicting external-server mode", async () => {
    const cases: [string[], NodeJS.ProcessEnv, RegExp][] = [
      [["--webrtc", "./missing"], {}, /WebRTC checkout does not exist/],
      [["--webrtc", "."], {}, /Expected github.com\/pion\/webrtc\/v4 checkout/],
      [["--webrtc", "no-such-ref"], {}, /exited:/],
      [["--webrtc"], {}, /--webrtc requires/],
      [["--webrtc", "main", "--webrtc", "main"], {}, /Specify --webrtc only once/],
      [["--webrtc", upstream], { TEST_SERVER_URL: "http://127.0.0.1:1" }, /Cannot select a WebRTC checkout\/ref/],
    ];
    for (const [args, env, message] of cases) {
      await assert.rejects(run(args, env), (error: unknown) => {
        assert(error instanceof Error && "stderr" in error);
        assert.match(String(error.stderr), message);
        return true;
      });
    }
  });
});
