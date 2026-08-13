import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class BellAlreadyRunningError extends Error {
  constructor() {
    super("Bell is already running for this token and state directory");
    this.name = "BellAlreadyRunningError";
  }
}

export interface ProcessLock {
  readonly path: string;
  release(): void;
}

export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function acquireProcessLock(stateDirectory: string, token: string): ProcessLock {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDirectory, `bell-${tokenFingerprint(token)}.lock`);
  const nonce = randomUUID();
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new BellAlreadyRunningError();
    }
    throw error;
  }
  try {
    try {
      writeFileSync(
        descriptor,
        JSON.stringify({ version: 1, pid: process.pid, nonce, started_at: new Date().toISOString() }),
        "utf8",
      );
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    try {
      unlinkSync(lockPath);
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
    }
    throw error;
  }
  let released = false;
  return {
    path: lockPath,
    release: () => {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(readFileSync(lockPath, "utf8")) as { nonce?: unknown };
        if (current.nonce === nonce) unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
