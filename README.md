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
- **Smarter AI in one click** — server model by default (Ollama), or *Sign in & connect* through OpenRouter
  (ChatGPT, Claude, Llama, Qwen, DeepSeek) with no API keys to copy. Use an OpenAI API key for GPT, or an Anthropic API key for Claude. OpenRouter sign-in can also connect you to GPT, Claude, and other models. ChatGPT or Claude consumer subscriptions are not API credentials.
- **Bot email** — connect any mailbox (IMAP) or claim `name@yourdomain`; WhatsApp alerts for new mail, and the AI can read and reply.
- **Command numbers** — your other phones or trusted people can command the AI as if they were you.
- **Chat context** — reads the last messages of the chat (in memory only) so replies fit the conversation.
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

Then open `http://YOUR_SERVER_IP:8080` and create the first account (it becomes admin). OpenRouter sign-in requires a public HTTPS domain (except localhost); configure HTTPS before using that button.

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

## Bot email addresses (optional)

Users can connect any mailbox over IMAP without this. To also give every assistant its own
`name@yourdomain` address:

1. Admin page → **Bot email domain**: enter a domain you control (e.g. `bots.yourdomain.com`), copy the webhook URL and secret.
2. Cloudflare → Email → **Email Routing** for that domain → create an **Email Worker**:

```js
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).text();
    await fetch(env.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': env.SECRET },
      body: JSON.stringify({ to: message.to, raw }),
    });
  },
};
```

   Set `WEBHOOK_URL` and `SECRET` as Worker variables, then add a **catch-all** routing rule → this Worker.
3. For sending from those addresses, add SMTP for the domain (Resend, Mailgun, Brevo, SES…) on the same Admin card.

## WeChat integration status

WeChat is not connected yet. See [WeChat integration requirements](docs/wechat-integration-requirements.md) for the supported account types and access required before a compliant integration can be built.

## Notes

- WhatsApp linking uses the unofficial [Baileys](https://github.com/WhiskeySockets/Baileys) library
  (WhatsApp Web protocol). WhatsApp may disconnect or restrict numbers that behave like bots — avoid
  mass messaging, and prefer the "Only me" / "People I choose" modes on personal numbers.
- The first local voice note downloads the Whisper model (~80 MB) into the data volume.


## Air Smart AI: low-cost managed provider

Customers use the default **Air Smart AI** without their own API keys. On the admin page click **Select Groq GPT-OSS 20B + Whisper**; provide one Groq API key under **Air Smart AI**, then **Save**. This chooses the Groq chat-completions endpoint (`openai/gpt-oss-20b`) and Whisper Turbo speech-to-text. Never paste the key into GitHub or client-side JavaScript.

Alternatively, set `GROQ_API_KEY` in the server environment (not tracked in git). When no admin AI provider is configured, the server picks managed GPT-OSS automatically. If neither Groq key nor admin provider is available, local Ollama and local Whisper remain available. The server's managed provider API cost is paid by the operator, not by individual customer accounts.

**Voice notes:** On each connected number choose **Voice notes → Air Smart Voice** to use Groq Whisper when set up, or local Whisper if not. Incoming WhatsApp OGG/Opus voice notes are transcribed and passed to the text agent. This does not add WhatsApp voice call support or spoken reply synthesis. Test with English, Hebrew, Yiddish, and mixed-language audio before relying on multilingual accuracy.

**Cost controls:** AI responses use a low reasoning effort on Groq GPT-OSS, capped completion size, bounded conversation context, and automatic 1.2-second batching of consecutive inbound private texts. Replayed WhatsApp events are deduplicated within the running process. Per-number default daily allowances (UTC) are 300 LLM calls (multiple tool turns each count) and 3,600 voice-note seconds; adjust them under Admin. Voice notes over five minutes and audio attachments over 15 MB are declined. Local models consume server CPU/RAM; having 50 GB free storage is not a RAM or GPU specification.

**Deploy:** A push to `main` triggers the existing VPS workflow, preceded by Node.js syntax checks and regression tests. Built-in auto-update is also available when the running deployment follows main. Check the Actions run and the app `/health` endpoint and send a test WhatsApp voice message before declaring the deployment verified. Official WhatsApp Business Platform integration is advisable for commercial production because unofficial linked-device methods can be restricted.


## V2.3 customer-friendly setup and forgot-password recovery

Air Agent's homepage guides nontechnical owners through 1) scanning WhatsApp, 2) deciding who gets replies, and 3) adding basic business information. Advanced menus are under **More settings**.

### Password recovery
- On the login screen select **Forgot password?**. Enter the account email, then use the reset link from your inbox. A link works once and expires after **20 minutes**.
- Reset tokens are cryptographically random, stored only as SHA-256 hashes, and deleted when used. Passwords are hashed with bcrypt, and all previously logged-in sessions are invalidated on reset.
- Reset requests provide the same message for real or unknown email addresses, include per-IP rate limiting and five-minute per-account cooldown, and do not reveal the token via API responses or logs.
- The application uses the server's existing **Admin → Bot email domain → SMTP server, username and password** settings for reset email, even when you do not assign individual bot email addresses. Configure these as administrator and use a provider that supports SMTP.
- Under **Admin → Password recovery**, optionally set the sending email address. It must be a verified/authorized sender for your SMTP provider. Users see a configuration warning until the SMTP host, username and password are saved.
- Password reset links point to `https://agent.llama2.com` by default, **not** an untrusted Host header. On other domains set `PUBLIC_URL=https://your-verified-domain.example` in the server environment. HTTPS is required.
- Reset emails cannot be guaranteed to arrive until an administrator configures working SMTP, DNS sender authentication (SPF/DKIM, as needed), and tests delivery.

### Production safety
- GitHub checks JavaScript parsing plus unit and HTTP/SQLite integration tests before deployment. Do not advertise production readiness until visiting `/health`, testing WhatsApp QR linking, confirming email delivery, and successfully resetting a real account password.
