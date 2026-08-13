import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { silentLogger } from "../src/logging.js";
import { acquireProcessLock } from "../src/process-lock.js";
import { runBell } from "../src/runner.js";
import { BellTransportError } from "../src/transport-error.js";
import { testConfig } from "./helpers.js";

test("runner stops after the explicit reconnect budget and releases its lock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bell-runner-"));
  let calls = 0;
  const config = testConfig({ stateDirectory: directory });
  try {
    await assert.rejects(
      runBell(config, {
        logger: silentLogger,
        signal: new AbortController().signal,
        random: () => 0.5,
        fetchImpl: async () => {
          calls += 1;
          return new Response(
            `event: connected\ndata: ${JSON.stringify({
              version: 1,
              connection_epoch: `epoch-${calls}`,
            })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      }),
      (error: unknown) =>
        error instanceof BellTransportError && error.message === "SSE reconnect budget exhausted",
    );
    assert.equal(calls, 2);
    const lock = acquireProcessLock(directory, config.token);
    lock.release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stable SSE session resets the consecutive reconnect budget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bell-runner-stable-"));
  const controller = new AbortController();
  let calls = 0;
  let clock = 0;
  const config = testConfig({
    stateDirectory: directory,
    policy: {
      ...testConfig().policy,
      reconnectMaxAttempts: 1,
    },
  });
  try {
    await runBell(config, {
      logger: silentLogger,
      signal: controller.signal,
      random: () => 0.5,
      now: () => {
        const current = clock;
        clock += config.policy.streamIdleTimeoutMs;
        return current;
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 3) {
          controller.abort(new Error("test complete"));
          throw controller.signal.reason;
        }
        return new Response(
          `event: connected\ndata: ${JSON.stringify({
            version: 1,
            connection_epoch: `epoch-${calls}`,
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    assert.equal(calls, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
