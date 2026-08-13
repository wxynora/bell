import { createHash } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function redactText(value: unknown, secrets: readonly string[] = []): string {
  let text = value instanceof Error ? value.message : String(value ?? "");
  for (const secret of secrets) {
    if (secret) {
      text = text.split(secret).join("[REDACTED]");
    }
  }
  return text.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

export function safeId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createLogger(
  minimumLevel: LogLevel,
  options: { secrets?: readonly string[]; write?: (line: string) => void } = {},
): Logger {
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const secrets = options.secrets ?? [];

  const emit = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minimumLevel]) return;
    const safeContext = context
      ? Object.fromEntries(
          Object.entries(context).map(([key, value]) => [
            key,
            value instanceof Error ? redactText(value, secrets) : value,
          ]),
        )
      : undefined;
    const suffix = safeContext ? ` ${redactText(JSON.stringify(safeContext), secrets)}` : "";
    write(
      `${new Date().toISOString()} ${level.toUpperCase()} ${redactText(message, secrets)}${suffix}`,
    );
  };

  return {
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
