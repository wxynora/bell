import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireProcessLock, BellAlreadyRunningError } from "../src/process-lock.js";
import { SqliteWakeLedger } from "../src/state/ledger.js";

test("process lock excludes a second Bell process for the same token", () => {
  const directory = mkdtempSync(join(tmpdir(), "bell-lock-"));
  try {
    const first = acquireProcessLock(directory, "token");
    assert.throws(() => acquireProcessLock(directory, "token"), BellAlreadyRunningError);
    first.release();
    const second = acquireProcessLock(directory, "token");
    second.release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepted ledger remains idempotent and keeps an unacknowledged wake", () => {
  const directory = mkdtempSync(join(tmpdir(), "bell-ledger-"));
  try {
    const ledger = new SqliteWakeLedger(directory, 100);
    ledger.markAccepted("wake-1", "2026-08-11T00:00:00.000Z");
    ledger.markAccepted("wake-1", "2026-08-11T01:00:00.000Z");
    assert.equal(ledger.isAccepted("wake-1"), true);
    assert.deepEqual(ledger.listUnacked(), [
      { wakeId: "wake-1", acceptedAt: "2026-08-11T00:00:00.000Z" },
    ]);
    ledger.markAcked("wake-1", "2026-08-11T02:00:00.000Z");
    assert.deepEqual(ledger.listUnacked(), []);
    ledger.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
