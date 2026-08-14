import { createHash } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";

export class BellAlreadyRunningError extends Error {
  constructor() {
    super("Bell is already running for this state directory");
    this.name = "BellAlreadyRunningError";
  }
}

export interface ProcessLock {
  readonly path: string;
  release(): Promise<void>;
}

function lockAddress(stateDirectory: string): string {
  if (process.platform === "win32") {
    const fingerprint = createHash("sha256").update(stateDirectory).digest("hex");
    return `\\\\.\\pipe\\bell-${fingerprint}`;
  }
  return join(stateDirectory, "bell.lock.sock");
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function probe(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function acquireProcessLock(stateDirectory: string): Promise<ProcessLock> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const path = lockAddress(stateDirectory);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const server = createServer((socket) => socket.destroy());
    try {
      await listen(server, path);
      if (process.platform !== "win32") await chmod(path, 0o600);
      let released = false;
      return {
        path,
        release: async () => {
          if (released) return;
          released = true;
          await close(server);
        },
      };
    } catch (error) {
      if (server.listening) await close(server);
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (await probe(path)) throw new BellAlreadyRunningError();
      if (process.platform !== "win32") await removeStaleSocket(path);
    }
  }

  throw new BellAlreadyRunningError();
}
