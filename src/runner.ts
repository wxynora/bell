import { performance } from "node:perf_hooks";
import type { BellConfig } from "./config.js";
import { BellControlClient } from "./control-client.js";
import { delay } from "./delay.js";
import { BellDispatcher } from "./dispatcher.js";
import { runInjector, type InjectorOutcome } from "./injector.js";
import type { Logger } from "./logging.js";
import { acquireProcessLock } from "./process-lock.js";
import type { WakeEvent } from "./protocol.js";
import { consumeBellStream } from "./sse/client.js";
import { SqliteWakeLedger } from "./state/ledger.js";
import { BellTransportError } from "./transport-error.js";

export interface BellRuntimeDependencies {
  logger: Logger;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  injectorRun?: (wake: WakeEvent, signal: AbortSignal) => Promise<InjectorOutcome>;
  random?: () => number;
  now?: () => number;
}

function reconnectDelay(baseMs: number, jitterRatio: number, random: () => number): number {
  const jitter = baseMs * jitterRatio * (random() * 2 - 1);
  return Math.ceil(baseMs + jitter);
}

export async function runBell(
  config: BellConfig,
  dependencies: BellRuntimeDependencies,
): Promise<void> {
  const processLock = acquireProcessLock(config.stateDirectory, config.token);
  let ledger: SqliteWakeLedger | undefined;
  let sessionController: AbortController | undefined;
  try {
    ledger = new SqliteWakeLedger(
      config.stateDirectory,
      config.policy.sqliteBusyTimeoutMs,
      config.policy.acceptedRetentionDays,
    );
    const control = new BellControlClient({
      ackUrl: config.ackUrl,
      reportUrl: config.reportUrl,
      token: config.token,
      policy: config.policy,
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    });
    const injectorRun =
      dependencies.injectorRun ??
      ((wake: WakeEvent, signal: AbortSignal) =>
        runInjector({ injector: config.injector, policy: config.policy }, wake, signal));
    const dispatcher = new BellDispatcher({
      ledger,
      control,
      injector: { run: injectorRun },
      policy: config.policy,
      logger: dependencies.logger,
      signal: dependencies.signal,
      onFatal: (error) => sessionController?.abort(error),
    });

    let reconnects = 0;
    let backoffMs = config.policy.reconnectInitialMs;
    const now = dependencies.now ?? (() => performance.now());
    while (!dependencies.signal.aborted) {
      sessionController = new AbortController();
      let connectedAt: number | undefined;
      let streamEndedAt: number | undefined;
      const abortSession = (): void => sessionController?.abort(dependencies.signal.reason);
      dependencies.signal.addEventListener("abort", abortSession, { once: true });
      let streamError: unknown;
      try {
        await consumeBellStream({
          url: config.streamUrl,
          token: config.token,
          limits: config.policy,
          connectTimeoutMs: config.policy.connectTimeoutMs,
          idleTimeoutMs: config.policy.streamIdleTimeoutMs,
          signal: sessionController.signal,
          onEvent: (event) => {
            if (event.kind === "connected") connectedAt = now();
            dispatcher.handleEvent(event);
          },
          onHeartbeat: () => dependencies.logger.debug("SSE heartbeat received"),
          ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
        });
      } catch (error) {
        streamError = error;
      } finally {
        streamEndedAt = now();
        dependencies.signal.removeEventListener("abort", abortSession);
      }

      await dispatcher.waitForIdle();
      if (dependencies.signal.aborted) return;
      if (dispatcher.fatalError !== undefined) throw dispatcher.fatalError;
      if (
        !(streamError instanceof BellTransportError) ||
        (streamError.kind !== "retryable" && streamError.kind !== "rate_limited")
      ) {
        throw streamError;
      }
      if (
        connectedAt !== undefined &&
        streamEndedAt !== undefined &&
        streamEndedAt - connectedAt >= config.policy.streamIdleTimeoutMs
      ) {
        reconnects = 0;
        backoffMs = config.policy.reconnectInitialMs;
        dependencies.logger.info("stable SSE session reset the consecutive reconnect budget");
      }
      if (reconnects >= config.policy.reconnectMaxAttempts) {
        throw new BellTransportError("SSE reconnect budget exhausted", "permanent", {
          cause: streamError,
        });
      }

      const waitMs =
        streamError.retryAfterMs ??
        reconnectDelay(
          backoffMs,
          config.policy.reconnectJitterRatio,
          dependencies.random ?? Math.random,
        );
      reconnects += 1;
      dependencies.logger.warn("SSE disconnected; bounded reconnect scheduled", {
        reconnect_attempt: reconnects,
        wait_ms: waitMs,
      });
      await delay(waitMs, dependencies.signal);
      backoffMs = Math.min(config.policy.reconnectMaxMs, backoffMs * 2);
    }
  } finally {
    sessionController?.abort();
    ledger?.close();
    processLock.release();
  }
}

export async function checkBellConnection(
  config: BellConfig,
  dependencies: Pick<BellRuntimeDependencies, "logger" | "signal" | "fetchImpl">,
): Promise<void> {
  const processLock = acquireProcessLock(config.stateDirectory, config.token);
  try {
    const result = await consumeBellStream({
      url: config.streamUrl,
      token: config.token,
      limits: config.policy,
      connectTimeoutMs: config.policy.connectTimeoutMs,
      idleTimeoutMs: config.policy.streamIdleTimeoutMs,
      signal: dependencies.signal,
      stopAfterHandshake: true,
      onEvent: () => undefined,
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    });
    dependencies.logger.info("Bell connection check succeeded", {
      connection_epoch_present: result.connectionEpoch.length > 0,
    });
  } finally {
    processLock.release();
  }
}
