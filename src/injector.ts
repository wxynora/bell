import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { BellPolicy, InjectorConfig } from "./config.js";
import { BELL_PROTOCOL_VERSION, type WakeEvent } from "./protocol.js";

export type InjectorOutcome =
  | { status: "accepted" }
  | { status: "busy" }
  | { status: "retryable_error"; errorCode: string }
  | { status: "permanent_error"; errorCode: string }
  | { status: "timeout"; errorCode: "injector_timeout" };

export interface InjectorRunnerOptions {
  injector: InjectorConfig;
  policy: Pick<
    BellPolicy,
    | "injectorTimeoutMs"
    | "injectorKillGraceMs"
    | "maxInjectorOutputBytes"
    | "maxErrorCodeChars"
  >;
}

function localFailure(errorCode: string, permanent: boolean): InjectorOutcome {
  return permanent
    ? { status: "permanent_error", errorCode }
    : { status: "retryable_error", errorCode };
}

function terminate(child: ChildProcessWithoutNullStreams, graceMs: number): NodeJS.Timeout | undefined {
  if (child.exitCode !== null || child.signalCode !== null) return undefined;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, graceMs);
  timer.unref?.();
  return timer;
}

function parseOutput(stdout: string, exitCode: number | null, maxErrorCodeChars: number): InjectorOutcome {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed.split(/\r?\n/u).length !== 1) {
    return localFailure("invalid_injector_output", true);
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return localFailure("invalid_injector_output", true);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return localFailure("invalid_injector_output", true);
  }
  const result = value as Record<string, unknown>;
  if (result.version !== BELL_PROTOCOL_VERSION) {
    return localFailure("invalid_injector_output", true);
  }
  if (result.status === "accepted") {
    return exitCode === 0 && Object.keys(result).length === 2
      ? { status: "accepted" }
      : localFailure("injector_exit_mismatch", true);
  }
  if (result.status === "busy") {
    return exitCode !== 0 && Object.keys(result).length === 2
      ? { status: "busy" }
      : localFailure("injector_exit_mismatch", true);
  }
  if (result.status === "retryable_error" || result.status === "permanent_error") {
    if (
      exitCode === 0 ||
      typeof result.error_code !== "string" ||
      Object.keys(result).length !== 3 ||
      result.error_code.length === 0 ||
      result.error_code.length > maxErrorCodeChars ||
      !/^[a-z0-9][a-z0-9_.-]*$/u.test(result.error_code)
    ) {
      return localFailure("invalid_injector_output", true);
    }
    return result.status === "retryable_error"
      ? { status: "retryable_error", errorCode: result.error_code }
      : { status: "permanent_error", errorCode: result.error_code };
  }
  return localFailure("invalid_injector_output", true);
}

export async function runInjector(
  options: InjectorRunnerOptions,
  wake: WakeEvent,
  signal: AbortSignal,
): Promise<InjectorOutcome> {
  if (signal.aborted) throw signal.reason;
  const childEnvironment = { ...process.env };
  delete childEnvironment.BELL_TOKEN;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.injector.executable, [...options.injector.args], {
      ...(options.injector.workingDirectory
        ? { cwd: options.injector.workingDirectory }
        : {}),
      env: childEnvironment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return localFailure(
      code === "ENOENT" ? "injector_not_found" : "injector_spawn_failed",
      code === "ENOENT" || code === "EACCES",
    );
  }

  return await new Promise<InjectorOutcome>((resolve, reject) => {
    let stdout = "";
    let stdoutBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const finish = (outcome: InjectorOutcome): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      reject(error);
    };
    const stop = (): void => {
      killTimer ??= terminate(child, options.policy.injectorKillGraceMs);
    };
    const onAbort = (): void => stop();
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.policy.injectorTimeoutMs);
    timeoutTimer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.policy.maxInjectorOutputBytes) {
        outputExceeded = true;
        stop();
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => {
      // stderr is deliberately discarded: adapters must return machine-readable status on stdout.
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(
        localFailure(
          error.code === "ENOENT" ? "injector_not_found" : "injector_spawn_failed",
          error.code === "ENOENT" || error.code === "EACCES",
        ),
      );
    });
    child.on("close", (exitCode) => {
      if (signal.aborted) {
        fail(signal.reason);
        return;
      }
      if (timedOut) {
        finish({ status: "timeout", errorCode: "injector_timeout" });
        return;
      }
      if (outputExceeded) {
        finish(localFailure("injector_output_limit", true));
        return;
      }
      finish(parseOutput(stdout, exitCode, options.policy.maxErrorCodeChars));
    });

    child.stdin.on("error", () => {
      // The close/error event supplies the final classified outcome.
    });
    child.stdin.end(
      `${JSON.stringify({
        type: "doorbell_wake",
        version: BELL_PROTOCOL_VERSION,
        wake_id: wake.wakeId,
        reason: wake.reason,
        message: wake.message,
      })}\n`,
    );
  });
}
