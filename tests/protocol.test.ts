import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("Bell decodes the fixed ordinary wake fixture serialized by Doorbell", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/doorbell-wake-v1.json", import.meta.url), "utf8"),
  ) as { event: string; data: Record<string, unknown> };
  const decoded = decodeBellEvent(
    { event: fixture.event, data: JSON.stringify(fixture.data) },
    testConfig().policy,
  );
  assert.deepEqual(decoded, {
    kind: "wake",
    version: 1,
    connectionEpoch: "epoch-purchase-1",
    wakeId: "purchase-wake-1",
    reason: "farm_purchase_request",
    message: "【📢来自铃野的通知】\n你的人类辛玥想要你给她买农场商店的普通种子 × 2。",
    createdAt: "1970-01-01T00:00:04.000Z",
  });
});

test("Bell decodes Main career and purchase wakes without character limits", () => {
  const fixtures = JSON.parse(
    readFileSync(new URL("./fixtures/doorbell-unbounded-wakes-v1.json", import.meta.url), "utf8"),
  ) as Array<{ event: string; data: Record<string, unknown> }>;
  assert.ok(String(fixtures[0]?.data.wake_id).length > 128);
  assert.ok(String(fixtures[0]?.data.message).length > 512);
  assert.ok(String(fixtures[1]?.data.message).length > 512);
  for (const fixture of fixtures) {
    const decoded = decodeBellEvent(
      { event: fixture.event, data: JSON.stringify(fixture.data) },
      testConfig().policy,
    );
    assert.deepEqual(decoded, {
      kind: "wake",
      version: 1,
      connectionEpoch: fixture.data.connection_epoch,
      wakeId: fixture.data.wake_id,
      reason: fixture.data.reason,
      message: fixture.data.message,
      createdAt: fixture.data.created_at,
    });
  }
});

test("update-available decoder accepts only the shared-meme local data signal", () => {
  const decoded = decodeBellEvent(
    {
      event: "update_available",
      data: JSON.stringify({
        version: 1,
        connection_epoch: "epoch-1",
        resource: "shared_meme",
        available_version: 318,
      }),
    },
    testConfig().policy,
  );
  assert.deepEqual(decoded, {
    kind: "update_available",
    version: 1,
    connectionEpoch: "epoch-1",
    resource: "shared_meme",
    availableVersion: 318,
  });
  assert.throws(
    () =>
      decodeBellEvent(
        {
          event: "update_available",
          data: JSON.stringify({
            version: 1,
            connection_epoch: "epoch-1",
            resource: "mailbox",
            available_version: 1,
          }),
        },
        testConfig().policy,
      ),
    /update resource is invalid/u,
  );
});
