import type { BellPolicy } from "./config.js";
import type { BellControlClient, WakeReportStatus } from "./control-client.js";
import { delay } from "./delay.js";
import type { InjectorOutcome } from "./injector.js";
import type { Logger } from "./logging.js";
import { safeId } from "./logging.js";
import { BellProtocolError, type BellEvent, type WakeEvent } from "./protocol.js";
import type { WakeLedger } from "./state/ledger.js";
import { BellTransportError } from "./transport-error.js";

export interface InjectorPort {
  run(wake: WakeEvent, signal: AbortSignal): Promise<InjectorOutcome>;
}

export interface ControlPort {
  acknowledge(wakeId: string, connectionEpoch: string, signal: AbortSignal): Promise<void>;
  report(
    report: Parameters<BellControlClient["report"]>[0],
    signal: AbortSignal,
  ): Promise<void>;
}

export interface DispatcherOptions {
  ledger: WakeLedger;
  control: ControlPort;
  injector: InjectorPort;
  policy: Pick<
    BellPolicy,
    | "injectorMaxAttempts"
    | "injectorRetryDelayMs"
    | "busyRetryDelayMs"
    | "busyMaxAttempts"
  >;
  logger: Logger;
  signal: AbortSignal;
  onFatal(error: Error): void;
}

interface QueueItem {
  wake: WakeEvent;
  ackOnly: boolean;
  cancelled: boolean;
}

export class BellDispatcherFatalError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BellDispatcherFatalError";
  }
}

export class BellDispatcher {
  readonly #options: DispatcherOptions;
  readonly #queue: QueueItem[] = [];
  readonly #queuedByWakeId = new Map<string, QueueItem>();
  readonly #idleWaiters = new Set<() => void>();
  #connectionEpoch: string | undefined;
  #active: QueueItem | undefined;
  #pumping = false;
  #fatal: Error | undefined;

  constructor(options: DispatcherOptions) {
    this.#options = options;
  }

