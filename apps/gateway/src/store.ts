import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export interface EnrollCaps {
  hourlyLimitPerIp: number;
  dailyLimitPerIp: number;
  globalDailyLimit: number;
}

export interface JudgmentCaps {
  globalDailyLimit: number;
  deviceDailyLimit: number;
  deviceHourlyLimit: number;
}

export interface AuthenticatedDevice {
  id: string;
}

export type Reservation = { ok: true } | { ok: false; code: string };

export interface Store {
  close(): void;
  enrollDevice(
    ip: string,
    caps: EnrollCaps,
    now?: Date,
  ): { ok: true; id: string; token: string } | { ok: false; code: string };
  authenticate(token: string): AuthenticatedDevice | null;
  listDevices(): Array<{ id: string; createdAt: string; disabled: boolean }>;
  revokeDevice(id: string): boolean;
  revokeAllDevices(): number;
  reserveJudgment(
    deviceId: string,
    caps: JudgmentCaps,
    now?: Date,
  ): Reservation;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function dayWindow(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function hourWindow(now: Date): string {
  return now.toISOString().slice(0, 13);
}

interface Check {
  key: string;
  limit: number;
  code: string;
}

/**
 * Atomically checks every reservation and, only if all are under their
 * limits, commits all increments together. Because node:sqlite is
 * synchronous and Node is single-threaded, no other request's checks can
 * interleave between the transaction's checks and its commit.
 */
function reserve(db: DatabaseSync, checks: Check[]): Reservation {
  db.exec("BEGIN IMMEDIATE");
  try {
    const getStmt = db.prepare("SELECT count FROM counters WHERE key = ?");
    for (const check of checks) {
      const row = getStmt.get(check.key) as { count: number } | undefined;
      const current = row ? row.count : 0;
      if (current >= check.limit) {
        db.exec("ROLLBACK");
        return { ok: false, code: check.code };
      }
    }
    const upsertStmt = db.prepare(
      "INSERT INTO counters (key, count) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1",
    );
    for (const check of checks) upsertStmt.run(check.key);
    db.exec("COMMIT");
    return { ok: true };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // no active transaction to roll back
    }
    throw err;
  }
}

export function openStore(dbPath: string): Store {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    closeSync(openSync(dbPath, "a", 0o600));
    chmodSync(dbPath, 0o600);
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 1000;
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      ip TEXT NOT NULL,
      created_at TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS counters (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL
    );
  `);

  return {
    close() {
      db.close();
    },

    enrollDevice(ip, caps, now = new Date()) {
      const reservation = reserve(db, [
        {
          key: `enroll:global:day:${dayWindow(now)}`,
          limit: caps.globalDailyLimit,
          code: "enrollment_global_daily_limit",
        },
        {
          key: `enroll:${ip}:day:${dayWindow(now)}`,
          limit: caps.dailyLimitPerIp,
          code: "enrollment_daily_limit",
        },
        {
          key: `enroll:${ip}:hour:${hourWindow(now)}`,
          limit: caps.hourlyLimitPerIp,
          code: "enrollment_hourly_limit",
        },
      ]);
      if (!reservation.ok) return reservation;

      const id = randomUUID();
      const token = randomBytes(32).toString("base64url");
      db.prepare(
        "INSERT INTO devices (id, token_hash, ip, created_at, disabled) VALUES (?, ?, ?, ?, 0)",
      ).run(id, hashToken(token), ip, now.toISOString());
      return { ok: true, id, token };
    },

    authenticate(token) {
      const row = db
        .prepare("SELECT id, disabled FROM devices WHERE token_hash = ?")
        .get(hashToken(token)) as { id: string; disabled: number } | undefined;
      if (!row || row.disabled) return null;
      return { id: row.id };
    },

    listDevices() {
      const rows = db
        .prepare(
          "SELECT id, created_at, disabled FROM devices ORDER BY created_at DESC",
        )
        .all() as Array<{ id: string; created_at: string; disabled: number }>;
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        disabled: Boolean(row.disabled),
      }));
    },
    revokeDevice(id) {
      return (
        db
          .prepare(
            "UPDATE devices SET disabled = 1 WHERE id = ? AND disabled = 0",
          )
          .run(id).changes > 0
      );
    },
    revokeAllDevices() {
      return Number(
        db.prepare("UPDATE devices SET disabled = 1 WHERE disabled = 0").run()
          .changes,
      );
    },

    reserveJudgment(deviceId, caps, now = new Date()) {
      return reserve(db, [
        {
          key: `global:day:${dayWindow(now)}`,
          limit: caps.globalDailyLimit,
          code: "global_daily_limit",
        },
        {
          key: `device:${deviceId}:day:${dayWindow(now)}`,
          limit: caps.deviceDailyLimit,
          code: "device_daily_limit",
        },
        {
          key: `device:${deviceId}:hour:${hourWindow(now)}`,
          limit: caps.deviceHourlyLimit,
          code: "device_hourly_limit",
        },
      ]);
    },
  };
}
