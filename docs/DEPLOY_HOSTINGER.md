# Air Agent 2 — Hostinger VPS Release Playbook

This product branch is **code only** until explicitly reviewed and deployed. The live Hostinger Docker Manager deployment must be updated separately; editing GitHub does not by itself change its Compose configuration. **Do not reconnect a personal WhatsApp number before securing the server.**

## Important: another Hostinger deployment workflow currently exists on main

The `main` branch independently gained `.github/workflows/deploy.yml` while this feature branch was being developed. That workflow triggers `hostinger/deploy-on-vps@v2` on **every push to main**; it is separate from the reviewed manual SSH workflow in this branch. Its observed October 14 executions failed because GitHub did not provide `HOSTINGER_API_KEY`. It also needs `HOSTINGER_VM_ID` as a repository Actions variable.

**Before merging anything to main**, choose exactly **one** release route: either disable/gate the existing automatic Hostinger Action and use this branch's reviewed-SHA manual workflow, or replace this branch's manual workflow with a correctly protected *manual* Hostinger API deployment. Do not configure automatic Hostinger API credentials until the release behavior is agreed and the live Compose configuration is secured. Otherwise, adding credentials could make the next push deploy without further approval.

## What works in the source code

- New responsive WhatsApp-inspired Air Agent dashboard and "Scan any WhatsApp number. Done." onboarding. Link a number **you control**.
- Personal AI reply options: explicit E.164 approved list, blocked numbers, reply once per contact (persisted), cooldown, quiet hours, personality, language and output style. Unapproved senders never trigger personal auto-replies, even with old saved settings.
- Opt-in last 10 **observed** chat messages as context. It records only messages seen by the linked session since the feature was enabled; this is not a historical WhatsApp import. Turning it off clears those context records.
- Privileged control number: verify sender by WhatsApp JID + configured international phone list + separate hashed controller PIN. Supported **explicit commands only**: status, pause, resume and sending plain-text mail to a predefined email recipient list. No arbitrary shell access.
- Optional unique bot email alias, inbox and outbound email API. **Not actual email delivery** until a verified domain, provider and inbound forwarding relay are configured.
- Metadata-only masked audits, emergency disconnect, private login/session storage and signed email webhooks.

## Mandatory: prepare Hostinger

