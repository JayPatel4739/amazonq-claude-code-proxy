# Amazon Q Claude Proxy

**Disclamer**: This whole project is vibe coded with claude code  and in that also antigravity's proxy is used, so use it accordingly (I don't know much about `js` so don't know what is written in this), it could have vulnerabilities. If you find any vulnerabilities in this you can contribute in this project and improve it. 

This is project is inspired from the another project just like this, this is the project link: [https://github.com/badrisnarayanan/antigravity-claude-proxy](https://github.com/badrisnarayanan/antigravity-claude-proxy)

A proxy server that lets you use Claude models in **Claude Code CLI** by routing requests through **Amazon Q Developer's** infrastructure.

It exposes an Anthropic-compatible Messages API (`/v1/messages`) and translates requests to Amazon Q's CodeWhisperer chat API behind the scenes.

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────────────┐
│  Claude Code │────▶│  This Proxy      │────▶│  Amazon Q CodeWhisperer │
│  (Anthropic  │     │  (Anthropic →    │     │  (codewhisperer.        │
│   API format)│     │   Q format)      │     │   us-east-1.amazonaws.  │
└──────────────┘     └──────────────────┘     │   com)                  │
                              │               └─────────────────────────┘
                     ┌────────┴────────┐
                     │  Web Dashboard  │
                     │  (localhost:9090)│
                     └─────────────────┘
```

## Features

- **Standalone authentication** — Sign in directly via browser using AWS SSO device flow. No VS Code extension required.
- **Multi-account support** — Add multiple AWS SSO accounts and load balance between them.
- **Load balancing strategies** — Sticky, round-robin, or hybrid (health-score weighted).
- **Web dashboard** — Real-time status, account management, request logs, usage charts, and settings.
- **Auto rate limit handling** — Per-account, per-model rate limit tracking with automatic failover to the next available account.
- **Claude Code auto-config** — One-click configuration of `~/.claude/settings.json` from the dashboard.
- **Tool use emulation** — Translates Anthropic's tool_use protocol via prompt engineering so Claude Code's tools work through Q.

## Prerequisites

- **Node.js** >= 18 ([download](https://nodejs.org/))
- **AWS Builder ID** (free) — this is what gives you access to Amazon Q Developer

### What is Amazon Q Developer?

Amazon Q Developer is AWS's AI coding assistant. Its **Free Tier** includes access to Claude models (Sonnet, Opus, Haiku) at no cost. This proxy routes Claude Code requests through Amazon Q's infrastructure, so you get Claude models without needing a paid Anthropic API key.

### Creating an AWS Builder ID (Free)

An AWS Builder ID is a free personal account — it is **not** an AWS account and does **not** require a credit card.

1. Go to [https://profile.aws.amazon.com/](https://profile.aws.amazon.com/)
2. Click **Create Builder ID**
3. Enter your email address
4. Verify your email with the code sent to your inbox
5. Set your name and password
6. Done — you now have access to Amazon Q Developer Free Tier

> **Note:** If your organization uses **AWS IAM Identity Center** (formerly AWS SSO), you can use that instead of a Builder ID. Ask your AWS admin for your Start URL (e.g. `https://your-org.awsapps.com/start`).

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/JayPatel4739/amazonq-claude-code-proxy
cd amazonq-claude-proxy
npm install

# 2. Start the server
npm start
#    The web dashboard opens at http://localhost:9090

# 3. Add an account (you need at least one)

# Option A: Via web dashboard (recommended)
#   Open http://localhost:9090 → Accounts → Add Account
#   Use default Start URL for Builder ID, or enter your org's URL
#   Sign in via the browser window that opens

# Option B: Via CLI
npm run accounts

# 4. Configure Claude Code (choose one method)

# Option A: Via dashboard (recommended)
#   Open http://localhost:9090 → Settings → Apply Proxy Config
#   This automatically updates ~/.claude/settings.json for you

# Option B: Manually add to ~/.claude/settings.json:
```

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:9090",
    "ANTHROPIC_API_KEY": "amazonq"
  }
}
```

> **Note:** The `ANTHROPIC_API_KEY` value can be anything — the proxy ignores it. Claude Code just requires it to be set.

```bash
# 5. Start Claude Code (in a separate terminal)
claude
```

If everything is set up correctly, Claude Code will route all requests through this proxy to Amazon Q.

## Commands

```bash
npm start                        # Start server (default port 9090)
npm run dev                      # Start with auto-reload on file changes
npm run accounts                 # Interactive CLI for account management
npm start -- --debug             # Enable verbose debug logging
npm start -- --strategy=sticky   # Set load balancing strategy
PORT=8080 npm start              # Custom port
```

## Docker

```bash
# Build the image
docker build -t amazonq-claude-proxy .

# Run the container (first time)
docker run --name amazonq-claude-proxy -p 9090:9090 \
  -v ~/.amazonq-claude-proxy:/root/.amazonq-claude-proxy \
  amazonq-claude-proxy

# Start existing container with logs
docker start -a amazonq-claude-proxy
```

> **Note:** The volume mount (`-v`) shares your account credentials from the host into the container. Make sure you've added at least one account before running via Docker.

## Web Dashboard

Visit `http://localhost:9090` after starting the server.


| View          | Description                                                                 |
| ------------- | --------------------------------------------------------------------------- |
| **Dashboard** | Server uptime, total requests, account health, 24-hour usage chart          |
| **Accounts**  | Add/remove accounts, enable/disable, refresh tokens, view rate limit status |
| **Logs**      | Real-time request log viewer with status/model filtering                    |
| **Models**    | List of available Claude models                                             |
| **Settings**  | Load balancing strategy, Claude Code config, server info                    |


## Adding Accounts

You need at least one account for the proxy to work. Each account authenticates via AWS SSO device authorization flow — the proxy opens your browser, you sign in, and the token is saved automatically.

### Via Web Dashboard

1. Open `http://localhost:9090`
2. Go to **Accounts** → click **Add Account**
3. Enter your AWS Start URL:
  - **Builder ID users:** use the default `https://view.awsapps.com/start`
  - **IAM Identity Center users:** use your organization's start URL (e.g. `https://your-org.awsapps.com/start`)
4. Select your AWS region (default: `us-east-1`)
5. Click **Start Auth** — a browser window opens
6. Sign in with your Builder ID (or IAM Identity Center credentials)
7. Authorize the "AWS IDE Extensions" access request when prompted
8. The browser shows "Authorization successful" — switch back to the dashboard
9. The account appears automatically within a few seconds

### Via CLI

```bash
npm run accounts
# Select "2. Add account"
# Enter start URL (press Enter for default Builder ID URL)
# Enter region (press Enter for us-east-1)
# A browser window opens — sign in and authorize
# The CLI confirms once authentication is complete
```

### Why Add Multiple Accounts?

Amazon Q's Free Tier has rate limits per account. By adding multiple accounts (e.g. multiple Builder IDs), the proxy automatically distributes requests across them. When one account hits a rate limit, requests are routed to the next available account — giving you uninterrupted usage.

You can add multiple accounts. The proxy will automatically distribute requests across them based on the selected strategy.

## Load Balancing Strategies


| Strategy             | Description                                                                   | Best For                                   |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| **Sticky**           | Stay on one account until it's rate-limited, then switch                      | Single account or predictable usage        |
| **Round-Robin**      | Rotate through accounts on each request                                       | Even distribution across accounts          |
| **Hybrid** (default) | Health-score weighted selection. Scores decay on failures, recover on success | Multiple accounts with varying reliability |


Change the strategy via:

- Dashboard: Settings → Strategy selector
- CLI: `npm run accounts` → "Change strategy"
- Flag: `npm start -- --strategy=round-robin`
- Env: `ACCOUNT_STRATEGY=sticky npm start`

## Token Expiration & Renewal

The proxy handles two types of tokens for each account:

### Access Token (expires every ~1 hour)

This is the short-lived token used for API calls. The proxy **automatically refreshes** it using the refresh token — no action needed from you. You'll see in logs:

```
[Auth] Refreshing expired token... → Token refreshed successfully
```

### Refresh Token (expires after ~8-24 hours of inactivity)

This is the longer-lived token used to get new access tokens. It expires if the proxy is stopped for an extended period. When this happens, the account is marked as **invalid** in the dashboard.

**To re-authenticate an invalid account:**

1. Open the dashboard → **Accounts**
2. Click **Re-auth** next to the invalid account
3. A browser window opens — sign in again with your Builder ID
4. The account returns to **active** status

> **Tip:** If you have multiple accounts, the proxy automatically fails over to another available account while one is invalid — so you won't experience downtime.

## API Endpoints

### Anthropic-Compatible


| Method | Endpoint                    | Description                                        |
| ------ | --------------------------- | -------------------------------------------------- |
| POST   | `/v1/messages`              | Anthropic Messages API (streaming + non-streaming) |
| GET    | `/v1/models`                | List available models                              |
| POST   | `/v1/messages/count_tokens` | Not implemented (returns 501)                      |


### Management


| Method | Endpoint         | Description                      |
| ------ | ---------------- | -------------------------------- |
| GET    | `/health`        | Health check with account status |
| POST   | `/refresh-token` | Force token refresh              |


### Dashboard API


| Method | Endpoint                    | Description                            |
| ------ | --------------------------- | -------------------------------------- |
| GET    | `/api/status`               | Server status, uptime, account summary |
| GET    | `/api/accounts`             | List accounts (no tokens exposed)      |
| POST   | `/api/accounts`             | Start add-account flow                 |
| DELETE | `/api/accounts/:id`         | Remove account                         |
| PATCH  | `/api/accounts/:id`         | Update account (enable/disable/label)  |
| POST   | `/api/accounts/:id/refresh` | Force token refresh for account        |
| GET    | `/api/strategy`             | Current strategy info                  |
| PUT    | `/api/strategy`             | Change strategy                        |
| GET    | `/api/stats/history`        | Usage stats (hourly bucketed)          |
| GET    | `/api/logs`                 | Recent request logs                    |
| GET    | `/api/claude-config`        | Claude Code settings status            |
| POST   | `/api/claude-config`        | Apply/remove proxy config              |


## Environment Variables


| Variable           | Description             | Default   |
| ------------------ | ----------------------- | --------- |
| `PORT`             | Server port             | `9090`    |
| `HOST`             | Bind address            | `0.0.0.0` |
| `DEBUG`            | Enable debug logging    | `false`   |
| `ACCOUNT_STRATEGY` | Load balancing strategy | `hybrid`  |


## Data Storage

All data is stored in `~/.amazonq-claude-proxy/`:


| File                 | Contents                                           |
| -------------------- | -------------------------------------------------- |
| `accounts.json`      | Account credentials, settings, active strategy     |
| `usage-history.json` | Hourly request counts per model (30-day retention) |


No data is stored inside the project directory. Safe to push to GitHub.

## Troubleshooting

**"No accounts configured" on startup**
You need to add at least one account before the proxy can handle requests. Visit `http://localhost:9090` → Accounts → Add Account, or run `npm run accounts`.

**Browser doesn't open during authentication**
If the browser doesn't open automatically, look for the authorization URL in the terminal output and copy-paste it into your browser manually.

**"Authorization pending" takes too long**
Make sure you completed the sign-in in the browser and clicked "Allow" on the authorization page. The proxy polls for up to 5 minutes before timing out — if it expires, just try adding the account again.

`**EADDRINUSE` error on startup**
Another process is using port 9090. Either stop that process or use a different port:

```bash
PORT=8080 npm start
```

If using a custom port, update `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` to match.

**All accounts rate-limited**
The proxy returns HTTP 429 with a `Retry-After` header. Options:

- Wait for the cooldown period to pass (usually 1-2 minutes)
- Add more accounts to increase your rate limit pool
- Rate limits reset approximately every minute per account

**Account shows "Invalid"**
The refresh token expired (usually after 8-24 hours of inactivity). Click **Re-auth** in the dashboard or re-run `npm run accounts` to re-authenticate.

**Very short or odd responses**
Amazon Q may truncate responses for certain queries. This is a limitation of the upstream API, not the proxy.

**Claude Code not connecting**

1. Make sure the proxy is running (`npm start`)
2. Check `~/.claude/settings.json` has the correct settings:
  ```json
   {
     "env": {
       "ANTHROPIC_BASE_URL": "http://localhost:9090",
       "ANTHROPIC_API_KEY": "amazonq"
     }
   }
  ```
3. Restart Claude Code after changing settings
4. Visit `http://localhost:9090/health` to verify the proxy is responding

**"No available accounts" error on requests**
All accounts are either disabled, rate-limited, or have invalid tokens. Check the dashboard Accounts page to see the status of each account and re-auth or enable as needed.