import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BellUpdateResource } from "../protocol.js";

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

export interface BellUpdateRecord {
  resource: BellUpdateResource;
  availableVersion: number;
  appliedVersion: number;
  signaledAt: string;
  appliedAt?: string;
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
      CREATE TABLE IF NOT EXISTS bell_updates (
        resource TEXT PRIMARY KEY,
        available_version INTEGER NOT NULL CHECK(available_version > 0),
        applied_version INTEGER NOT NULL DEFAULT 0 CHECK(applied_version >= 0),
        signaled_at TEXT NOT NULL,
        applied_at TEXT,
        CHECK(applied_version <= available_version)
      ) STRICT;
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

  recordUpdateAvailable(
    resource: BellUpdateResource,
    availableVersion: number,
    signaledAt = new Date().toISOString(),
  ): void {
    if (!Number.isSafeInteger(availableVersion) || availableVersion <= 0) {
      throw new Error("availableVersion must be a positive safe integer");
    }
    if (!Number.isFinite(Date.parse(signaledAt))) {
      throw new Error("signaledAt must be a valid timestamp");
    }
    this.#database
      .prepare(
        `INSERT INTO bell_updates(
           resource, available_version, applied_version, signaled_at, applied_at
         ) VALUES (?, ?, 0, ?, NULL)
         ON CONFLICT(resource) DO UPDATE SET
           available_version=MAX(bell_updates.available_version, excluded.available_version),
           signaled_at=CASE
             WHEN excluded.available_version > bell_updates.available_version
             THEN excluded.signaled_at
             ELSE bell_updates.signaled_at
           END`,
      )
      .run(resource, availableVersion, signaledAt);
  }

  markUpdateApplied(
    resource: BellUpdateResource,
    appliedVersion: number,
    appliedAt = new Date().toISOString(),
  ): void {
    if (!Number.isSafeInteger(appliedVersion) || appliedVersion <= 0) {
      throw new Error("appliedVersion must be a positive safe integer");
    }
    if (!Number.isFinite(Date.parse(appliedAt))) {
      throw new Error("appliedAt must be a valid timestamp");
    }
    this.#database
      .prepare(
        `INSERT INTO bell_updates(
           resource, available_version, applied_version, signaled_at, applied_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(resource) DO UPDATE SET
           available_version=MAX(bell_updates.available_version, excluded.available_version),
           applied_version=MAX(bell_updates.applied_version, excluded.applied_version),
           applied_at=CASE
             WHEN excluded.applied_version > bell_updates.applied_version
             THEN excluded.applied_at
             ELSE bell_updates.applied_at
           END`,
      )
      .run(resource, appliedVersion, appliedVersion, appliedAt, appliedAt);
  }

  getUpdate(resource: BellUpdateResource): BellUpdateRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT resource, available_version, applied_version, signaled_at, applied_at
         FROM bell_updates WHERE resource=?`,
      )
      .get(resource) as
      | {
          resource: BellUpdateResource;
          available_version: number;
          applied_version: number;
          signaled_at: string;
          applied_at: string | null;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      resource: row.resource,
      availableVersion: row.available_version,
      appliedVersion: row.applied_version,
      signaledAt: row.signaled_at,
      ...(row.applied_at === null ? {} : { appliedAt: row.applied_at }),
    };
  }

  close(): void {
    this.#database.close();
  }
}
