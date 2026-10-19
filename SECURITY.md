# Security review and operator actions

Review snapshot: 2026-10-19. This document records a repository-level hardening pass informed by [NIST SP 800-218 (SSDF)](https://csrc.nist.gov/pubs/sp/800/218/final) and [CISA Cross-Sector Cybersecurity Performance Goals](https://www.cisa.gov/cybersecurity-performance-goals). It is not an independent assessment, certification, or statement of compliance.

## System map

- Air Agent is a Node.js 22 / Express 5 application with a vanilla JavaScript dashboard, SQLite storage, background reminder and email jobs, and Baileys linked-device WhatsApp sessions.
- `docker-compose.yml` runs the app, Ollama, and Uptime Kuma. The app's configured host port defaults to `8080` and is published on all interfaces. Uptime Kuma is bound to loopback (`127.0.0.1:3001`); Ollama has no published host port. The Caddy configuration expects public ports 80/443. The VPS's actual listeners, firewall rules, Caddy state, certificate renewal, and SSH configuration were not verifiable from this workspace.
- The configured container runs as root and mounts named volumes for `/data` and `/srv/app`. Changing ownership or switching to a non-root user requires a verified backup and volume-permission migration; neither was available for this review.
- Deployment is configured through `.github/workflows/deploy.yml` and the Compose startup command. Main-branch pushes can trigger deployment; the running app can also follow public `main` through its auto-updater. The latest inspected workflow run had validation pass and both deployment jobs skipped. No live deployment was performed.

## Data flow and storage

- Baileys receives WhatsApp messages and attachments. WhatsApp end-to-end encryption protects delivery between WhatsApp users; after Air Agent reads a message, that protection no longer prevents Air Agent or the selected AI provider from reading it.
- Chat text is persisted only when the account enables memory. Chat/contact metadata is stored in SQLite. Email bodies, notes, settings, and extracted knowledge text are stored in the SQLite data volume. Email bodies and chat memory are pruned on the configured retention period (30 days by default); notes and knowledge documents remain until deleted or account data is removed. Raw knowledge uploads and WhatsApp media are handled in memory for extraction/transcription rather than intentionally saved as upload files.
- Voice notes are transcribed using local Whisper or the configured speech API. The selected text, bounded context, knowledge excerpts, and/or email text can be sent to the selected AI provider for a response. Providers supported by the current code include local Ollama, operator-configured Groq/OpenAI-compatible APIs, and customer-configured OpenAI-compatible APIs. OpenRouter is an explicit OAuth connection with its own billing; a ChatGPT consumer subscription is not API access. Verify retention and training controls with the provider selected by each account; this review did not independently establish provider-side retention settings.
- The website importer sends public website URLs to Firecrawl when configured, or fetches one public HTTPS HTML page itself. Imported text is saved in that account's knowledge base and can later be sent to its AI provider. Current website functionality is public-page import; it does not provide an interactive Playwright session or authenticated website automation.
- SMTP/IMAP providers receive the mail required for delivery or inbox access. Email content may be supplied to the AI provider for owner-requested assistance. The password-recovery SMTP settings are shared with bot-address sending.
- API keys, SMTP credentials, webhook credentials, and other application secrets use AES-256-GCM with a key from `APP_SECRET` or `DATA_DIR/secret.key`. WhatsApp auth JSON files are now migrated in place to authenticated encryption and restricted permissions. If `secret.key` is used, it lives in the same data volume as ciphertext; theft of the complete volume can therefore expose both. SQLite message/email/knowledge text is not encrypted at rest by the app. No encrypted off-host backup or restore was verified.
- Application, AI, voice, and action error logging was changed to avoid writing message bodies, prompts, reset links, tokens, and provider error bodies. The database still contains account data and necessary operational records.

## Repository changes in this branch

- Session cookies are now random bearer values whose SHA-256 digests are stored in SQLite; existing token rows migrate transactionally. Cookies expire after 30 days, are `HttpOnly` and `SameSite=Lax`, and are `Secure` when the request is recognized as HTTPS.
- Added origin / Fetch Metadata checks for cookie-backed writes, per-IP and per-account login throttles, bounded rate-limit state, generic login errors, dummy password verification, stronger minimum password length, and password-reset invalidation of existing sessions.
- Password-reset records contain only token hashes, expire after 20 minutes, are single-use, and have a per-account cooldown plus per-IP throttling. Admin recovery status now reports missing field names only; SMTP testing sends only to the authenticated admin. SMTP configuration requires TLS and supports Hostinger's documented settings ([official Hostinger guide](https://support.hostinger.com/en/articles/1575756-how-to-get-email-account-configuration-details-for-hostinger-email)): `smtp.hostinger.com`, port `465` with implicit TLS or `587` with STARTTLS, full mailbox address, mailbox password, and an authorized sender address. `PUBLIC_URL` must be the HTTPS site origin when it differs from the configured default.
- AES-GCM WhatsApp session-file migration is atomic per file and retains the existing linked session format. File and data-directory permissions are tightened. SQLite main and sidecar files are restricted to owner read/write.
- External or delayed actions now require explicit confirmation in application code, including reminders and booking-request notifications; the user preference cannot disable that gate. Custom API and webhook URLs require HTTPS. Webhook/Twilio redirects are disabled. The SSRF guard rejects private/reserved IP ranges, embedded credentials, and non-HTTPS provider URLs.
- Added restrictive response headers, API no-store caching, generic server errors, shorter retention pruning for stored email bodies, safer secret masking, and redacted operational logs.
- Production dependency versions were updated; GitHub Actions dependencies are pinned to commit SHAs with minimal `contents: read` permission; production dependency audit and Compose validation run in CI. Dependabot weekly updates were added. Deployment workflow no longer emits container logs into GitHub Actions.

## Verification performed

- `node --test tests/*.test.js`: 23 passing, including reset-token expiry and reuse rejection, SMTP settings and test path, tenant-scoped database access, action confirmation, SSRF blocks, auth-token hashing and expiry, Firecrawl import, and WhatsApp auth-state migration.
- JavaScript syntax checks passed for `src`, `public`, `scripts`, and `tests`.
- A targeted credential-pattern scan found zero matches in the working tree and zero matching paths across 157 repository commits. This is not a guarantee that every possible secret format is absent.
- `npm audit --omit=dev`: no high or critical advisories; three moderate advisories remain in the Mammoth document-conversion dependency chain (`mammoth` → `argparse` → `sprintf-js`). The currently published `sprintf-js` version is affected by [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) and no fixed published version was available during this review. Mammoth's runtime path in this app does not invoke the vulnerable CLI formatter, but the dependency remains in the audit and should be revisited when an upstream fixed release is available.
- `npm ci --omit=dev` did not complete in this workspace: the `onnxruntime-node` install script could not reach its download host through the restricted proxy. Dependencies were restored from the local npm cache for tests; this is not a successful production install verification.
- The repository has no production build script. Docker is unavailable in the workspace, so an image build and Compose runtime boot were not run. The CI workflow validates Compose syntax.
- GitHub secret scanning is not a substitute for full credential-rotation analysis. No secret values should be copied into an issue or log.

## Required operator actions

### GitHub

The repository was public at inspection time. It also uses unauthenticated public clone/pull in Compose and the updater, so changing it to private before installing read-only deploy authentication would stop updates. The GitHub connector available to this session could read repository state and write branch/PR content, but could not change repository visibility, rulesets, or security settings.

1. Add a read-only GitHub deploy credential to the existing Hostinger deployment using a secured secret/file mechanism, update the existing clone URL to use that credential without embedding it in a URL or command log, and verify a fresh clone and update. Then use **Repository → Settings → General → Danger Zone → Change repository visibility → Make private**.
2. Under **Settings → Rules → Rulesets**, protect `main`: require pull requests and the validation check, block force pushes and deletion, and require at least one independent approval if a second maintainer is available.
3. Under **Settings → Code security and analysis**, enable secret scanning and push protection, CodeQL/code scanning, Dependabot alerts, and Dependabot security updates where the account plan offers them. The repository has a Dependabot update manifest and CI audit, but settings could not be enabled through this connector.
4. Require account/organization MFA, use least-privilege GitHub access, and keep deploy credentials in repository or environment secrets. Do not reuse a broad personal access token for deploy pulls.

### Hostinger VPS

- Before any deployment, create an encrypted backup outside the app directory that includes SQLite (using SQLite's backup/checkpoint-safe method), `/data/auth`, `secret.key` or the external `APP_SECRET` recovery material, Compose configuration, and the current image/code reference. Verify a restore to a separate path/volume and record the exact rollback command. No backup/restore or rollback was available to verify here.
- Inspect `ss -lntup`, `ufw status`, Docker port mappings, and Caddy service/config on the VPS. The Compose file intentionally publishes app port `8080` to all interfaces; do not expose it publicly once the HTTPS proxy is confirmed. Keep `80/443` for the current Caddy setup, `22` only for SSH administration, and keep `3001` loopback-only and Ollama private. These are intended ports from repository configuration, not a claim about actual VPS firewall state.
- Confirm a second administrator can connect with a valid SSH key and a separate recovery route before changing SSH or firewall rules. Then restrict SSH to key-only least-privilege access and ensure the app runs as a non-root user after a tested volume ownership migration.
- Ensure HTTPS reaches the app through Caddy, set `PUBLIC_URL` to that HTTPS origin, confirm certificate renewal, and close or firewall direct HTTP access to port `8080` after confirming the proxy route.
- Move the encryption key away from the data volume (secure environment/secret management) and use encrypted, off-host backups. Encrypt the SQLite data volume at the storage layer if available; application-level encryption currently covers secrets and WhatsApp auth files, not chat/email/knowledge text.
- Review Hostinger and selected AI/speech provider retention settings. If a credential is exposed, rotate it in that provider and update Air Agent through its admin settings; this review did not find a safe basis to rotate live credentials without risking service disruption.

## Open risks

1. **High — repository is public and production updates use unauthenticated GitHub access.** Restricting source visibility safely requires private deploy authentication first; complete the GitHub steps above.
2. **High — no verified production backup, restore, second SSH path, or actual firewall inspection.** Provide an authorized Hostinger SSH session plus backup location/restore procedure before production changes. No SSH/firewall setting was changed.
3. **High — app runs as root in the current Compose definition, and port 8080 is published on all interfaces.** After backup and proxy verification, move to a non-root runtime and restrict direct port exposure.
4. **High — SQLite chat, email, notes, and knowledge content is plaintext at rest; data-volume access also includes the local encryption key.** Use encrypted storage/off-host backups and isolate the key outside the volume.
5. **Medium — administrators do not have app-level MFA, and GitHub branch/ruleset protections were not verifiable/enabled.** Require MFA for GitHub now; add app MFA before broad production use if its UX and recovery path can be safely designed.
6. **Medium — three moderate dependency advisories remain in the Mammoth/argparse/sprintf-js dependency chain.** Update Mammoth or replace the conversion path when a fixed upstream release is available; keep CI audit enabled.
7. **Medium — DNS checks and later socket connections are separate operations.** A hostname controlled by a tenant could theoretically change its DNS answer between validation and connection. Restrict outbound network access and adopt DNS-pinned connections before enabling arbitrary tenant-defined endpoints at scale.
8. **Medium — per-IP limits are in-memory and apply to a single app process.** If deployment scales to multiple processes, move throttling to a shared store and retain account-level cooldowns.

