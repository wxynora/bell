import { isAbsolute } from "node:path";
import type { LogLevel } from "./logging.js";

export interface ProtocolLimits {
  maxEventBytes: number;
  maxWakeIdChars: number;
  maxReasonChars: number;
  maxMessageChars: number;
  maxTimestampChars: number;
  maxEpochChars: number;
  maxErrorCodeChars: number;
  maxInjectorOutputBytes: number;
}

export interface BellPolicy extends ProtocolLimits {
  connectTimeoutMs: number;
  streamIdleTimeoutMs: number;
  httpTimeoutMs: number;
  httpMaxAttempts: number;
  httpRetryDelayMs: number;
  reconnectInitialMs: number;
  reconnectMaxMs: number;
  reconnectMaxAttempts: number;
  reconnectJitterRatio: number;
  injectorTimeoutMs: number;
  injectorKillGraceMs: number;
  injectorMaxAttempts: number;
  injectorRetryDelayMs: number;
  busyRetryDelayMs: number;
  busyMaxAttempts: number;
  maxPendingWakes: number;
  sqliteBusyTimeoutMs: number;
  acceptedRetentionDays: number;
}

export interface InjectorConfig {
  executable: string;
  args: readonly string[];
  workingDirectory?: string;
}

export interface BellConfig {
  streamUrl: URL;
  ackUrl: URL;
  reportUrl: URL;
  token: string;
  stateDirectory: string;
  injector: InjectorConfig;
  policy: BellPolicy;
  logLevel: LogLevel;
}

export class BellConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BellConfigError";
  }
}

function requiredText(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new BellConfigError(`${name} is required and must not have surrounding whitespace`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requiredText(env, name);
  if (!/^\d+$/.test(raw)) {
    throw new BellConfigError(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BellConfigError(`${name} must be a positive safe integer`);
  }
  return value;
}

function fixedPositiveInteger(env: NodeJS.ProcessEnv, name: string, expected: number): number {
  const value = positiveInteger(env, name);
  if (value !== expected) {
    throw new BellConfigError(`${name} must be ${expected}`);
  }
  return value;
}

function ratio(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requiredText(env, name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new BellConfigError(`${name} must be at least 0 and less than 1`);
  }
  return value;
}

function endpoint(env: NodeJS.ProcessEnv, name: string): URL {
  const raw = requiredText(env, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BellConfigError(`${name} must be an absolute URL`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new BellConfigError(`${name} must use HTTPS unless it targets loopback`);
  }
  if (url.username || url.password || url.hash) {
    throw new BellConfigError(`${name} must not contain credentials or a fragment`);
  }
  return url;
}

function parseArgs(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env.BELL_INJECTOR_ARGS_JSON ?? "[]";
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BellConfigError("BELL_INJECTOR_ARGS_JSON must be valid JSON");
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BellConfigError("BELL_INJECTOR_ARGS_JSON must be a JSON string array");
  }
  return Object.freeze([...value]);
}

function logLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = env.BELL_LOG_LEVEL ?? "info";
  if (raw !== "debug" && raw !== "info" && raw !== "warn" && raw !== "error") {
    throw new BellConfigError("BELL_LOG_LEVEL must be debug, info, warn, or error");
  }
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BellConfig {
  const stateDirectory = requiredText(env, "BELL_STATE_DIRECTORY");
  if (!isAbsolute(stateDirectory)) {
    throw new BellConfigError("BELL_STATE_DIRECTORY must be an absolute path");
  }
  const workingDirectory = env.BELL_INJECTOR_WORKING_DIRECTORY;
  if (workingDirectory && !isAbsolute(workingDirectory)) {
    throw new BellConfigError("BELL_INJECTOR_WORKING_DIRECTORY must be absolute when set");
  }

  const policy: BellPolicy = {
    connectTimeoutMs: positiveInteger(env, "BELL_CONNECT_TIMEOUT_MS"),
    streamIdleTimeoutMs: positiveInteger(env, "BELL_STREAM_IDLE_TIMEOUT_MS"),
    httpTimeoutMs: positiveInteger(env, "BELL_HTTP_TIMEOUT_MS"),
    httpMaxAttempts: positiveInteger(env, "BELL_HTTP_MAX_ATTEMPTS"),
    httpRetryDelayMs: positiveInteger(env, "BELL_HTTP_RETRY_DELAY_MS"),
    reconnectInitialMs: positiveInteger(env, "BELL_RECONNECT_INITIAL_MS"),
    reconnectMaxMs: positiveInteger(env, "BELL_RECONNECT_MAX_MS"),
    reconnectMaxAttempts: positiveInteger(env, "BELL_RECONNECT_MAX_ATTEMPTS"),
    reconnectJitterRatio: ratio(env, "BELL_RECONNECT_JITTER_RATIO"),
    injectorTimeoutMs: positiveInteger(env, "BELL_INJECTOR_TIMEOUT_MS"),
    injectorKillGraceMs: positiveInteger(env, "BELL_INJECTOR_KILL_GRACE_MS"),
    injectorMaxAttempts: positiveInteger(env, "BELL_INJECTOR_MAX_ATTEMPTS"),
    injectorRetryDelayMs: positiveInteger(env, "BELL_INJECTOR_RETRY_DELAY_MS"),
    busyRetryDelayMs: positiveInteger(env, "BELL_BUSY_RETRY_DELAY_MS"),
    busyMaxAttempts: positiveInteger(env, "BELL_BUSY_MAX_ATTEMPTS"),
    maxPendingWakes: fixedPositiveInteger(env, "BELL_MAX_PENDING_WAKES", 32),
    sqliteBusyTimeoutMs: positiveInteger(env, "BELL_SQLITE_BUSY_TIMEOUT_MS"),
    acceptedRetentionDays: fixedPositiveInteger(env, "BELL_ACCEPTED_RETENTION_DAYS", 180),
    maxEventBytes: positiveInteger(env, "BELL_MAX_EVENT_BYTES"),
    maxWakeIdChars: positiveInteger(env, "BELL_MAX_WAKE_ID_CHARS"),
    maxReasonChars: positiveInteger(env, "BELL_MAX_REASON_CHARS"),
    maxMessageChars: positiveInteger(env, "BELL_MAX_MESSAGE_CHARS"),
    maxTimestampChars: positiveInteger(env, "BELL_MAX_TIMESTAMP_CHARS"),
    maxEpochChars: positiveInteger(env, "BELL_MAX_EPOCH_CHARS"),
    maxErrorCodeChars: positiveInteger(env, "BELL_MAX_ERROR_CODE_CHARS"),
    maxInjectorOutputBytes: positiveInteger(env, "BELL_MAX_INJECTOR_OUTPUT_BYTES"),
  };
  if (policy.reconnectInitialMs > policy.reconnectMaxMs) {
    throw new BellConfigError("BELL_RECONNECT_INITIAL_MS must not exceed BELL_RECONNECT_MAX_MS");
  }

  return {
    streamUrl: endpoint(env, "BELL_STREAM_URL"),
    ackUrl: endpoint(env, "BELL_ACK_URL"),
    reportUrl: endpoint(env, "BELL_REPORT_URL"),
    token: requiredText(env, "BELL_TOKEN"),
    stateDirectory,
    injector: {
      executable: requiredText(env, "BELL_INJECTOR_EXECUTABLE"),
      args: parseArgs(env),
      ...(workingDirectory ? { workingDirectory } : {}),
    },
    policy,
    logLevel: logLevel(env),
  };
}