1. Keep personal WhatsApp disconnected. Use an expendable test number.
2. Back up your existing \`air-agent\` Docker data volume securely; it may contain WhatsApp credentials, session history and user accounts. Never upload this backup or \`.env\` to GitHub.
3. Review the current Air Agent dashboard **Monitor → Users** for accounts you do not recognize. If you suspect compromise, rotate VPS/Hostinger credentials and invalidate prior sessions.
4. Open the Compose application in Hostinger Docker Manager. Use the **reviewed** new \`docker-compose.yml\` on deployment, with:
   - \`OPEN_SIGNUP=false\`
   - \`COOKIE_SECURE=true\`
   - \`BIND_IP=127.0.0.1\`
   - \`BOOTSTRAP_ADMIN_TOKEN\` only if there are **zero** dashboard users; set a unique 24+ character random token privately and remove it after admin creation.
   - dashboard \`127.0.0.1:8080\` and Uptime Kuma \`127.0.0.1:3001\` bound only to server loopback. **Do not expose those ports directly.**
5. Configure an **HTTPS reverse proxy** (e.g. Caddy) on an owned domain, such as \`agent.yourdomain.com\`, forwarding the dashboard to \`127.0.0.1:8080\`. HTTPS is required for Secure login cookies. Restrict dashboard access to authorized operators. Configure Uptime Kuma separately and keep it loopback-only.
6. IMPORTANT: the **old live Compose** automatically runs \`git pull\` when the container restarts. The new file removes that behavior but will not affect Hostinger until its live Compose definition is changed. Do not merge into \`main\` until this is understood.

## Controlled GitHub → VPS deployment

The source includes a **manual** GitHub Actions workflow \`.github/workflows/deploy-hostinger.yml\`. It intentionally will not run automatically on every Git push. The workflow can only deploy an exact commit SHA already merged into \`main\`; a user must enter \`DEPLOY\` to confirm.

Set up a dedicated SSH deployment key on the VPS. Add these **GitHub Actions repository secrets** (never paste their values into issues, chat, or source files):

| Secret | Purpose |
|---|---|
| \`VPS_HOST\` | VPS public hostname or IP |
| \`VPS_USER\` | Restrained, authorized SSH account able to run Docker |
| \`VPS_DEPLOY_SSH_KEY\` | Private SSH key for that VPS-only account |
| \`VPS_SSH_KNOWN_HOSTS\` | Verified SSH host public key line(s), pinned out of band |

Set up the GitHub \`production\` environment with required reviewers, if available in your repo plan. Protect \`main\` against direct writes. Do not grant public contributors deployment secrets.

1. Review and merge the security and product feature branches in a coordinated release; *merging to main may cause the old live app to auto-pull on its next restart.*
2. Ensure old Hostinger auto-pull has been removed in live Compose, and verify working HTTPS dashboard access.
3. GitHub → **Actions → Deploy Air Agent to Hostinger (manual)**.
4. Paste the full SHA of the reviewed release commit already on main, enter \`DEPLOY\`, run and approve in the protected \`production\` environment.
5. The remote script \`scripts/deploy-to-vps.sh\` creates a root-only copy of \`/data\`, fetches exactly the approved SHA, detaches checkout, restarts the app container and checks the resulting SHA. Rotate/back up encrypted data in line with your server policy.
6. Verify HTTPS login, settings, QR, once-only replies, blocked-number tests and critical integrations **using a spare number** before any personal account is linked.

The release process needs real SSH/Docker permissions. It has **not** been connected to Hostinger or tested against your live VPS in this chat. If the container name differs from \`air-agent-app-1\`, adjust \`AIR_AGENT_CONTAINER\` on the remote command. The remote shell must be Bash.

## Bot email setup — still requires real provider/DNS work

1. Own an email domain and verify it with a transactional email provider that supports API sending from the bot addresses. The current optional outbound adapter uses **Resend**.
2. Set privately in Hostinger:
   - \`MAIL_DOMAIN=your-verified-mail-domain.com\`
   - \`EMAIL_FROM=bot@your-verified-mail-domain.com\`
   - \`RESEND_API_KEY=... \`
   - \`INBOUND_EMAIL_WEBHOOK_SECRET=... \` (32+ unpredictable characters)
3. Configure MX/inbound routing at the provider. Route inbound emails into a *trusted relay* that independently verifies the provider's webhook, creates a normalized JSON payload:
   \`{"messageId":"provider-id","to":"agent-...@your-domain","from":"sender@example.com","subject":"Hi","text":"message body"}\`
4. Relay that exact JSON over HTTPS to \`POST /api/webhooks/inbound-email\`, with \`X-Air-Timestamp\` (Unix seconds) and \`X-Air-Signature\` (hex HMAC-SHA256 of \`timestamp + "." + raw_json_bytes\` using \`INBOUND_EMAIL_WEBHOOK_SECRET\`). Reject provider webhooks failing their *own* signature verification.
5. The dashboard can then provision an alias for each agent. A generated alias alone **does not confirm delivery**. Send and receive a test message before enabling live use.

Inbound messages are stored in the private VPS SQLite database, with retention controlled by \`RETENTION_DAYS\` (default 30). Outbound emails are submitted to the configured provider and may have additional provider costs. The open-source Ollama model is separate from the mail provider.

## Super receiver commands

Configure a trusted separate WhatsApp number in Command Center. Set a strong controller PIN **not reused anywhere else**. An incoming command must be from that approved phone number and include the correct PIN:

\`\`\`text
/do YOUR_PIN status
/do YOUR_PIN pause
/do YOUR_PIN resume
/do YOUR_PIN email office@approved-domain.com | Subject | Message
\`\`\`

The recipient must also be on the explicitly configured approved email list. Controller commands **do not** let the model invent new system actions or execute shell commands. PINs are sent in a WhatsApp message; treat the controller account, device and its chat history as sensitive and rotate the PIN after any suspicion of compromise.

## Testing and rollback

Run \`npm ci && npm test\` on a disposable environment. GitHub CI also runs JavaScript syntax and real HTTP smoke tests. It does **not** certify production network, DNS, mailbox routing, end-to-end WhatsApp delivery or security against all attacks.

After deployment, if a rollback is required, the root-only backup directory includes the prior commit SHA, and the deployment script prints a matching checkout/restart command. Changes to SQLite schema are designed to be additive; database snapshots remain important for full rollback.

**Never deploy this branch to your personal WhatsApp until the VPS HTTPS, session controls and provider configuration have been independently verified.**
