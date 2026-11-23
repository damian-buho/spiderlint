// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export const SQLITE_BUCKET_FILE = "__bucket.sqlite";

const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -65536;
PRAGMA mmap_size = 268435456;
PRAGMA temp_store = MEMORY;
CREATE TABLE IF NOT EXISTS entries (
    key TEXT PRIMARY KEY,
    stored TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    value_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_entries_mtime ON entries (mtime_ms);
`;

interface PreparedBucket {
    database: DatabaseSync;
    getEntry: StatementSync;
    setEntry: StatementSync;
    status: StatementSync;
    purgeBefore: StatementSync;
    purgeAll: StatementSync;
    countAll: StatementSync;
}

const openBuckets = new Map<string, PreparedBucket>();

function databasePath(directory: string): string {
    return path.join(directory, SQLITE_BUCKET_FILE);
}

function openPrepared(directory: string, shouldCreate: boolean): PreparedBucket | undefined {
    const existing = openBuckets.get(directory);
    if (existing) return existing;
    const file = databasePath(directory);
    if (!shouldCreate && !existsSync(file)) return undefined;
    mkdirSync(directory, { recursive: true });
    const database = new DatabaseSync(file);
    database.exec(PRAGMAS);
    const prepared: PreparedBucket = {
        database,
        getEntry: database.prepare("SELECT stored, value_json FROM entries WHERE key = ?"),
        setEntry: database.prepare("INSERT INTO entries (key, stored, mtime_ms, value_json) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET stored = excluded.stored, mtime_ms = excluded.mtime_ms, value_json = excluded.value_json"),
        status: database.prepare("SELECT COUNT(*) AS count, MIN(mtime_ms) AS oldest, MAX(mtime_ms) AS newest FROM entries"),
        purgeBefore: database.prepare("DELETE FROM entries WHERE mtime_ms <= ?"),
        purgeAll: database.prepare("DELETE FROM entries"),
        countAll: database.prepare("SELECT COUNT(*) AS count FROM entries"),
    };
    openBuckets.set(directory, prepared);
    return prepared;
}

// Closes any open SQLite handle for `directory`.
export function closeSqliteBucket(directory: string): void {
    const existing = openBuckets.get(directory);
    if (!existing) return;
    openBuckets.delete(directory);
    try {
        existing.database.close();
    } catch {
        // Ignore already-closed handles during cleanup.
    }
}

// Reads one JSON entry from `<directory>/__bucket.sqlite`, or undefined on miss.
export function sqliteGet<T>(directory: string, key: string): { key: string; stored: string; value: T } | undefined {
    const bucket = openPrepared(directory, false);
    if (!bucket) return undefined;
    const row = bucket.getEntry.get(key) as { stored: string; value_json: string } | undefined;
    return row ? { key, stored: row.stored, value: JSON.parse(row.value_json) as T } : undefined;
}

// Upserts one JSON entry into `<directory>/__bucket.sqlite` under WAL mode.
export function sqliteSet(directory: string, key: string, stored: string, valueJson: string): void {
    const bucket = openPrepared(directory, true);
    if (!bucket) return;
    bucket.setEntry.run(key, stored, Date.parse(stored), valueJson);
}

// Returns entry count, on-disk byte total (DB + WAL/SHM), and age bounds when `__bucket.sqlite` holds entries.
export function sqliteStatus(directory: string): { entries: number; bytes: number; oldestMs: number; newestMs: number } | undefined {
    const bucket = openPrepared(directory, false);
    if (!bucket) return undefined;
    const row = bucket.status.get() as { count: number | bigint; oldest: number | bigint | null; newest: number | bigint | null } | undefined;
    const entries = Number(row?.count ?? 0);
    if (entries === 0) return undefined;
    let bytes = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
        try {
            bytes += statSync(`${databasePath(directory)}${suffix}`).size;
        } catch {
            // Optional WAL/SHM sidecar absent.
        }
    }
    return { entries, bytes, oldestMs: Number(row?.oldest ?? Date.now()), newestMs: Number(row?.newest ?? Date.now()) };
}

// Purges SQLite entries older than `cutoffMs` (or all when `shouldPurgeAll` is true), removing empty database files.
export function sqlitePurge(directory: string, cutoffMs: number, shouldPurgeAll: boolean): number {
    const bucket = openPrepared(directory, false);
    if (!bucket) return 0;
    const result = shouldPurgeAll ? bucket.purgeAll.run() : bucket.purgeBefore.run(cutoffMs);
    const changes = Number(result.changes);
    const remaining = Number((bucket.countAll.get() as { count: number | bigint } | undefined)?.count ?? 0);
    if (remaining === 0) {
        closeSqliteBucket(directory);
        for (const suffix of ["", "-wal", "-shm"]) {
            rmSync(`${databasePath(directory)}${suffix}`, { force: true });
        }
    }
    return changes;
}
