# Deploy the shared rotator on `kizoo-prod`

Runs **one** rotator as a shared API. Both consumers reach it through **Cloudflare Tunnel +
Access** — no VPN, no raw IPv6:
- **CI PR-review Action** → HTTPS `/v1/messages` on `rotator.<domain>` (HTTP ingress).
- **Local agy (phone)** → forward-proxy/MITM over `rotator-proxy.<domain>` (raw-TCP ingress),
  reached with `cloudflared access tcp`. agy has no endpoint override, so it can only be routed
  through a forward proxy — a plain HTTP ingress can't carry its CONNECT, hence the TCP ingress.

The rotator binds **loopback only**; its raw port is never on the internet. cloudflared reaches it
on loopback for both ingresses. Google only ever sees each account's Decodo residential IP (sticky
is tied to the proxy creds, not the client IP, so running from the VPS doesn't change the egress).

Verified facts: `kizoo-prod` is Debian 13, Node 22, **IPv6-only** — Cloudflare's dual-stack anycast
gives both the IPv4-only CI runners and the (VPN-less, IPv4) phone a way in; port 51200 free;
outbound to Google/Decodo works. `cloudflared` 2026.6.1 is already installed on the phone.

---

## 1. Install the rotator

```bash
ssh kizoo-prod
git clone https://github.com/MuhammadBayiz/pi-antigravity-rotator.git pi-antigravity-rotator-fork
cd pi-antigravity-rotator-fork
git checkout bulletproof-proxy
npm ci
npm install -g .        # optional (CLI convenience); the service runs from the repo via node
```

## 2. Move the account pool onto the VPS

From the **phone** (non-interactive per AGENTS.md):

```bash
ssh -o BatchMode=yes kizoo-prod 'mkdir -p ~/.pi-antigravity-rotator && chmod 700 ~/.pi-antigravity-rotator'
scp -o BatchMode=yes ~/.pi-antigravity-rotator/accounts.json kizoo-prod:~/.pi-antigravity-rotator/accounts.json
ssh -o BatchMode=yes kizoo-prod 'chmod 600 ~/.pi-antigravity-rotator/accounts.json'
```

> This is the **Node rotator** `accounts.json` (refresh tokens + Decodo proxies) — *not*
> gemini-worker's Python `accounts.json`. Secrets live only on phone + VPS; never commit or print them.

## 3. Secrets + systemd service

```bash
# On the VPS:
cp deploy/rotator.env.example ~/.pi-antigravity-rotator/rotator.env
# edit it: set PI_ROTATOR_CLIENT_KEYS and PI_ROTATOR_ADMIN_TOKEN to `openssl rand -hex 32` values
chmod 600 ~/.pi-antigravity-rotator/rotator.env

sudo cp deploy/pi-antigravity-rotator.service /etc/systemd/system/
# adjust User=, paths, and the node path (`command -v node`) inside the unit if needed
sudo systemctl daemon-reload
sudo systemctl enable --now pi-antigravity-rotator
systemctl status pi-antigravity-rotator --no-pager
```

First start generates the MITM CA at `~/.pi-antigravity-rotator/mitm-certs/ca.crt` (needed in §6).

Local sanity on the VPS:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:51200/v1/models          # 401 (key required)
curl -s -H "x-api-key: <a-client-key>" http://127.0.0.1:51200/v1/models | head       # 200 + model list
```

## 4. Cloudflare Tunnel (gives the IPv6-only box an IPv4 front door)

```bash
# Install cloudflared (Debian):
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

cloudflared tunnel login
cloudflared tunnel create rotator          # note the <UUID> and creds json path
cloudflared tunnel route dns rotator rotator.<your-domain>

# Fill deploy/cloudflared-config.yml with the UUID + hostname, then:
mkdir -p ~/.cloudflared && cp deploy/cloudflared-config.yml ~/.cloudflared/config.yml
# edit ~/.cloudflared/config.yml: REPLACE_WITH_TUNNEL_UUID and REPLACE_WITH_YOUR_DOMAIN
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

