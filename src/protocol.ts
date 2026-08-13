import type { ProtocolLimits } from "./config.js";
import type { SseEvent } from "./sse/parser.js";

export const BELL_PROTOCOL_VERSION = 1 as const;

export interface ConnectedEvent {
  kind: "connected";
  version: 1;
  connectionEpoch: string;
}

export interface WakeEvent {
  kind: "wake";
  version: 1;
  connectionEpoch: string;
  wakeId: string;
  reason: string;
  message: string;
  createdAt: string;
}

export interface CancelEvent {
  kind: "cancel";
  version: 1;
  connectionEpoch: string;
  wakeId: string;
}

export type BellEvent = ConnectedEvent | WakeEvent | CancelEvent;

export class BellProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BellProtocolError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BellProtocolError("event data must be an object");
  }
  return value as Record<string, unknown>;
}

function parseData(event: SseEvent): Record<string, unknown> {
  try {
    return record(JSON.parse(event.data));
  } catch (error) {
    if (error instanceof BellProtocolError) throw error;
    throw new BellProtocolError(`${event.event} data is not valid JSON`);
  }
}

function version(value: unknown): 1 {
  if (value !== BELL_PROTOCOL_VERSION) {
    throw new BellProtocolError("unsupported protocol version");
  }
  return BELL_PROTOCOL_VERSION;
}

function boundedText(name: string, value: unknown, maxChars: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars ||
    value.trim() !== value
  ) {
    throw new BellProtocolError(`${name} is invalid`);
  }
  return value;
}

function message(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxChars) {
    throw new BellProtocolError("message is invalid");
  }
  return value;
}

export function decodeBellEvent(event: SseEvent, limits: ProtocolLimits): BellEvent | undefined {
  if (event.event !== "connected" && event.event !== "wake" && event.event !== "cancel") {
    return undefined;
  }
  const data = parseData(event);
  const eventVersion = version(data.version);
  const connectionEpoch = boundedText(
    "connection_epoch",
    data.connection_epoch,
    limits.maxEpochChars,
  );
  if (event.event === "connected") {
    return { kind: "connected", version: eventVersion, connectionEpoch };
  }
  const wakeId = boundedText("wake_id", data.wake_id, limits.maxWakeIdChars);
  if (event.event === "cancel") {
    return { kind: "cancel", version: eventVersion, connectionEpoch, wakeId };
  }
  return {
    kind: "wake",
    version: eventVersion,
    connectionEpoch,
    wakeId,
    reason: boundedText("reason", data.reason, limits.maxReasonChars),
    message: message(data.message, limits.maxMessageChars),
    createdAt: boundedText("created_at", data.created_at, limits.maxTimestampChars),
  };
}
