import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInjector } from "../src/injector.js";
import type { WakeEvent } from "../src/protocol.js";
import { testConfig } from "./helpers.js";

const wake: WakeEvent = {
  kind: "wake",
  version: 1,
  connectionEpoch: "epoch-1",
  wakeId: "wake-1",
  reason: "notification",
  message: "read the authoritative state",
  createdAt: "2026-08-11T00:00:00.000Z",
};

function script(source: string) {
  const config = testConfig();
  return {
    injector: { executable: process.execPath, args: ["-e", source] },
    policy: config.policy,
  };
}

test("injector receives one stdin envelope without the Bell token", async () => {
  const previous = process.env.BELL_TOKEN;
  process.env.BELL_TOKEN = "must-not-reach-child";
  try {
    const result = await runInjector(
      script(`
        let input = "";
        process.stdin.on("data", chunk => input += chunk);
        process.stdin.on("end", () => {
          const value = JSON.parse(input);
          if (process.env.BELL_TOKEN || value.wake_id !== "wake-1") process.exitCode = 2;
          process.stdout.write(JSON.stringify({version: 1, status: process.exitCode ? "permanent_error" : "accepted", ...(process.exitCode ? {error_code: "bad_input"} : {})}));
        });
      `),
      wake,
      new AbortController().signal,
    );
    assert.deepEqual(result, { status: "accepted" });
  } finally {
    if (previous === undefined) delete process.env.BELL_TOKEN;
    else process.env.BELL_TOKEN = previous;
  }
});

test("injector rejects output whose version or exit semantics are invalid", async () => {
  const result = await runInjector(
    script('process.stdout.write(JSON.stringify({version: 2, status: "accepted"}))'),
    wake,
    new AbortController().signal,
  );
  assert.deepEqual(result, { status: "permanent_error", errorCode: "invalid_injector_output" });
});

test("injector timeout waits for the old process to be killed before returning", async () => {
  const config = testConfig();
  const result = await runInjector(
    {
      injector: {
        executable: process.execPath,
        args: ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      },
      policy: {
        ...config.policy,
        injectorTimeoutMs: 20,
        injectorKillGraceMs: 10,
      },
    },
    wake,
    new AbortController().signal,
  );
  assert.deepEqual(result, { status: "timeout", errorCode: "injector_timeout" });
});

test("injector timeout terminates the injector's whole POSIX process group", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process groups are not available on Windows");
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "bell-injector-tree-"));
  const pidPath = join(directory, "grandchild.pid");
  let grandchildPid: number | undefined;
  try {
    const config = testConfig();
    const grandchildSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const injectorSource = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    const result = await runInjector(
      {
        injector: { executable: process.execPath, args: ["-e", injectorSource] },
        policy: {
          ...config.policy,
          injectorTimeoutMs: 100,
          injectorKillGraceMs: 20,
        },
      },
      wake,
      new AbortController().signal,
    );
    const pid = Number(readFileSync(pidPath, "utf8"));
    grandchildPid = pid;
    assert.deepEqual(result, { status: "timeout", errorCode: "injector_timeout" });
    assert.throws(
      () => process.kill(pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  } finally {
    if (grandchildPid !== undefined) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
