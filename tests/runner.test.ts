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
    const lock = await acquireProcessLock(directory);
    await lock.release();
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

test("injector drain time after EOF cannot reset the reconnect budget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bell-runner-drain-"));
  let calls = 0;
  let clock = 0;
  const base = testConfig();
  const config = testConfig({
    stateDirectory: directory,
    policy: {
      ...base.policy,
      streamIdleTimeoutMs: 100,
      reconnectMaxAttempts: 1,
    },
  });
  try {
    await assert.rejects(
      runBell(config, {
        logger: silentLogger,
        signal: new AbortController().signal,
        random: () => 0.5,
        now: () => clock,
        injectorRun: async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          clock += config.policy.streamIdleTimeoutMs;
          return { status: "accepted" };
        },
        fetchImpl: async (_input, init) => {
          if (init?.method === "POST") {
            const body = JSON.parse(String(init.body)) as { wake_id: string };
            return new Response(
              JSON.stringify({ version: 1, wake_id: body.wake_id, status: "acked" }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          calls += 1;
          return new Response(
            `event: connected\ndata: ${JSON.stringify({
              version: 1,
              connection_epoch: `epoch-${calls}`,
            })}\n\nevent: wake\ndata: ${JSON.stringify({
              version: 1,
              connection_epoch: `epoch-${calls}`,
              wake_id: `wake-${calls}`,
              reason: "notification",
              message: "read state",
              created_at: "2026-08-13T00:00:00.000Z",
            })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      }),
      (error: unknown) =>
        error instanceof BellTransportError && error.message === "SSE reconnect budget exhausted",
    );
    assert.equal(calls, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local backpressure drains repeated full queues without spending the network reconnect budget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bell-runner-backpressure-"));
  const controller = new AbortController();
  let streamCalls = 0;
  let injectorCalls = 0;
  const base = testConfig();
  const config = testConfig({
    stateDirectory: directory,
    policy: {
      ...base.policy,
      reconnectMaxAttempts: 1,
    },
  });

  try {
    await runBell(config, {
      logger: silentLogger,
      signal: controller.signal,
      random: () => 0.5,
      injectorRun: async () => {
        injectorCalls += 1;
        return { status: "accepted" };
      },
      fetchImpl: async (_input, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { wake_id: string };
          return new Response(
            JSON.stringify({ version: 1, wake_id: body.wake_id, status: "acked" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        streamCalls += 1;
        if (streamCalls === 3) {
          controller.abort(new Error("backlog drained"));
          throw controller.signal.reason;
        }
        const epoch = `epoch-${streamCalls}`;
        const wakes = Array.from({ length: 33 }, (_, index) => {
          const wakeId = `wake-${streamCalls}-${index + 1}`;
          return `event: wake\ndata: ${JSON.stringify({
            version: 1,
            connection_epoch: epoch,
            wake_id: wakeId,
            reason: "notification",
            message: "read state",
            created_at: "2026-08-14T00:00:00.000Z",
          })}\n\n`;
        }).join("");
        return new Response(
          `event: connected\ndata: ${JSON.stringify({ version: 1, connection_epoch: epoch })}\n\n${wakes}`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    assert.equal(streamCalls, 3);
    assert.equal(injectorCalls, 64);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
