# Air Agent — WhatsApp + AI

**Scan any WhatsApp number. Done.** Link a WhatsApp number you control, configure who the AI can answer, and run your own private open-source model. The refreshed UI includes connection onboarding, reply controls, a Command Center, an optional bot inbox, and monitoring.

**New feature branch:** [Air Agent 2 Hostinger release guide](docs/DEPLOY_HOSTINGER.md). The production `main` branch and the existing Hostinger VPS must be deployed separately.

Sign up, scan a QR code, and your WhatsApp has an AI agent. No API keys, no paid AI: everything runs on your own server with open-source models.

## What it does

- **Shared number:** the admin links one WhatsApp number (the "Air number"). Anyone who messages it gets AI replies, with per-person memory.
- **Bring your own number:** any user signs up, scans a QR code from *WhatsApp → Linked devices*, and then:
  - chats with the agent in their **"Message yourself"** chat, and
  - can optionally turn on **auto-reply** for an explicit approved list of international phone numbers only (replies start with 🤖); unknown contacts never trigger a personal agent.
- Group replies only when the bot is @mentioned (off by default).
- Custom personality/instructions per number.
- `/help` and `/reset` commands inside WhatsApp.
- Admin **Monitor** tab: AI engine status, model, users, linked numbers, message volume, reply speed, server RAM/load.
- `/health` (for uptime monitors) and `/metrics` (Prometheus format).
- Optional **Uptime Kuma** dashboard on port 3001.

## Stack (all open source)

