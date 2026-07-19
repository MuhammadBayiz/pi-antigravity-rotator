import { accessSync, constants, existsSync } from "node:fs";
import { getConfiguredAdminToken } from "./admin-auth.js";
import { getConfigDir } from "./paths.js";
import { listBackups } from "./storage.js";
import {
  isDbConfigured,
  getCachedConfig,
  getCachedState,
  getCachedTokenUsage,
} from "./db-store.js";
import { hasProxyConfigured } from "./proxy-agent.js";

function checkWritable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface DoctorResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
  info: Record<string, unknown>;
}

export async function runDoctor(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const configDir = getConfigDir();

  if (!getConfiguredAdminToken(env)) {
    warnings.push(
      "PI_ROTATOR_ADMIN_TOKEN is not configured; dashboard and /api/* remain open on the bound interface.",
    );
  }

  const dbConfigured = isDbConfigured();

  if (dbConfigured) {
    // When using PostgreSQL, configDir is not required for data persistence
    if (!existsSync(configDir)) {
      warnings.push(
        `Config directory does not exist (${configDir}), but storage backend is PostgreSQL — this is expected in containerised environments.`,
      );
    }
  } else {
    if (!existsSync(configDir)) {
      errors.push(`Config directory missing: ${configDir}`);
    } else if (!checkWritable(configDir)) {
      errors.push(`Config directory is not writable: ${configDir}`);
    }
  }

  // Validate config — read from repository (handles both DB and file)
  const cfg = getCachedConfig();
  if (!cfg) {
    warnings.push(
      "No accounts config found. Run 'pi-antigravity-rotator login' to add your first account.",
    );
  } else if (Array.isArray(cfg.accounts) && cfg.accounts.length > 0) {
    // Fail-closed audit: any account without a proxy is disabled and unusable,
    // because serving it would leak the device's real IP to Google.
    const noProxy = cfg.accounts.filter(
      (a) => !hasProxyConfigured((a as { proxy?: string }).proxy),
    );
    if (noProxy.length > 0) {
      warnings.push(
        `${noProxy.length} account(s) have NO proxy and will be REFUSED at request time ` +
          `(fail-closed, never served over the real IP): ` +
          noProxy.map((a) => a.email || "unknown").join(", ") +
          ". Re-add each with --proxy <url> so its traffic exits through its own IP.",
      );
    }
  }

  // Validate state
  const state = getCachedState();
  if (state && typeof state !== "object") {
    warnings.push("Rotator state data is corrupted.");
  }

  // Validate token usage
  const usage = getCachedTokenUsage();
  if (usage && typeof usage !== "object") {
    warnings.push("Token usage data is corrupted.");
  }

  const backups = dbConfigured ? [] : listBackups();

  return {
    ok: errors.length === 0,
    warnings,
    errors,
    info: {
      configDir,
      backupCount: backups.length,
      firstBackup: backups[0] ?? null,
      adminTokenConfigured: !!getConfiguredAdminToken(env),
      bindHost: env.PI_ROTATOR_BIND_HOST ?? null,
      storageBackend: dbConfigured ? "postgresql" : "file",
    },
  };
}

export function printDoctorReport(result: DoctorResult): void {
  console.log("Pi Antigravity Rotator Doctor");
  console.log();
  console.log(`Status: ${result.ok ? "OK" : "ERROR"}`);
  console.log();
  for (const [key, value] of Object.entries(result.info)) {
    console.log(
      `${key}: ${typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null ? value : JSON.stringify(value)}`,
    );
  }
  if (result.warnings.length > 0) {
    console.log();
    console.log("Warnings:");
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }
  if (result.errors.length > 0) {
    console.log();
    console.log("Errors:");
    for (const error of result.errors) console.log(`- ${error}`);
  }
}
