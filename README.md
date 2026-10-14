# Air Agent — everyone's AI on WhatsApp

Scan a QR code and your WhatsApp has an AI assistant that knows your business, listens to voice notes,
and gets things done. Open-source AI by default, runs on your own server.

## What it does

- **Reply rules** — choose exactly who it answers: *only me* (default), *people I choose*, or *everyone*.
  Block list, groups (off / when @mentioned / chosen groups), quiet hours, away message,
  and **automatic hand-off**: when you type in a chat yourself, the AI steps back.
- **Knowledge & prompts** — tell it who it works for, its tone and rules, add FAQs, and upload
  PDF / Word / Excel / CSV / text files. It looks up the right part of your files for each question.
  You can also send a file to yourself in WhatsApp with the caption `/learn`.
- **Voice notes** — understands voice notes (open-source Whisper on the server, or a fast speech API),
  and can answer with a voice note.
- **Actions** — just ask in WhatsApp: send emails (your SMTP/Gmail), place phone calls that speak a message
  (Twilio for now), send WhatsApp messages, set reminders, save notes/leads, notify you when someone needs
  a person, and trigger webhooks (Zapier, Make, n8n, CRM). Risky actions ask "yes / no" first.
- **Bring your own AI** — server model by default (Ollama), or each user can plug in any OpenAI-compatible
  provider (Groq, OpenRouter, Together, DeepSeek, OpenAI, self-hosted vLLM…).
- **Conversations** — see what the AI answered, pause it per chat, clear its memory.
- **Test your AI** — a playground that uses your real prompts and knowledge, with actions simulated.
- **Admin** — create users (public sign-up is off by default), server AI model, download local models,
  speech API, live stats, and an emergency **Disconnect all WhatsApp** button.
- **Shared Air number** — the admin can link one number that answers everyone.

## Security defaults

- New numbers only answer their owner until the owner changes Reply rules.
- Public sign-ups are **off**; the first account becomes admin and creates the others.
- API keys and passwords are encrypted at rest (AES-256-GCM).
- Cross-site requests are blocked, strict Content-Security-Policy, login rate limiting.
- Uptime Kuma is bound to `127.0.0.1` (open it through an SSH tunnel).
- Only messages the AI actually answered are stored (for its memory), and they are deleted after `RETENTION_DAYS`.

## Install on a VPS

**Hostinger Docker Manager (no terminal):** VPS → Docker Manager → Compose → *From URL* →
`https://github.com/Srulyg101/air-whatsapp-agent` → Deploy.

**Terminal:**

```bash
git clone https://github.com/Srulyg101/air-whatsapp-agent.git air-agent && cd air-agent
sudo bash install.sh
```

Then open `http://YOUR_SERVER_IP:8080` and create the first account (it becomes admin).

## Updating

The app container pulls the latest code from GitHub every time it restarts, so pushing to `main`
and restarting the `app` container deploys it. Changes to `docker-compose.yml` need a redeploy of the compose project.

## Adding a domain + HTTPS

Point an A record at the server, then put Caddy in front:

```bash
apt install -y caddy
echo 'agent.yourdomain.com { reverse_proxy localhost:8080 }' > /etc/caddy/Caddyfile
systemctl reload caddy
```

## Notes

- WhatsApp linking uses the unofficial [Baileys](https://github.com/WhiskeySockets/Baileys) library
  (WhatsApp Web protocol). WhatsApp may disconnect or restrict numbers that behave like bots — avoid
  mass messaging, and prefer the "Only me" / "People I choose" modes on personal numbers.
- The first local voice note downloads the Whisper model (~80 MB) into the data volume.
