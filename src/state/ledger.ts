import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AcceptedWakeRecord {
  wakeId: string;
  acceptedAt: string;
  ackedAt?: string;
}

export interface WakeLedger {
  isAccepted(wakeId: string): boolean;
  markAccepted(wakeId: string, acceptedAt?: string): void;
  markAcked(wakeId: string, ackedAt?: string): void;
  listUnacked(): AcceptedWakeRecord[];
  close(): void;
}

export class SqliteWakeLedger implements WakeLedger {
  readonly #database: DatabaseSync;
  readonly #acceptedRetentionMs: number;

  constructor(stateDirectory: string, busyTimeoutMs: number, acceptedRetentionDays: number) {
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    this.#acceptedRetentionMs = acceptedRetentionDays * 24 * 60 * 60 * 1000;
    const databasePath = join(stateDirectory, "bell-state.sqlite");
    this.#database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.#database.exec("PRAGMA journal_mode=WAL");
    this.#database.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS accepted_wakes (
        wake_id TEXT PRIMARY KEY,
        accepted_at TEXT NOT NULL,
        acked_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS accepted_wakes_unacked
        ON accepted_wakes(acked_at)
        WHERE acked_at IS NULL;
      CREATE INDEX IF NOT EXISTS accepted_wakes_acked
        ON accepted_wakes(acked_at)
        WHERE acked_at IS NOT NULL;
    `);
  }

  isAccepted(wakeId: string): boolean {
    const row = this.#database
      .prepare("SELECT 1 AS found FROM accepted_wakes WHERE wake_id=?")
      .get(wakeId) as { found?: number } | undefined;
    return row?.found === 1;
  }

  markAccepted(wakeId: string, acceptedAt = new Date().toISOString()): void {
    this.#database
      .prepare(
        "INSERT INTO accepted_wakes(wake_id, accepted_at, acked_at) VALUES (?, ?, NULL) ON CONFLICT(wake_id) DO NOTHING",
      )
      .run(wakeId, acceptedAt);
  }

  markAcked(wakeId: string, ackedAt = new Date().toISOString()): void {
    const ackedAtMilliseconds = Date.parse(ackedAt);
    if (!Number.isFinite(ackedAtMilliseconds)) throw new Error("ackedAt must be a valid timestamp");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare("UPDATE accepted_wakes SET acked_at=COALESCE(acked_at, ?) WHERE wake_id=?")
        .run(ackedAt, wakeId);
      const cutoff = new Date(ackedAtMilliseconds - this.#acceptedRetentionMs).toISOString();
      this.#database
        .prepare("DELETE FROM accepted_wakes WHERE acked_at IS NOT NULL AND acked_at < ?")
        .run(cutoff);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listUnacked(): AcceptedWakeRecord[] {
    const rows = this.#database
      .prepare(
        "SELECT wake_id, accepted_at, acked_at FROM accepted_wakes WHERE acked_at IS NULL ORDER BY accepted_at ASC",
      )
      .all() as Array<{ wake_id: string; accepted_at: string; acked_at: string | null }>;
    return rows.map((row) => ({
      wakeId: row.wake_id,
      acceptedAt: row.accepted_at,
      ...(row.acked_at === null ? {} : { ackedAt: row.acked_at }),
    }));
  }

  close(): void {
    this.#database.close();
  }
}
