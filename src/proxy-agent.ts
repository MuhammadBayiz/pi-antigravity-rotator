// Shared per-account outbound proxy dispatcher (SOCKS5/HTTP) for undici fetch.
// Used anywhere we forward a request on behalf of a specific account so its
// traffic goes out through that account's assigned proxy rather than the
// device's own IP.
//
// Fail-closed policy: an account with no proxy configured must NEVER have its
// traffic sent over the device's real IP -- that is exactly the leak that gets
// Google accounts flagged. Call sites use requireProxyDispatcher(), which throws
// NoProxyConfiguredError rather than returning `undefined` (which undici treats
// as "use the default global dispatcher" == the real IP).

import { ProxyAgent } from "undici";
import { socksDispatcher } from "fetch-socks";

/**
 * Build an undici dispatcher that routes a request through the given proxy.
 *
 * DNS is always resolved remotely (no local lookup, no DNS leak):
 *  - SOCKS5: fetch-socks/socks pass the target hostname to the proxy as an
 *    ATYP=domain address (socks5h semantics) as long as we hand it a hostname
 *    and never pre-resolve it ourselves. Both socks5:// and socks5h:// are
 *    accepted and behave identically (remote resolution).
 *  - HTTP/HTTPS: undici ProxyAgent tunnels via HTTP CONNECT, so the proxy does
 *    the hostname resolution. This matches the residential (Decodo) setup.
 */
export function getProxyAgent(proxyUrl: string): any {
  if (proxyUrl.startsWith("socks5://") || proxyUrl.startsWith("socks5h://")) {
    const parsed = new URL(proxyUrl);
    return socksDispatcher({
      type: 5,
      host: parsed.hostname,
      port: parseInt(parsed.port, 10) || 1080,
      userId: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    });
  }
  return new ProxyAgent({ uri: proxyUrl });
}

/**
 * Thrown when a request would be made for an account that has no outbound proxy.
 * Fail-closed: the caller must skip/disable the account rather than leak the
 * real device IP to Google.
 */
export class NoProxyConfiguredError extends Error {
  constructor(accountLabel?: string) {
    super(
      `No outbound proxy configured for account${accountLabel ? ` "${accountLabel}"` : ""}. ` +
        `Refusing to send its traffic over the device's real IP (fail-closed). ` +
        `Add a proxy to this account (login with --proxy <url>) before using it.`,
    );
    this.name = "NoProxyConfiguredError";
  }
}

/**
 * Fail-closed replacement for the old `proxy ? getProxyAgent(proxy) : undefined`
 * pattern. Returns a dispatcher when a proxy is set, and THROWS otherwise so no
 * request can ever silently fall back to the device's real IP.
 */
export function requireProxyDispatcher(
  proxyUrl: string | undefined | null,
  accountLabel?: string,
): any {
  if (!proxyUrl || !proxyUrl.trim()) {
    throw new NoProxyConfiguredError(accountLabel);
  }
  return getProxyAgent(proxyUrl);
}

/** True when the account has a usable (non-empty) proxy string configured. */
export function hasProxyConfigured(proxyUrl: string | undefined | null): boolean {
  return !!proxyUrl && proxyUrl.trim().length > 0;
}

/**
 * Confirm the proxy actually carries traffic and return the public egress IP
 * (what Google will see), using the SAME undici dispatcher the runtime uses.
 * Returns null on any failure so callers can fail-closed.
 */
export async function verifyProxyEgress(proxyUrl: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.ipify.org?format=text", {
      dispatcher: getProxyAgent(proxyUrl),
      signal: AbortSignal.timeout(15_000),
    } as unknown as RequestInit);
    if (!res.ok) return null;
    const ip = (await res.text()).trim();
    return /^[0-9a-fA-F:.]+$/.test(ip) && ip.length >= 4 ? ip : null;
  } catch {
    return null;
  }
}
