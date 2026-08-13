import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBellEvent } from "../src/protocol.js";
import { SseParseError, SseParser, type SseEvent } from "../src/sse/parser.js";
import { testConfig } from "./helpers.js";

test("SSE parser accepts a large chunk containing several individually bounded events", () => {
  const events: SseEvent[] = [];
  const parser = new SseParser({ onEvent: (event) => events.push(event) }, 48);
  parser.push(
    Buffer.from("event: one\ndata: {\"x\":1}\n\nevent: two\ndata: {\"x\":2}\n\n", "utf8"),
  );
  assert.deepEqual(
    events.map((event) => event.event),
    ["one", "two"],
  );
});

test("SSE parser rejects one oversized event", () => {
  const parser = new SseParser({ onEvent: () => undefined }, 16);
  assert.throws(() => parser.push(Buffer.from(`data: ${"x".repeat(32)}\n\n`)), SseParseError);
});

test("wake decoder preserves the fenced delivery fields", () => {
  const decoded = decodeBellEvent(
    {
      event: "wake",
      data: JSON.stringify({
        version: 1,
        connection_epoch: "epoch-1",
        wake_id: "wake-1",
        reason: "notification",
        message: "请读取铃野中的待处理通知。",
        created_at: "2026-08-11T00:00:00.000Z",
      }),
    },
    testConfig().policy,
  );
  assert.deepEqual(decoded, {
    kind: "wake",
    version: 1,
    connectionEpoch: "epoch-1",
    wakeId: "wake-1",
    reason: "notification",
    message: "请读取铃野中的待处理通知。",
    createdAt: "2026-08-11T00:00:00.000Z",
  });
});