  handleEvent(event: BellEvent): void {
    if (this.#fatal !== undefined) throw this.#fatal;
    if (event.kind === "connected") {
      if (this.#active !== undefined || this.#queue.length > 0) {
        throw new BellProtocolError("cannot replace connection_epoch while wake work is pending");
      }
      this.#connectionEpoch = event.connectionEpoch;
      this.#options.logger.info("SSE handshake accepted", {
        connection_epoch: safeId(event.connectionEpoch),
      });
      return;
    }
    if (event.connectionEpoch !== this.#connectionEpoch) {
      throw new BellProtocolError("wake event does not belong to the active connection_epoch");
    }
    if (event.kind === "cancel") {
      this.#cancel(event.wakeId);
      return;
    }
    this.#enqueue(event);
  }

  async waitForIdle(): Promise<void> {
    if (this.#fatal !== undefined) return;
    if (!this.#pumping && this.#active === undefined && this.#queue.length === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  get fatalError(): Error | undefined {
    return this.#fatal;
  }

  #enqueue(wake: WakeEvent): void {
    if (this.#queuedByWakeId.has(wake.wakeId) || this.#active?.wake.wakeId === wake.wakeId) {
      this.#options.logger.debug("duplicate pending wake ignored", { wake: safeId(wake.wakeId) });
      return;
    }
    const item: QueueItem = {
      wake,
      ackOnly: this.#options.ledger.isAccepted(wake.wakeId),
      cancelled: false,
    };
    this.#queue.push(item);
    this.#queuedByWakeId.set(wake.wakeId, item);
    this.#startPump();
  }

  #cancel(wakeId: string): void {
    const queued = this.#queuedByWakeId.get(wakeId);
    if (queued !== undefined) {
      queued.cancelled = true;
      this.#queuedByWakeId.delete(wakeId);
      this.#options.logger.info("queued wake cancelled", { wake: safeId(wakeId) });
      return;
    }
    if (this.#active?.wake.wakeId === wakeId) {
      this.#active.cancelled = true;
      this.#options.logger.info("active wake cancellation recorded; injector is not retracted", {
        wake: safeId(wakeId),
      });
    }
  }

  #startPump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    void this.#pump()
      .catch((error: unknown) => this.#setFatal(error))
      .finally(() => {
        this.#pumping = false;
        this.#active = undefined;
        if (this.#queue.length > 0 && this.#fatal === undefined) this.#startPump();
        else this.#resolveIdle();
      });
  }

  async #pump(): Promise<void> {
    while (this.#queue.length > 0 && this.#fatal === undefined) {
      const item = this.#queue.shift();
      if (item === undefined) break;
      if (this.#queuedByWakeId.get(item.wake.wakeId) === item) {
        this.#queuedByWakeId.delete(item.wake.wakeId);
      }
      if (item.cancelled) continue;
      this.#active = item;
      if (item.ackOnly) await this.#acknowledge(item.wake);
      else await this.#deliver(item);
      this.#active = undefined;
    }
  }

  async #deliver(item: QueueItem): Promise<void> {
    let busyAttempts = 0;
    let retryableAttempts = 0;
    while (!this.#options.signal.aborted) {
      const outcome = await this.#options.injector.run(item.wake, this.#options.signal);
      if (outcome.status === "accepted") {
        this.#options.ledger.markAccepted(item.wake.wakeId);
        await this.#acknowledge(item.wake);
        return;
      }
      if (outcome.status === "permanent_error") {
        await this.#report(item.wake, "permanent_error", outcome.errorCode);
        throw new BellDispatcherFatalError("injector reported a permanent error");
      }
      if (item.cancelled) return;
      if (outcome.status === "busy") {
        busyAttempts += 1;
        if (busyAttempts >= this.#options.policy.busyMaxAttempts) {
          await this.#report(item.wake, "busy", "injector_busy");
          return;
        }
        await delay(this.#options.policy.busyRetryDelayMs, this.#options.signal);
        continue;
      }
      retryableAttempts += 1;
      const reportStatus: WakeReportStatus =
        outcome.status === "timeout" ? "timeout" : "retryable_error";
      if (retryableAttempts >= this.#options.policy.injectorMaxAttempts) {
        await this.#report(item.wake, reportStatus, outcome.errorCode);
        return;
      }
      await delay(this.#options.policy.injectorRetryDelayMs, this.#options.signal);
    }
    throw this.#options.signal.reason;
  }

  async #acknowledge(wake: WakeEvent): Promise<void> {
    try {
      await this.#options.control.acknowledge(
        wake.wakeId,
        wake.connectionEpoch,
        this.#options.signal,
      );
      this.#options.ledger.markAcked(wake.wakeId);
      this.#options.logger.info("wake acknowledged", { wake: safeId(wake.wakeId) });
    } catch (error) {
      if (this.#isFatalControlError(error)) {
        throw new BellDispatcherFatalError("server permanently rejected wake ACK", {
          cause: error,
        });
      }
      this.#options.logger.warn("wake ACK remains pending", { wake: safeId(wake.wakeId) });
    }
  }

  async #report(wake: WakeEvent, status: WakeReportStatus, errorCode: string): Promise<void> {
    try {
      await this.#options.control.report(
        {
          wakeId: wake.wakeId,
          connectionEpoch: wake.connectionEpoch,
          status,
          errorCode,
        },
        this.#options.signal,
      );
    } catch (error) {
      if (this.#isFatalControlError(error)) {
        throw new BellDispatcherFatalError("server permanently rejected wake report", {
          cause: error,
        });
      }
      this.#options.logger.warn("wake failure report could not be delivered", {
        wake: safeId(wake.wakeId),
        status,
      });
    }
  }

  #isFatalControlError(error: unknown): boolean {
    return (
      error instanceof BellTransportError &&
      (error.kind === "permanent" || error.kind === "protocol")
    );
  }

  #setFatal(error: unknown): void {
    if (this.#fatal !== undefined) return;
    this.#fatal =
      error instanceof Error
        ? error
        : new BellDispatcherFatalError("dispatcher failed with a non-error value");
    this.#queue.length = 0;
    this.#queuedByWakeId.clear();
    this.#options.onFatal(this.#fatal);
  }

  #resolveIdle(): void {
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}