| Part | Project |
|---|---|
| WhatsApp link (QR, multi-device) | [Baileys](https://github.com/WhiskeySockets/Baileys) |
| AI runtime | [Ollama](https://ollama.com) |
| Default models | Qwen 2.5 (1.5B / 3B / 7B, picked by server RAM) |
| App | Node.js + Express + SQLite |
| Monitoring | Built-in dashboard + Uptime Kuma |

## Install on a VPS (Ubuntu/Debian)

**Option A – Hostinger Docker Manager (no terminal):** VPS → Docker Manager → Compose → *From URL* →
`https://github.com/Srulyg101/air-whatsapp-agent` → Deploy.

**Option B – terminal:**

```bash
git clone https://github.com/Srulyg101/air-whatsapp-agent.git air-agent && cd air-agent
sudo bash install.sh
```

The installer frees disk space, installs Docker, adds swap on small servers, chooses a model that fits your RAM, and starts everything. The hardened dashboards are loopback-only; configure private access and HTTPS per [the release guide](docs/DEPLOY_HOSTINGER.md).

## Day-to-day

```bash
docker compose logs -f app          # bot logs
docker compose restart app          # pulls latest code from GitHub on restart
nano .env && docker compose up -d   # change model/name/settings
```

Linked WhatsApp sessions are stored in the `agent-data` volume and reconnect automatically after restarts.

## Adding a domain later

Point an A record at the server, then put Caddy in front for free HTTPS (keep Docker ports on loopback):

```bash
apt install -y caddy
echo 'agent.yourdomain.com { reverse_proxy localhost:8080 }' > /etc/caddy/Caddyfile
systemctl reload caddy
```

Keep `COOKIE_SECURE=true` and `BIND_IP=127.0.0.1`, then run `docker compose up -d`.

## Important

This uses WhatsApp's linked-device (WhatsApp Web) protocol through an unofficial open-source library. It is not the official WhatsApp Business API. WhatsApp can change it or ban numbers that look like spam, so: use a dedicated number for the shared bot, keep rate limits on, and don't bulk-message people who didn't write first. For a fully official setup, the WhatsApp Cloud API can be added later as a second connector.

## Security-first setup (hardening branch)

**This security work lives on a review branch.** It is not deployed automatically. Your existing Docker app executes `git pull` from its checkout when it starts; merging into `main` may therefore deploy on its next restart. Review, back up the data volume, and coordinate deployment before merging.

- By default `OPEN_SIGNUP=false`. Existing accounts are retained. No new accounts can register once the first admin exists.
- On a **new** server, set a unique random `BOOTSTRAP_ADMIN_TOKEN` of at least **24 characters** in the private Hostinger deployment variables **before** creating the very first account. Supply it in the "Initial admin setup token" field. Remove the variable once the admin exists. Existing admins don't need to repeat setup.
- `COOKIE_SECURE=true` by default. **The dashboard requires an HTTPS frontend** for authenticated sessions. Do not turn off Secure cookies on public HTTP.
- The app and Uptime Kuma ports bind by default to `127.0.0.1:8080` and `127.0.0.1:3001` on the VPS. They're inaccessible directly from the internet. For secure access, configure Caddy on HTTPS; for diagnostics use an SSH tunnel: `ssh -L 8080:127.0.0.1:8080 -L 3001:127.0.0.1:3001 user@VPS_IP`. Configure Uptime Kuma's own admin account privately; ideally keep it loopback-only.
- `/metrics` requires an authenticated administrator rather than exposing user/session metadata publicly.
- Personal WhatsApp defaults to **no incoming auto-replies**. Even if an old setting enabled auto-reply or group replies, the agent must match the sender's **exact international phone number** against the allow list. Empty allow list, or opaque `@lid` without a resolvable phone JID, means **no reply**. The shared dedicated "Air number" keeps its intentional public-reply behavior.
- The emergency **Disconnect all WhatsApp sessions** button (admin only) logs out live sessions and deletes stored linked-device credentials. **Also verify WhatsApp → Linked Devices on every phone**, especially if a session was offline when the button was used.
- Session-key folders and SQLite files are created with restrictive owner-only permissions. The reply audit stores only the masked peer's last four phone digits (when available), action, send-submission result, and timestamp; no message text. Audit rows follow the configured chat-data retention period. Legacy browser tokens are invalidated once and new tokens are hashed in SQLite.
- A `submitted` audit event means WhatsApp accepted the send call; it **does not** prove delivery or reading.
- To run standalone sender-policy checks, use `npm test` after installing dependencies. Test on a disposable WhatsApp number before reconnecting a personal account.
- The initial hardening does **not** prove the VPS was never compromised; inspect Hostinger/VPS network and sign-in logs and rotate impacted credentials separately.

### Before approving deployment
1. Ensure the VPS has a working HTTPS reverse proxy and a private dashboard route.
2. Set `OPEN_SIGNUP=false` and `COOKIE_SECURE=true` in the **actual** Hostinger environment (explicit old values override code defaults).
3. Back up `agent-data` securely. Review any existing dashboard users and WhatsApp Linked Devices.
4. Run `npm test`, verify the settings API blocks enabling personal auto-replies without an allow list, test the audit and emergency switch using disposable numbers, then approve merging.

## Air Agent 2 features (review branch)

- **Modern dashboard:** WhatsApp-inspired responsive interface with a clear one-scan onboarding journey.
- **Safer AI replies:** add/remove approved and blocked phone numbers, one-time replies per verified contact, reply cooldown, quiet hours, formatting, manual triggers, and an optional ten-message observed chat context window.
- **Command Center:** messages from approved control numbers with a separate hashed PIN can request status, pause/resume, or email an allowlisted recipient. Commands never become unrestricted shell/AI actions.
- **Bot email:** optional unique per-agent address, a private inbox, an outbound Resend adapter, and a signed inbound relay endpoint. **Email is not live until you configure a verified domain and a real inbound routing provider.**
- **Controlled deployment:** a manual GitHub Actions production release path with approved SHA, root-only data backup and SSH host verification.

For security details, configuration, test strategy and an explicit Hostinger rollout checklist, use [docs/DEPLOY_HOSTINGER.md](docs/DEPLOY_HOSTINGER.md). **Do not deploy this branch by simply restarting the old auto-pull production container.**
