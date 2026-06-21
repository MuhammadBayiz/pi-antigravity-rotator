// Repository pattern for rotator settings persistence.
//
// Two implementations:
//   PostgresSettingsRepository — backed by a `rotator_settings` table
//   FileSettingsRepository     — backed by JSON files on disk

import pg from "pg";
import { existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./paths.js";
import {
  backupFile,
  readTextFile,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from "./storage.js";

const { Pool } = pg;

/**
 * Generic key-value settings repository.
 *
 * Callers use string keys; the values are opaque strings (typically
 * JSON-serialized objects). Both implementations guarantee that `get()`
 * always returns the latest value set via `set()` (in-process consistency).
 */
export interface ISettingsRepository {
  /** Initialize the repository (create table / load from disk) */
  init(): Promise<void>;

  /** Get a value by key */
  get(key: string): string | null;

  /** Persist a value by key */
  set(key: string, value: string): void;

  /** Close connections / flush pending writes */
  close(): Promise<void>;
}

// ----- Key → disk-file mapping -----

interface DiskFileSpec {
  filename: string;
  /** Whether to back up the file before overwriting */
  backup: boolean;
  /** Whether to trim whitespace on read (e.g. admin_token) */
  trim: boolean;
  /** File mode to set after writing (e.g. 0o600 for secrets) */
  mode?: number;
}

const DISK_FILES: Record<string, DiskFileSpec> = {
  accounts_json: { filename: "accounts.json", backup: true, trim: false },
  admin_token: {
    filename: ".admin-token",
    backup: false,
    trim: true,
    mode: 0o600,
  },
  rotator_state: { filename: "state.json", backup: true, trim: false },
  token_usage: { filename: "token-usage.json", backup: false, trim: false },
  responses_store: { filename: "responses.json", backup: false, trim: false },
};

function diskPath(key: string): string | null {
  const spec = DISK_FILES[key];
  if (!spec) return null;
  return join(getConfigDir(), spec.filename);
}

// ----- PostgresSettingsRepository -----

export class PostgresSettingsRepository implements ISettingsRepository {
  private pool: pg.Pool | null = null;
  private cache = new Map<string, string>();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    const connectionString =
      process.env.PI_ROTATOR_DATABASE_URL || process.env.DATABASE_URL;
    this.pool = new Pool({
      connectionString,
      ssl:
        connectionString?.includes("sslmode=require") ||
        connectionString?.includes("ssl=")
          ? { rejectUnauthorized: false }
          : undefined,
    });

    // Create table if it doesn't exist
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS rotator_settings (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Load all rows into cache
    const result = await this.pool.query(
      "SELECT key, value FROM rotator_settings",
    );
    for (const row of result.rows) {
      this.cache.set(row.key, row.value);
    }

    // Migrate from disk for any keys not already in DB
    for (const [key, spec] of Object.entries(DISK_FILES)) {
      if (this.cache.has(key)) continue;
      try {
        const path = join(getConfigDir(), spec.filename);
        if (!existsSync(path)) continue;
        const content = readFileSync(path, "utf-8");
        if (!content) continue;
        const value = spec.trim ? content.trim() : content;
        if (!value) continue;
        this.cache.set(key, value);
        // Persist migration to DB (blocking on init is intentional)
        await this.pool.query(
          `INSERT INTO rotator_settings (key, value, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [key, value],
        );
        console.log(`Migrated ${spec.filename} from disk to database`);
      } catch (err) {
        console.error(`Failed to migrate ${spec.filename} from disk: ${err}`);
      }
    }

    this.initialized = true;
  }

  get(key: string): string | null {
    return this.cache.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
    if (this.pool) {
      // Non-blocking background save
      this.pool
        .query(
          `INSERT INTO rotator_settings (key, value, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [key, value],
        )
        .catch((err) => {
          console.error(
            `Failed to save ${key} to database in background: ${err}`,
          );
        });
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this.initialized = false;
  }
}

// ----- FileSettingsRepository -----
//
// Reads and writes directly to disk files.  Keeps an in-memory cache so
// repeated `get()` calls within the same process don't re-parse from disk.

export class FileSettingsRepository implements ISettingsRepository {
  private cache = new Map<string, string>();

  async init(): Promise<void> {
    // Pre-load all known keys from their disk files into cache
    for (const [key, spec] of Object.entries(DISK_FILES)) {
      try {
        const path = join(getConfigDir(), spec.filename);
        if (!existsSync(path)) continue;
        const content = readTextFile(path);
        if (!content) continue;
        this.cache.set(key, spec.trim ? content.trim() : content);
      } catch {
        // Ignore unreadable files — callers handle missing data
      }
    }
  }

  get(key: string): string | null {
    return this.cache.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);

    // Persist to disk
    const path = diskPath(key);
    if (!path) return;

    const spec = DISK_FILES[key];
    try {
      if (spec?.backup) {
        backupFile(path, spec.filename.replace(".json", ""));
      }
      if (spec?.trim) {
        // Plain text file (e.g. admin_token)
        writeTextFileAtomic(path, value);
      } else {
        // JSON files — try to pretty-print, fall back to raw string
        try {
          const parsed = JSON.parse(value);
          writeJsonFileAtomic(path, parsed);
        } catch {
          writeTextFileAtomic(path, value);
        }
      }
      // Apply restricted permissions when specified (e.g. secrets)
      if (spec?.mode) {
        try {
          chmodSync(path, spec.mode);
        } catch {
          // Best effort: some filesystems (e.g. Windows) don't support POSIX perms.
        }
      }
    } catch (err) {
      console.error(`Failed to save ${key} to disk (${path}): ${err}`);
    }
  }

  async close(): Promise<void> {
    // no-op — all writes are synchronous
  }
}