## 5. Cloudflare Access (edge auth before traffic reaches your accounts)

In the Cloudflare **Zero Trust** dashboard:
1. **Access → Service Auth → Create Service Token** → save the `Client ID` + `Client Secret`.
   (Optionally create two tokens — one for CI, one for the phone — for independent revocation.)
2. **Access → Applications → Add → Self-hosted** for **`rotator.<your-domain>`** (the CI HTTP API),
   policy **Action = Service Auth** including the token.
3. Repeat: add a second Self-hosted application for **`rotator-proxy.<your-domain>`** (agy's TCP
   forward proxy), same **Service Auth** policy/token.

Now both hostnames only answer requests carrying the service token — for the CI, the rotator's
client-key is a second independent wall; for agy, the MITM path is exempt from the client-key and
Access is the wall.

Verify from any third machine:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://rotator.<your-domain>/v1/models          # 403 (no CF token)
curl -s -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" \
     -H "x-api-key: <client-key>" https://rotator.<your-domain>/v1/models | head          # 200
```

## 6. Point the phone's agy at the VPS (via Cloudflare — no VPN, no SSH)

agy reaches the rotator through Cloudflare's TCP ingress, so the phone needs neither the VPN nor
raw IPv6 — `cloudflared access tcp` connects out to Cloudflare over IPv4.

First copy the VPS MITM CA to the phone (over the tunnel is fine, or grab it once while on the VPN):

```bash
# on the VPS: print the CA so you can save it on the phone
cat ~/.pi-antigravity-rotator/mitm-certs/ca.crt
# on the phone: save it to ~/.pi-antigravity-rotator/mitm-certs/kizoo-ca.crt
```

Then Claude rewires `~/.local/bin/agy` + the SessionStart hook so that each run:
1. Starts (if down) a background `cloudflared access tcp` that authenticates with the CF Access
   service token and exposes the VPS rotator as a local port:
   ```bash
   cloudflared access tcp \
     --hostname rotator-proxy.<your-domain> \
     --url 127.0.0.1:51200 \
     --service-token-id "$CF_ACCESS_CLIENT_ID" \
     --service-token-secret "$CF_ACCESS_CLIENT_SECRET"
   ```
2. Exports `HTTPS_PROXY=http://127.0.0.1:51200` (+ HTTP_PROXY/ALL_PROXY/lowercase),
   `SSL_CERT_FILE=<phone kizoo-ca.crt>`, `AGY_AUTO_UPDATE=0`, `PI_ROTATOR_TELEMETRY=off`; then `exec`s agy.

No local rotator and no accounts on the phone; the CF Access service token + the VPS CA are the only
things stored locally.

## 7. GitHub Action

Add `deploy/pr-review.yml` to the review repo as `.github/workflows/pr-review.yml`, and set repo
secrets `ROTATOR_URL` (`https://rotator.<your-domain>`), `CF_ACCESS_CLIENT_ID`,
`CF_ACCESS_CLIENT_SECRET`, `ROTATOR_KEY`. Default model is `gemini-3-pro-high` — change it in the
workflow if you prefer another catalog id.

---

## Verification checklist (end-to-end)
- [ ] VPS `curl 127.0.0.1:51200/v1/models` → 401; with `x-api-key` → 200.
- [ ] External `curl https://rotator.<domain>/v1/models` → 403; with CF token + `x-api-key` → 200.
- [ ] `workflow_dispatch`/test PR → review comment posted; rotator logs show rotation + Decodo egress.
- [ ] Phone `agy` task runs (VPN **off**) via `cloudflared access tcp`; VPS logs show account
      rotation + Decodo egress; `ss -tnp` on the VPS shows **no** direct Google connection from the box IP.
- [ ] Kill the `cloudflared access tcp` client → agy fails (never falls back to the real IP).
