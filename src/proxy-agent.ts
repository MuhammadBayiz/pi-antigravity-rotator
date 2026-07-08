// Shared per-account outbound proxy dispatcher (SOCKS5/HTTP) for undici fetch.
// Used anywhere we forward a request on behalf of a specific account so its
// traffic goes out through that account's assigned proxy rather than the
// device's own IP.

import { ProxyAgent } from "undici";
import { socksDispatcher } from "fetch-socks";

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
