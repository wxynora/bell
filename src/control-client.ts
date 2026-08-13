import type { BellPolicy } from "./config.js";
import { delay } from "./delay.js";
import { BELL_PROTOCOL_VERSION } from "./protocol.js";
import { BellTransportError, httpError } from "./transport-error.js";

export type WakeBlockReason =
  | "busy_exhausted"
  | "retryable_exhausted"
  | "timeout_exhausted"
  | "permanent_error";

export interface WakeReport {
  wakeId: string;
  connectionEpoch: string;
  status: "blocked";
  reason: WakeBlockReason;
  errorCode: string;
}

export interface ControlClientOptions {
  ackUrl: URL;
  reportUrl: URL;
  token: string;
  policy: Pick<BellPolicy, "httpTimeoutMs" | "httpMaxAttempts" | "httpRetryDelayMs">;
  fetchImpl?: typeof fetch;
}

export class BellControlClient {
  readonly #options: ControlClientOptions;

  constructor(options: ControlClientOptions) {
    this.#options = options;
  }

  async acknowledge(wakeId: string, connectionEpoch: string, signal: AbortSignal): Promise<void> {
    await this.#post(
      this.#options.ackUrl,
      {
        version: BELL_PROTOCOL_VERSION,
        wake_id: wakeId,
        connection_epoch: connectionEpoch,
      },
      signal,
    );
  }

  async report(report: WakeReport, signal: AbortSignal): Promise<void> {
    await this.#post(
      this.#options.reportUrl,
      {
        version: BELL_PROTOCOL_VERSION,
        wake_id: report.wakeId,
        connection_epoch: report.connectionEpoch,
        status: report.status,
        reason: report.reason,
        error_code: report.errorCode,
      },
      signal,
    );
  }

  async #post(url: URL, payload: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<void> {
    let lastError: BellTransportError | undefined;
    for (let attempt = 1; attempt <= this.#options.policy.httpMaxAttempts; attempt += 1) {
      if (signal.aborted) throw signal.reason;
      const requestController = new AbortController();
      let timedOut = false;
      const parentAbort = (): void => requestController.abort(signal.reason);
      signal.addEventListener("abort", parentAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        requestController.abort();
      }, this.#options.policy.httpTimeoutMs);
      timer.unref?.();
      try {
        const response = await (this.#options.fetchImpl ?? fetch)(url, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.#options.token}`,
            "content-type": "application/json",
          },
          redirect: "manual",
          body: JSON.stringify(payload),
          signal: requestController.signal,
        });
        if (response.ok) return;
        throw httpError(response);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof BellTransportError) lastError = error;
        else {
          lastError = new BellTransportError(
            timedOut ? "control request timed out" : "control request failed",
            "retryable",
            { cause: error },
          );
        }
        if (lastError.kind === "permanent" || lastError.kind === "protocol") throw lastError;
        if (attempt === this.#options.policy.httpMaxAttempts) throw lastError;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", parentAbort);
      }
      const waitMs = lastError?.retryAfterMs ?? this.#options.policy.httpRetryDelayMs;
      await delay(waitMs, signal);
    }
    throw lastError ?? new BellTransportError("control request failed", "retryable");
  }
}
