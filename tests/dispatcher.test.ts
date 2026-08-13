import assert from "node:assert/strict";
import { test } from "node:test";
import type { ControlPort, InjectorPort } from "../src/dispatcher.js";
import { BellDispatcher } from "../src/dispatcher.js";
import type { InjectorOutcome } from "../src/injector.js";
import { silentLogger } from "../src/logging.js";
import type { WakeEvent } from "../src/protocol.js";
import type { AcceptedWakeRecord, WakeLedger } from "../src/state/ledger.js";
import { BellTransportError } from "../src/transport-error.js";
import { testConfig } from "./helpers.js";

class MemoryLedger implements WakeLedger {
  readonly accepted = new Set<string>();
  readonly acked = new Set<string>();
  isAccepted(wakeId: string): boolean {
    return this.accepted.has(wakeId);
  }
  markAccepted(wakeId: string): void {
    this.accepted.add(wakeId);
  }
  markAcked(wakeId: string): void {
    this.acked.add(wakeId);
  }
  listUnacked(): AcceptedWakeRecord[] {
    return [];
  }
  close(): void {}
}

function wake(wakeId: string): WakeEvent {
  return {
    kind: "wake",
    version: 1,
    connectionEpoch: "epoch-1",
    wakeId,
    reason: "notification",
    message: "read authoritative state",
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

function dispatcher(
  ledger: MemoryLedger,
  injector: InjectorPort,
  control: ControlPort,
  onFatal: (error: Error) => void = () => undefined,
  policy = testConfig().policy,
): BellDispatcher {
  return new BellDispatcher({
    ledger,
    injector,
    control,
    policy,
    logger: silentLogger,
    signal: new AbortController().signal,
    onFatal,
  });
}

test("accepted ledger is written before ACK and redelivery only repeats ACK", async () => {
  const ledger = new MemoryLedger();
  let injectorCalls = 0;
  let ackCalls = 0;
  const instance = dispatcher(
    ledger,
    {
      run: async () => {
        injectorCalls += 1;
        return { status: "accepted" };
      },
    },
    {
      acknowledge: async (wakeId) => {
        assert.equal(ledger.isAccepted(wakeId), true);
        ackCalls += 1;
      },
      report: async () => undefined,
    },
  );
  instance.handleEvent({ kind: "connected", version: 1, connectionEpoch: "epoch-1" });
  instance.handleEvent(wake("wake-1"));
  await instance.waitForIdle();
  instance.handleEvent(wake("wake-1"));
  await instance.waitForIdle();
  assert.equal(injectorCalls, 1);
  assert.equal(ackCalls, 2);
  assert.equal(ledger.acked.has("wake-1"), true);
});

test("cancel removes a queued wake but does not kill the active injector", async () => {
  const ledger = new MemoryLedger();
  let release: ((outcome: InjectorOutcome) => void) | undefined;
  const seen: string[] = [];
  const instance = dispatcher(
    ledger,
    {
      run: async (item) => {
        seen.push(item.wakeId);
        return await new Promise<InjectorOutcome>((resolve) => {
          release = resolve;
        });
      },
    },
    { acknowledge: async () => undefined, report: async () => undefined },
  );
  instance.handleEvent({ kind: "connected", version: 1, connectionEpoch: "epoch-1" });
  instance.handleEvent(wake("wake-active"));
  instance.handleEvent(wake("wake-queued"));
  instance.handleEvent({
    kind: "cancel",
    version: 1,
    connectionEpoch: "epoch-1",
    wakeId: "wake-queued",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(release);
  release({ status: "accepted" });
  await instance.waitForIdle();
  assert.deepEqual(seen, ["wake-active"]);
});

test("permanent injector error reports and blocks the dispatcher", async () => {
  const ledger = new MemoryLedger();
  const reports: Array<{ status: string; reason: string }> = [];
  let fatal: Error | undefined;
  const instance = dispatcher(
    ledger,
    { run: async () => ({ status: "permanent_error", errorCode: "bad_config" }) },
    {
      acknowledge: async () => undefined,
      report: async (report) => {
        reports.push({ status: report.status, reason: report.reason });
      },
    },
    (error) => {
      fatal = error;
    },
  );
  instance.handleEvent({ kind: "connected", version: 1, connectionEpoch: "epoch-1" });
  instance.handleEvent(wake("wake-1"));
  await instance.waitForIdle();
  assert.deepEqual(reports, [{ status: "blocked", reason: "permanent_error" }]);
  assert.ok(fatal);
  assert.equal(instance.fatalError, fatal);
});

test("queue capacity rejects a new wake and cancelled entries release capacity", async () => {
  const ledger = new MemoryLedger();
  let release: ((outcome: InjectorOutcome) => void) | undefined;
  const seen: string[] = [];
  const instance = dispatcher(
    ledger,
    {
      run: async (item) => {
        seen.push(item.wakeId);
        if (item.wakeId === "wake-active") {
          return await new Promise<InjectorOutcome>((resolve) => {
            release = resolve;
          });
        }
        return { status: "accepted" };
      },
    },
    { acknowledge: async () => undefined, report: async () => undefined },
    () => undefined,
    { ...testConfig().policy, maxPendingWakes: 2 },
  );
  instance.handleEvent({ kind: "connected", version: 1, connectionEpoch: "epoch-1" });
  instance.handleEvent(wake("wake-active"));
  instance.handleEvent(wake("wake-queued"));
  assert.throws(
    () => instance.handleEvent(wake("wake-overflow")),
    (error: unknown) =>
      error instanceof BellTransportError && error.message === "local wake queue capacity reached",
  );
  instance.handleEvent({
    kind: "cancel",
    version: 1,
    connectionEpoch: "epoch-1",
    wakeId: "wake-queued",
  });
  instance.handleEvent(wake("wake-after-cancel"));
  assert.ok(release);
  release({ status: "accepted" });
  await instance.waitForIdle();
  assert.deepEqual(seen, ["wake-active", "wake-after-cancel"]);
});

test("an unconfirmed blocked report stops the dispatcher", async () => {
  const ledger = new MemoryLedger();
  let fatal: Error | undefined;
  const instance = dispatcher(
    ledger,
    { run: async () => ({ status: "busy" }) },
    {
      acknowledge: async () => undefined,
      report: async () => {
        throw new BellTransportError("report failed", "retryable");
      },
    },
    (error) => {
      fatal = error;
    },
  );
  instance.handleEvent({ kind: "connected", version: 1, connectionEpoch: "epoch-1" });
  instance.handleEvent(wake("wake-1"));
  await instance.waitForIdle();
  assert.ok(fatal);
  assert.equal(instance.fatalError, fatal);
});

test("exhausted local outcomes report terminal blocked reasons without ACK", async () => {
  const cases: Array<{
    outcome: InjectorOutcome;
    reason: "busy_exhausted" | "retryable_exhausted" | "timeout_exhausted";
    errorCode: string;
  }> = [
    { outcome: { status: "busy" }, reason: "busy_exhausted", errorCode: "injector_busy" },
    {
      outcome: { status: "retryable_error", errorCode: "runtime_temporary" },
      reason: "retryable_exhausted",
      errorCode: "runtime_temporary",
    },
    {
      outcome: { status: "timeout", errorCode: "injector_timeout" },
      reason: "timeout_exhausted",
      errorCode: "injector_timeout",
    },
  ];
  for (const item of cases) {
    const ledger = new MemoryLedger();
    let acknowledgements = 0;
    const reports: Array<{ status: string; reason: string; errorCode: string }> = [];
    const instance = dispatcher(
      ledger,
      { run: async () => item.outcome },
      {
        acknowledge: async () => {
          acknowledgements += 1;
        },
        report: async (report) => {
          reports.push({
            status: report.status,
            reason: report.reason,
            errorCode: report.errorCode,
          });
        },
      },
    );
    instance.handleEvent({ kind: "connected", version: 1, connectionEpoch: "epoch-1" });
    instance.handleEvent(wake(`wake-${item.reason}`));
    await instance.waitForIdle();
    assert.equal(acknowledgements, 0);
    assert.deepEqual(reports, [
      { status: "blocked", reason: item.reason, errorCode: item.errorCode },
    ]);
  }
});
