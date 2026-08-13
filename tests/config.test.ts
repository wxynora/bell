import assert from "node:assert/strict";
import { test } from "node:test";
import { BellConfigError, loadConfig } from "../src/config.js";

function completeEnvironment(): NodeJS.ProcessEnv {
  return {
    BELL_STREAM_URL: "https://community.example.invalid/wake/stream",
    BELL_ACK_URL: "https://community.example.invalid/wake/ack",
    BELL_REPORT_URL: "https://community.example.invalid/wake/report",
    BELL_TOKEN: "secret",
    BELL_STATE_DIRECTORY: "/tmp/bell-state",
    BELL_INJECTOR_EXECUTABLE: "/usr/bin/true",
    BELL_CONNECT_TIMEOUT_MS: "1",
    BELL_STREAM_IDLE_TIMEOUT_MS: "2",
    BELL_HTTP_TIMEOUT_MS: "3",
    BELL_HTTP_MAX_ATTEMPTS: "4",
    BELL_HTTP_RETRY_DELAY_MS: "5",
    BELL_RECONNECT_INITIAL_MS: "6",
    BELL_RECONNECT_MAX_MS: "7",
    BELL_RECONNECT_MAX_ATTEMPTS: "8",
    BELL_RECONNECT_JITTER_RATIO: "0.2",
    BELL_INJECTOR_TIMEOUT_MS: "9",
    BELL_INJECTOR_KILL_GRACE_MS: "10",
    BELL_INJECTOR_MAX_ATTEMPTS: "11",
    BELL_INJECTOR_RETRY_DELAY_MS: "12",
    BELL_BUSY_RETRY_DELAY_MS: "13",
    BELL_BUSY_MAX_ATTEMPTS: "14",
    BELL_SQLITE_BUSY_TIMEOUT_MS: "15",
    BELL_MAX_EVENT_BYTES: "16",
    BELL_MAX_WAKE_ID_CHARS: "17",
    BELL_MAX_REASON_CHARS: "18",
    BELL_MAX_MESSAGE_CHARS: "19",
    BELL_MAX_TIMESTAMP_CHARS: "20",
    BELL_MAX_EPOCH_CHARS: "21",
    BELL_MAX_ERROR_CODE_CHARS: "22",
    BELL_MAX_INJECTOR_OUTPUT_BYTES: "23",
  };
}

test("loadConfig requires every unconfirmed numeric policy explicitly", () => {
  const environment = completeEnvironment();
  delete environment.BELL_INJECTOR_TIMEOUT_MS;
  assert.throws(() => loadConfig(environment), BellConfigError);
});

test("loadConfig accepts HTTPS and explicit policy values", () => {
  const config = loadConfig(completeEnvironment());
  assert.equal(config.policy.injectorTimeoutMs, 9);
  assert.equal(config.policy.maxErrorCodeChars, 22);
  assert.deepEqual(config.injector.args, []);
});

test("loadConfig rejects cleartext non-loopback endpoints", () => {
  const environment = completeEnvironment();
  environment.BELL_STREAM_URL = "http://community.example.invalid/wake/stream";
  assert.throws(() => loadConfig(environment), /HTTPS/u);
});

test("loadConfig rejects jitter that could produce a zero-delay reconnect", () => {
  const environment = completeEnvironment();
  environment.BELL_RECONNECT_JITTER_RATIO = "1";
  assert.throws(() => loadConfig(environment), /less than 1/u);
});
