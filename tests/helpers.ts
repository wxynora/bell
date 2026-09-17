import type { BellConfig } from "../src/config.js";

export const TEST_NOW_MS = Date.parse("2026-08-11T00:00:00.000Z");

export function testConfig(overrides: Partial<BellConfig> = {}): BellConfig {
  return {
    streamUrl: new URL("http://127.0.0.1/wake/stream"),
    ackUrl: new URL("http://127.0.0.1/wake/ack"),
    reportUrl: new URL("http://127.0.0.1/wake/report"),
    token: "test-token",
    stateDirectory: "/tmp/bell-test-placeholder",
    injector: { executable: process.execPath, args: [] },
    policy: {
      connectTimeoutMs: 100,
      streamIdleTimeoutMs: 100,
      httpTimeoutMs: 100,
      httpMaxAttempts: 2,
      httpRetryDelayMs: 1,
      reconnectInitialMs: 1,
      reconnectMaxMs: 2,
      reconnectMaxAttempts: 1,
      reconnectJitterRatio: 0,
      injectorTimeoutMs: 100,
      injectorKillGraceMs: 10,
      injectorMaxAttempts: 2,
      injectorRetryDelayMs: 1,
      busyRetryDelayMs: 1,
      busyMaxAttempts: 2,
      maxPendingWakes: 32,
      sqliteBusyTimeoutMs: 100,
      acceptedRetentionDays: 180,
      wakeMaxAgeMs: 1800000,
      maxEventBytes: 4096,
      maxReasonChars: 128,
      maxTimestampChars: 64,
      maxEpochChars: 128,
      maxErrorCodeChars: 128,
      maxInjectorOutputBytes: 4096,
    },
    logLevel: "error",
    ...overrides,
  };
}
