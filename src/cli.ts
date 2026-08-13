#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { checkBellConnection, runBell } from "./runner.js";
import { VERSION } from "./version.js";

const HELP = `铃 Bell ${VERSION}

Usage:
  bell run       Connect to Doorbell and deliver wake events to the configured injector
  bell check     Validate configuration and complete one authenticated SSE handshake
  bell --version Print the Bell version
  bell --help    Show this help

Bell reads configuration from BELL_* environment variables. See .env.example and README.md.
`;

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0] ?? "run";
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command !== "run" && command !== "check") {
    throw new Error(`unknown command: ${command}`);
  }
  if (argv.length > 1) throw new Error(`unexpected argument: ${argv[1]}`);

  const config = loadConfig();
  const logger = createLogger(config.logLevel, { secrets: [config.token] });
  const controller = new AbortController();
  const shutdown = (): void => controller.abort(new Error("shutdown requested"));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    if (command === "check") {
      await checkBellConnection(config, { logger, signal: controller.signal });
    } else {
      logger.info("Bell starting");
      await runBell(config, { logger, signal: controller.signal });
      logger.info("Bell stopped");
    }
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`Bell failed: ${message}\n`);
  process.exitCode = 1;
});
