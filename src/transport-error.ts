export type TransportErrorKind = "retryable" | "rate_limited" | "permanent" | "protocol";

export class BellTransportError extends Error {
  readonly kind: TransportErrorKind;
  readonly retryAfterMs?: number;
  readonly statusCode?: number;

  constructor(
    message: string,
    kind: TransportErrorKind,
    details: { retryAfterMs?: number; statusCode?: number; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "BellTransportError";
    this.kind = kind;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
    if (details.statusCode !== undefined) this.statusCode = details.statusCode;
  }
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}

export function httpError(response: Response): BellTransportError {
  const statusCode = response.status;
  if (statusCode === 429) {
    const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
    return new BellTransportError("server rate limited the request", "rate_limited", {
      statusCode,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (statusCode >= 500) {
    return new BellTransportError("server returned a temporary error", "retryable", {
      statusCode,
    });
  }
  return new BellTransportError("server rejected the request", "permanent", { statusCode });
}
