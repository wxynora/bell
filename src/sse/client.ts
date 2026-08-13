import type { ProtocolLimits } from "../config.js";
import { BellProtocolError, decodeBellEvent, type BellEvent } from "../protocol.js";
import { BellTransportError, httpError } from "../transport-error.js";
import { SseParseError, SseParser } from "./parser.js";

export interface BellStreamOptions {
  url: URL;
  token: string;
  limits: ProtocolLimits;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  signal: AbortSignal;
  stopAfterHandshake?: boolean;
  onEvent(event: BellEvent): void;
  onHeartbeat?(): void;
  fetchImpl?: typeof fetch;
}

export interface BellStreamResult {
  connectionEpoch: string;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export async function consumeBellStream(options: BellStreamOptions): Promise<BellStreamResult> {
  if (options.signal.aborted) throw options.signal.reason;
  const requestController = new AbortController();
  let timeoutKind: "connect" | "idle" | undefined;
  let timer: NodeJS.Timeout | undefined;
  const parentAbort = (): void => requestController.abort(options.signal.reason);
  options.signal.addEventListener("abort", parentAbort, { once: true });

  const armTimeout = (kind: "connect" | "idle", milliseconds: number): void => {
    if (timer !== undefined) clearTimeout(timer);
    timeoutKind = kind;
    timer = setTimeout(() => requestController.abort(abortError(`${kind} timeout`)), milliseconds);
    timer.unref?.();
  };

  try {
    armTimeout("connect", options.connectTimeoutMs);
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(options.url, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${options.token}`,
          "cache-control": "no-cache",
        },
        redirect: "manual",
        signal: requestController.signal,
      });
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason;
      if (requestController.signal.aborted && timeoutKind === "connect") {
        throw new BellTransportError("SSE connection timed out", "retryable", { cause: error });
      }
      throw new BellTransportError("SSE connection failed", "retryable", { cause: error });
    }
    if (!response.ok) throw httpError(response);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("text/event-stream")) {
      throw new BellTransportError("SSE response has the wrong content type", "protocol");
    }
    if (response.body === null) {
      throw new BellTransportError("SSE response body is missing", "protocol");
    }

    let connectedEpoch: string | undefined;
    const decodedEvents: BellEvent[] = [];
    const parser = new SseParser(
      {
        onComment: () => options.onHeartbeat?.(),
        onEvent: (event) => {
          const decoded = decodeBellEvent(event, options.limits);
          if (decoded !== undefined) decodedEvents.push(decoded);
        },
      },
      options.limits.maxEventBytes,
    );
    const reader = response.body.getReader();
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (options.signal.aborted) throw options.signal.reason;
        if (requestController.signal.aborted && timeoutKind === "connect") {
          throw new BellTransportError("SSE connection timed out", "retryable", { cause: error });
        }
        if (requestController.signal.aborted && timeoutKind === "idle") {
          throw new BellTransportError("SSE stream became idle", "retryable", { cause: error });
        }
        throw new BellTransportError("SSE stream read failed", "retryable", { cause: error });
      }
      if (result.done) {
        parser.finish();
        throw new BellTransportError("SSE stream ended", "retryable");
      }
      if (connectedEpoch !== undefined) armTimeout("idle", options.idleTimeoutMs);
      try {
        parser.push(result.value);
        while (decodedEvents.length > 0) {
          const event = decodedEvents.shift();
          if (event === undefined) break;
          if (connectedEpoch === undefined) {
            if (event.kind !== "connected") {
              throw new BellProtocolError("first Bell event must be connected");
            }
            connectedEpoch = event.connectionEpoch;
            armTimeout("idle", options.idleTimeoutMs);
          } else {
            if (event.kind === "connected") {
              throw new BellProtocolError("connected event was repeated on one stream");
            }
            if (event.connectionEpoch !== connectedEpoch) {
              throw new BellProtocolError("event connection_epoch does not match the stream");
            }
          }
          options.onEvent(event);
          if (event.kind === "connected" && options.stopAfterHandshake) {
            await reader.cancel();
            return { connectionEpoch: event.connectionEpoch };
          }
        }
      } catch (error) {
        if (error instanceof BellProtocolError || error instanceof SseParseError) {
          throw new BellTransportError(error.message, "protocol", { cause: error });
        }
        throw error;
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal.removeEventListener("abort", parentAbort);
  }
}
