// Convenience façade over the settings repository.
//
// Maintains full backward compatibility with the previous module API while
// delegating all persistence to an ISettingsRepository implementation.
// Both PostgresSettingsRepository and FileSettingsRepository are fully
// self-contained — callers no longer need to branch on isDbConfigured().

import type { Config, PersistedState, TokenUsageTiered } from "./types.js";
import type { StoredResponseEntry } from "./responses-store.js";
import { validateConfig } from "./validators.js";
import { applyConfigDefaults } from "./config-defaults.js";
import {
  type ISettingsRepository,
  PostgresSettingsRepository,
  FileSettingsRepository,
} from "./settings-repository.js";

/**
 * PersistedStore shape used by ResponsesStore on disk.
 * Duplicated here to avoid a circular import from responses-store.
 */
export interface PersistedResponsesStore {
  version: 1;
  entries: Array<[string, StoredResponseEntry]>;
}

// ----- Repository strategy -----

function createRepository(): ISettingsRepository {
  if (process.env.PI_ROTATOR_DATABASE_URL || process.env.DATABASE_URL) {
    return new PostgresSettingsRepository();
  }
  return new FileSettingsRepository();
}

const repository: ISettingsRepository = createRepository();

// ----- Backward-compatible public API -----

/**
 * Whether persistence is backed by PostgreSQL (true) or disk files (false).
 * Callers that need to know the storage backend (e.g. for diagnostics or
 * doctor output) can use this, but most callers should NOT need to branch
 * on this — both repositories handle their own I/O.
 */
export function isDbConfigured(): boolean {
  return !!(process.env.PI_ROTATOR_DATABASE_URL || process.env.DATABASE_URL);
}

export async function initDb(): Promise<void> {
  return repository.init();
}

export async function closeDb(): Promise<void> {
  return repository.close();
}

// --- Accounts config ---

export function getCachedConfig(): Config | null {
  const raw = repository.get("accounts_json");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const validation = validateConfig(parsed);
    if (validation.ok && validation.value) {
      return applyConfigDefaults(validation.value);
    }
  } catch (err) {
    console.error(`Failed to parse accounts config from repository: ${err}`);
  }
  return null;
}

export function setCachedConfig(config: Config): void {
  const withDefaults = applyConfigDefaults(config);
  repository.set("accounts_json", JSON.stringify(withDefaults, null, 2));
}

// --- Admin token ---

export function getCachedAdminToken(): string | null {
  const raw = repository.get("admin_token");
  return raw ? raw.trim() : null;
}

export function setCachedAdminToken(token: string): void {
  repository.set("admin_token", token.trim());
}

// --- Rotator state ---

export function getCachedState(): PersistedState | null {
  const raw = repository.get("rotator_state");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedState;
  } catch (err) {
    console.error(`Failed to parse rotator state from repository: ${err}`);
    return null;
  }
}

export function setCachedState(state: PersistedState): void {
  repository.set("rotator_state", JSON.stringify(state));
}

// --- Token usage ---

export function getCachedTokenUsage(): TokenUsageTiered | null {
  const raw = repository.get("token_usage");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenUsageTiered;
  } catch (err) {
    console.error(`Failed to parse token usage from repository: ${err}`);
    return null;
  }
}

export function setCachedTokenUsage(usage: TokenUsageTiered): void {
  repository.set("token_usage", JSON.stringify(usage));
}

// --- Responses store ---

export function getCachedResponsesStore(): PersistedResponsesStore | null {
  const raw = repository.get("responses_store");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedResponsesStore;
  } catch (err) {
    console.error(`Failed to parse responses store from repository: ${err}`);
    return null;
  }
}

export function setCachedResponsesStore(store: PersistedResponsesStore): void {
  repository.set("responses_store", JSON.stringify(store));
}
