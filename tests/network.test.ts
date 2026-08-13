import assert from "node:assert/strict";
import { test } from "node:test";
import { BellControlClient } from "../src/control-client.js";
import { consumeBellStream } from "../src/sse/client.js";
import { BellTransportError } from "../src/transport-error.js";
import { testConfig } from "./helpers.js";

function eventStream(text: string): Response {
  return new Response(text, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
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
      return payloads.length === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 });
    },
  });
  await control.acknowledge("wake-1", "epoch-1", new AbortController().signal);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0], payloads[1]);
});
