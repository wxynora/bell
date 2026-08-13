import assert from "node:assert/strict";
import { test } from "node:test";
import type { ControlPort, InjectorPort } from "../src/dispatcher.js";
import { BellDispatcher } from "../src/dispatcher.js";
import type { InjectorOutcome } from "../src/injector.js";
import { silentLogger } from "../src/logging.js";
import type { WakeEvent } from "../src/protocol.js";
import type { AcceptedWakeRecord, WakeLedger } from "../src/state/ledger.js";
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
): BellDispatcher {
  return new BellDispatcher({
    ledger,
    injector,
    control,
    policy: testConfig().policy,
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
  const reports: string[] = [];
  let fatal: Error | undefined;
  const instance = dispatcher(
    ledger,
    { run: async () => ({ status: "permanent_error", errorCode: "bad_config" }) },
    {
      acknowledge: async () => undefined,
      report: async (report) => {
        reports.push(report.status);
      },
    },
    (error) => {
      fatal = error;
    },
  );
  instance.handleEvent({ kind: "connected", version: 1, connectionEpoch: "epoch-1" });
  instance.handleEvent(wake("wake-1"));
  await instance.waitForIdle();
  assert.deepEqual(reports, ["permanent_error"]);
  assert.ok(fatal);
  assert.equal(instance.fatalError, fatal);
});
