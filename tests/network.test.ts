import assert from "node:assert/strict";
import { test } from "node:test";
import { BellControlClient } from "../src/control-client.js";
import { consumeBellStream } from "../src/sse/client.js";
import { BellTransportError } from "../src/transport-error.js";
import { testConfig } from "./helpers.js";

function eventStream(text: string): Response {
  return new Response(text, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

function controlConfirmation(wakeId: string, status: "acked" | "blocked"): Response {
  return new Response(JSON.stringify({ version: 1, wake_id: wakeId, status }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("SSE client sends token only in Authorization and accepts the connected handshake", async () => {
  const config = testConfig();
  let authorization: string | null = null;
  const result = await consumeBellStream({
    url: config.streamUrl,
    token: config.token,
    limits: config.policy,
    connectTimeoutMs: config.policy.connectTimeoutMs,
    idleTimeoutMs: config.policy.streamIdleTimeoutMs,
    signal: new AbortController().signal,
    stopAfterHandshake: true,
    onEvent: () => undefined,
    fetchImpl: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return eventStream(
        `event: connected\ndata: ${JSON.stringify({ version: 1, connection_epoch: "epoch-1" })}\n\n`,
      );
    },
  });
  assert.equal(authorization, "Bearer test-token");
  assert.equal(config.streamUrl.search, "");
  assert.equal(result.connectionEpoch, "epoch-1");
});

test("SSE client rejects wake before the fenced handshake", async () => {
  const config = testConfig();
  await assert.rejects(
    consumeBellStream({
      url: config.streamUrl,
      token: config.token,
      limits: config.policy,
      connectTimeoutMs: config.policy.connectTimeoutMs,
      idleTimeoutMs: config.policy.streamIdleTimeoutMs,
      signal: new AbortController().signal,
      onEvent: () => undefined,
      fetchImpl: async () =>
        eventStream(
          `event: wake\ndata: ${JSON.stringify({
            version: 1,
            connection_epoch: "epoch-1",
            wake_id: "wake-1",
            reason: "notification",
            message: "read state",
            created_at: "2026-08-11T00:00:00.000Z",
          })}\n\n`,
        ),
    }),
    (error: unknown) => error instanceof BellTransportError && error.kind === "protocol",
  );
});

test("SSE heartbeat comments cannot extend the connected handshake deadline", async () => {
  const config = testConfig();
  await assert.rejects(
    consumeBellStream({
      url: config.streamUrl,
      token: config.token,
      limits: config.policy,
      connectTimeoutMs: 20,
      idleTimeoutMs: 200,
      signal: new AbortController().signal,
      onEvent: () => undefined,
      fetchImpl: async (_input, init) => {
        const requestSignal = init?.signal;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const interval = setInterval(() => {
                controller.enqueue(encoder.encode(": heartbeat\n\n"));
              }, 2);
              requestSignal?.addEventListener(
                "abort",
                () => {
                  clearInterval(interval);
                  controller.error(requestSignal.reason);
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    }),
    (error: unknown) =>
      error instanceof BellTransportError && error.message === "SSE connection timed out",
  );
});

test("SSE stops parsing the current chunk when delivery applies backpressure", async () => {
  const config = testConfig();
  let wakeCount = 0;
  await assert.rejects(
    consumeBellStream({
      url: config.streamUrl,
      token: config.token,
      limits: config.policy,
      connectTimeoutMs: config.policy.connectTimeoutMs,
      idleTimeoutMs: config.policy.streamIdleTimeoutMs,
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.kind !== "wake") return;
        wakeCount += 1;
        if (wakeCount === 3) {
          throw new BellTransportError("local wake queue capacity reached", "backpressure");
        }
      },
      fetchImpl: async () =>
        eventStream(
          `event: connected\ndata: ${JSON.stringify({ version: 1, connection_epoch: "epoch-1" })}\n\n` +
            ["wake-1", "wake-2", "wake-3"]
              .map(
                (wakeId) =>
                  `event: wake\ndata: ${JSON.stringify({
                    version: 1,
                    connection_epoch: "epoch-1",
                    wake_id: wakeId,
                    reason: "notification",
                    message: "read state",
                    created_at: "2026-08-13T00:00:00.000Z",
                  })}\n\n`,
              )
              .join("") +
            "event: wake\ndata: not-json\n\n",
        ),
    }),
    (error: unknown) =>
      error instanceof BellTransportError &&
      error.kind === "backpressure" &&
      error.message === "local wake queue capacity reached",
  );
  assert.equal(wakeCount, 3);
});

test("control client retries a temporary ACK with the same wake_id", async () => {
  const config = testConfig();
  const payloads: unknown[] = [];
  const control = new BellControlClient({
    ackUrl: config.ackUrl,
    reportUrl: config.reportUrl,
    token: config.token,
    policy: config.policy,
    fetchImpl: async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return payloads.length === 1
        ? new Response(null, { status: 503 })
        : controlConfirmation("wake-1", "acked");
    },
  });
  await control.acknowledge("wake-1", "epoch-1", new AbortController().signal);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0], payloads[1]);
});

test("control client sends a terminal blocked report with its reason", async () => {
  const config = testConfig();
  let payload: unknown;
  const control = new BellControlClient({
    ackUrl: config.ackUrl,
    reportUrl: config.reportUrl,
    token: config.token,
    policy: config.policy,
    fetchImpl: async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return controlConfirmation("wake-1", "blocked");
    },
  });
  await control.report(
    {
      wakeId: "wake-1",
      connectionEpoch: "epoch-1",
      status: "blocked",
      reason: "timeout_exhausted",
      errorCode: "injector_timeout",
    },
    new AbortController().signal,
  );
  assert.deepEqual(payload, {
    version: 1,
    wake_id: "wake-1",
    connection_epoch: "epoch-1",
    status: "blocked",
    reason: "timeout_exhausted",
    error_code: "injector_timeout",
  });
});

test("control client rejects generic 2xx and mismatched confirmations", async () => {
  const config = testConfig();
  const responses = [
    new Response(null, { status: 204 }),
    controlConfirmation("another-wake", "acked"),
  ];

  for (const response of responses) {
    const control = new BellControlClient({
      ackUrl: config.ackUrl,
      reportUrl: config.reportUrl,
      token: config.token,
      policy: config.policy,
      fetchImpl: async () => response.clone(),
    });
    await assert.rejects(
      control.acknowledge("wake-1", "epoch-1", new AbortController().signal),
      (error: unknown) => error instanceof BellTransportError && error.kind === "protocol",
    );
  }
});
