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

type ControlConfirmationStatus = "acked" | "blocked";

async function confirmControlResponse(
  response: Response,
  wakeId: string,
  expectedStatus: ControlConfirmationStatus,
): Promise<void> {
  if (response.status !== 200) {
    if (response.ok) {
      throw new BellTransportError("control endpoint returned an unconfirmed success", "protocol", {
        statusCode: response.status,
      });
    }
    throw httpError(response);
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new BellTransportError("control endpoint returned a non-JSON confirmation", "protocol", {
      statusCode: response.status,
    });
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new BellTransportError("control endpoint returned invalid confirmation JSON", "protocol", {
      statusCode: response.status,
      cause: error,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BellTransportError("control endpoint returned an invalid confirmation", "protocol", {
      statusCode: response.status,
    });
  }
  const confirmation = value as Record<string, unknown>;
  if (
    Object.keys(confirmation).length !== 3 ||
    confirmation.version !== BELL_PROTOCOL_VERSION ||
    confirmation.wake_id !== wakeId ||
    confirmation.status !== expectedStatus
  ) {
    throw new BellTransportError("control endpoint confirmation did not match the request", "protocol", {
      statusCode: response.status,
    });
  }
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
      wakeId,
      "acked",
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
      report.wakeId,
      "blocked",
      signal,
    );
  }

  async #post(
    url: URL,
    payload: Readonly<Record<string, unknown>>,
    wakeId: string,
    expectedStatus: ControlConfirmationStatus,
    signal: AbortSignal,
  ): Promise<void> {
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
        await confirmControlResponse(response, wakeId, expectedStatus);
        return;
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
