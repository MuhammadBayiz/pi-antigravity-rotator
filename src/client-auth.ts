import type { IncomingMessage, ServerResponse } from "node:http";
import { getConfiguredAdminToken, getRequestAdminToken } from "./admin-auth.js";

// Client-key authentication for the *externally reachable* serving routes
// (the OpenAI/Anthropic/Gemini compat endpoints and the native Code Assist
// reverse routes). This is distinct from the admin token, which guards the
// dashboard + /api/* management surface.
//
// Why a separate key: once the rotator is exposed as a shared API (e.g. behind
// a Cloudflare Tunnel for a CI consumer), the model-serving routes would
// otherwise be an open relay to the Google account pool. A per-consumer client
// key lets us gate them (defense-in-depth behind Cloudflare Access) and revoke
// a leaked key without touching the admin token.
//
// agy's forward-proxy (MITM) traffic is exempt: it arrives on a MITM-terminated
// socket that only exists because the client already authenticated to reach the
// rotator (loopback / SSH tunnel), and agy speaks Google's protocol with a
// Google token — it has no way to present our client key. Such sockets are
// tagged `__mitmAuthorized` in mitm.ts and bypass this guard.

interface ClientAuthRequest {
  url?: string;
  headers: IncomingMessage["headers"];
  // The real request socket (net.Socket / tls.TLSSocket); we only read our own
  // `__mitmAuthorized` marker off it, so it's typed loosely here.
  socket?: unknown;
}

/**
 * Parse the configured client keys from `PI_ROTATOR_CLIENT_KEYS`
 * (comma-separated). Empty/whitespace entries are ignored. An empty set means
 * "no client keys configured" -> the guard stays open (preserves the local
 * loopback default where no auth is expected).
 */
export function getConfiguredClientKeys(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const raw = env.PI_ROTATOR_CLIENT_KEYS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0),
  );
}

/**
 * Extract the client key a request is presenting, from the headers a normal AI
 * client would send:
 *   - `x-rotator-client-key` (explicit)
 *   - `x-api-key`            (Anthropic SDK / Messages API clients)
 *   - `Authorization: Bearer <key>` (OpenAI SDK clients)
 */
export function getRequestClientKey(req: ClientAuthRequest): string | null {
  const explicit = req.headers["x-rotator-client-key"];
  if (typeof explicit === "string" && explicit) return explicit;
  if (Array.isArray(explicit) && explicit[0]) return explicit[0];

  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  if (Array.isArray(apiKey) && apiKey[0]) return apiKey[0];

  const authorization = req.headers.authorization;
  if (
    typeof authorization === "string" &&
    authorization.toLowerCase().startsWith("bearer ")
  ) {
    const token = authorization.slice("bearer ".length).trim();
    if (token) return token;
  }

  return null;
}

/**
 * True if a bare value is a valid client key (or the configured admin token).
 * Used by paths that already have the credential in hand (not a full request).
 */
export function clientKeyValueOk(
  value: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!value) return false;
  const keys = getConfiguredClientKeys(env);
  if (keys.has(value)) return true;
  const adminToken = getConfiguredAdminToken(env);
  return !!adminToken && value === adminToken;
}

/**
 * Authorization decision for a serving-route request.
 *  1. MITM-terminated sockets (agy) are always allowed — see the module note.
 *  2. If no client keys are configured, the guard is open (loopback default).
 *  3. Otherwise a valid client key OR the admin token is required.
 */
export function isClientAuthorized(req: ClientAuthRequest): boolean {
  const sock = req.socket as { __mitmAuthorized?: boolean } | null | undefined;
  if (sock && sock.__mitmAuthorized === true) return true;

  const keys = getConfiguredClientKeys();
  if (keys.size === 0) return true;

  const presented = getRequestClientKey(req);
  if (presented && keys.has(presented)) return true;

  // A valid admin token is a superset credential (accepted only if one is set).
  const adminToken = getConfiguredAdminToken();
  if (adminToken && getRequestAdminToken(req) === adminToken) return true;

  return false;
}

/**
 * Guard wrapper: returns true if the request may proceed; otherwise writes a
 * 401 and returns false (mirrors requireAdmin's shape).
 */
export function requireClientKey(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (isClientAuthorized(req)) return true;
  res.writeHead(401, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "WWW-Authenticate": "Bearer",
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
  return false;
}
