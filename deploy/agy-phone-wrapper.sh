#!/data/data/com.termux/files/usr/bin/bash
# Reference template for the phone-side agy launcher (install at ~/.local/bin/agy).
#
# Routes agy through the SHARED rotator on the VPS, reached over a Cloudflare Access
# TCP tunnel (no VPN, no raw IPv6 — cloudflared dials OUT to Cloudflare, which
# bridges to the IPv6-only box). agy's Google calls are account-rotated and exit
# through each account's Decodo residential IP; the client key is presented on the
# CONNECT so the forward proxy is not an open relay. Fail-closed.
#
# Secrets/config live in $PI_ROTATOR_DIR/vps.env (chmod 600) — see vps.env.example.
# The VPS MITM CA must be copied to $PI_ROTATOR_DIR/mitm-certs/kizoo-ca.crt.
set -u

ORIGINAL_AGY="/data/data/com.termux/files/usr/bin/agy"
DIR="${PI_ROTATOR_DIR:-$HOME/.pi-antigravity-rotator}"
ENVFILE="$DIR/vps.env"
CA="$DIR/mitm-certs/kizoo-ca.crt"
SYS_BUNDLE="/data/data/com.termux/files/usr/etc/tls/cert.pem"
BUNDLE="$DIR/agy-ca-bundle.pem"

[ -r "$ENVFILE" ] || { echo "agy: missing $ENVFILE" >&2; exit 1; }
set -a; . "$ENVFILE"; set +a
PORT="${ROTATOR_LOCAL_PORT:-51299}"
HOSTN="${ROTATOR_PROXY_HOSTNAME:?}"
KEY="${ROTATOR_CLIENT_KEY:?}"

port_up() { (exec 3<>/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; }

# 1. Ensure the Cloudflare Access TCP tunnel is up (kept warm across runs).
if ! port_up; then
    pgrep -x cloudflared >/dev/null || \
        TUNNEL_SERVICE_TOKEN_ID="${CF_ACCESS_CLIENT_ID:-}" \
        TUNNEL_SERVICE_TOKEN_SECRET="${CF_ACCESS_CLIENT_SECRET:-}" \
        setsid nohup cloudflared access tcp --hostname "$HOSTN" --url "127.0.0.1:$PORT" \
            >/dev/null 2>&1 </dev/null &
    for _ in $(seq 1 120); do port_up && break; sleep 0.1; done
fi
port_up || { echo "agy: tunnel to $HOSTN not up on :$PORT (fail-closed)." >&2; exit 1; }

# 2. Build agy's CA bundle = system trust + VPS MITM CA (local, not global).
if [ -f "$CA" ] && { [ ! -f "$BUNDLE" ] || [ "$CA" -nt "$BUNDLE" ] || [ "$SYS_BUNDLE" -nt "$BUNDLE" ]; }; then
    cat "$SYS_BUNDLE" "$CA" > "$BUNDLE"
fi
[ -f "$BUNDLE" ] || { echo "agy: missing VPS MITM CA ($CA)." >&2; exit 1; }

# 3. Route agy through the tunnel WITH the client key; block update + telemetry.
PROXY="http://$KEY@127.0.0.1:$PORT"
export HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" ALL_PROXY="$PROXY"
export https_proxy="$PROXY" http_proxy="$PROXY" all_proxy="$PROXY"
export NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"
export SSL_CERT_FILE="$BUNDLE"
export AGY_AUTO_UPDATE=0
export PI_ROTATOR_TELEMETRY=off

exec "$ORIGINAL_AGY" "$@"
