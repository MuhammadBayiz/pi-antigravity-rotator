# Pi Antigravity Rotator

Reverse proxy that manages multiple Google Antigravity accounts and rotates between them based on real-time quota tracking.

## Setup

### 1. Install

```bash
npm install
```

### 2. Add accounts

Run once per Google account:

```bash
npm run login
```

1. Open the printed URL in your browser
2. Complete the Google sign-in
3. Copy the full URL from your browser (the page won't load -- that's expected)
4. Paste it back into the terminal

The tool automatically:
- Adds the account to `accounts.json` (creates it if missing)
- Configures `~/.pi/agent/models.json` with the proxy `baseUrl`
- Configures `~/.pi/agent/auth.json` with proxy-managed credentials

Repeat for each account. Re-running with the same email updates the existing entry.

### 3. Start the proxy

```bash
npm start
```

### 4. Dashboard

Visit `http://localhost:51200/dashboard` to monitor account status, quota levels, and rotation.

## Configuration

`accounts.json` fields:

| Field | Description |
|-------|-------------|
| `proxyPort` | Proxy listen port (default: 51200) |
| `requestsPerRotation` | Max requests per account before rotating (default: 5) |
| `rotateOnQuotaDrop` | Rotate when any model's quota drops this many percentage points (default: 20). Set to 0 to disable. |
| `quotaPollIntervalMs` | How often to poll Google's quota API in ms (default: 300000 / 5min) |
| `accounts[].email` | Google account email (auto-filled) |
| `accounts[].refreshToken` | OAuth refresh token (auto-filled) |
| `accounts[].projectId` | Cloud project ID (auto-discovered) |
| `accounts[].label` | Display name for dashboard (auto-filled) |

## How It Works

### Proxying

1. Pi sends requests to `localhost:51200` instead of the real Antigravity endpoint
2. The proxy picks the best available account from the pool
3. It swaps the `Authorization` header and `project` field with real credentials
4. The request is forwarded to the real endpoint (cascade: daily -> autopush -> prod)
5. The SSE response is streamed back transparently to pi

### Rotation Strategy

Accounts are selected by **timer priority**:

| Priority | Label | Condition | Rationale |
|----------|-------|-----------|-----------|
| 1 (first) | `fresh` | No active timers | Start the 7-day clock ASAP so it resets sooner |
| 2 | `7d` | On 7-day timer | Already ticking, keep using it |
| 3 (last) | `5h` | On 5-hour timer | Short-lived, save for last (wasted if not fully consumed) |

Within the same tier, the account with the highest remaining quota is selected.

### Rotation Triggers

- **Quota-based** (primary): Polls the Google quota API every 5min. When any model's quota drops by 20% (configurable), rotate.
- **Request-count** (fallback): After `requestsPerRotation` requests, rotate.
- **429 failover** (reactive): On rate limit, mark exhausted and immediately switch.

### Token Management

Tokens are automatically refreshed before expiry. No manual token management needed.

## API

- `GET /dashboard` -- Web dashboard
- `GET /api/status` -- JSON status of all accounts
- `POST /api/enable/<email>` -- Re-enable a disabled account
