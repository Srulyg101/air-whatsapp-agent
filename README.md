# Air Agent — everyone's AI on WhatsApp

Sign up, scan a QR code, and your WhatsApp has an AI agent. No API keys, no paid AI: everything runs on your own server with open-source models.

## What it does

- **Shared number:** the admin links one WhatsApp number (the "Air number"). Anyone who messages it gets AI replies, with per-person memory.
- **Bring your own number:** any user signs up, scans a QR code from *WhatsApp → Linked devices*, and then:
  - chats with the agent in their **"Message yourself"** chat, and
  - can optionally turn on **auto-reply** so the agent answers people who message them (replies start with 🤖).
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

The installer frees disk space, installs Docker, adds swap on small servers, chooses a model that fits your RAM, and starts everything. Then open `http://YOUR_SERVER_IP`.

## Day-to-day

```bash
docker compose logs -f app          # bot logs
docker compose restart app          # pulls latest code from GitHub on restart
nano .env && docker compose up -d   # change model/name/settings
```

Linked WhatsApp sessions are stored in the `agent-data` volume and reconnect automatically after restarts.

## Adding a domain later

Point an A record at the server, then put Caddy in front for free HTTPS:

```bash
apt install -y caddy
echo 'agent.yourdomain.com { reverse_proxy localhost:80 }' > /etc/caddy/Caddyfile
systemctl reload caddy
```

Set `PUBLIC_PORT=8080` in `.env` (so Caddy can own 80/443), use `reverse_proxy localhost:8080`, set `COOKIE_SECURE=true`, and run `docker compose up -d`.

## Important

This uses WhatsApp's linked-device (WhatsApp Web) protocol through an unofficial open-source library. It is not the official WhatsApp Business API. WhatsApp can change it or ban numbers that look like spam, so: use a dedicated number for the shared bot, keep rate limits on, and don't bulk-message people who didn't write first. For a fully official setup, the WhatsApp Cloud API can be added later as a second connector.
