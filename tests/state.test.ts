import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { acquireProcessLock, BellAlreadyRunningError } from "../src/process-lock.js";
import { SqliteWakeLedger } from "../src/state/ledger.js";

test("process lock excludes a second Bell process for the same state directory across token rotation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bell-lock-"));
  try {
    const first = await acquireProcessLock(directory);
    await assert.rejects(acquireProcessLock(directory), BellAlreadyRunningError);
    await first.release();
    const second = await acquireProcessLock(directory);
    await second.release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("process lock recovers a stale socket after an abrupt owner exit", async (context) => {
  if (process.platform === "win32") {
    context.skip("the abrupt SIGKILL recovery fixture is POSIX-only");
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "bell-lock-crash-"));
  const moduleUrl = pathToFileURL(join(process.cwd(), "src/process-lock.ts")).href;
  const source = `
    const { acquireProcessLock } = await import(${JSON.stringify(moduleUrl)});
    await acquireProcessLock(${JSON.stringify(directory)});
    process.stdout.write("ready\\n");
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("ready\n")) resolve();
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        reject(new Error(`lock owner exited before readiness: ${String(code ?? signal)} ${stderr}`));
      });
    });

    child.kill("SIGKILL");
    await once(child, "exit");
    const recovered = await acquireProcessLock(directory);
    await recovered.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepted ledger remains idempotent and keeps an unacknowledged wake", () => {
  const directory = mkdtempSync(join(tmpdir(), "bell-ledger-"));
  try {
    const ledger = new SqliteWakeLedger(directory, 100, 180);
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

test("accepted ledger prunes only acknowledged wakes older than retention", () => {
  const directory = mkdtempSync(join(tmpdir(), "bell-ledger-retention-"));
  try {
    const ledger = new SqliteWakeLedger(directory, 100, 180);
    ledger.markAccepted("old-acked", "2025-01-01T00:00:00.000Z");
    ledger.markAcked("old-acked", "2025-01-02T00:00:00.000Z");
    ledger.markAccepted("old-unacked", "2025-01-01T00:00:00.000Z");
    ledger.markAccepted("current", "2026-01-01T00:00:00.000Z");
    ledger.markAcked("current", "2026-01-01T00:00:00.000Z");

    assert.equal(ledger.isAccepted("old-acked"), false);
    assert.equal(ledger.isAccepted("old-unacked"), true);
    assert.equal(ledger.isAccepted("current"), true);
    assert.deepEqual(ledger.listUnacked(), [
      { wakeId: "old-unacked", acceptedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    ledger.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
