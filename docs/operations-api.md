# Air Agent Operations API

This is an optional integration feature; it does not read employees' private WhatsApp chats. The current WhatsApp agent can propose a helpdesk ticket when its **owner explicitly requests it**, with a required yes/no confirmation. External software can submit authorized events and ticket requests through the API.

## Configure a helpdesk (authenticated dashboard session)

1. Sign into Air Agent through HTTPS using an administrator/owner account.
2. Add a helpdesk using **POST /api/operations/integrations** with JSON:
   - Freshdesk: {"name":"Support","provider":"freshdesk","endpoint":"https://YOUR.freshdesk.com/","api_key":"YOUR_FRESHDESK_KEY"}
   - Zendesk: {"name":"Support","provider":"zendesk","endpoint":"https://YOUR.zendesk.com/","email":"agent@yourdomain.com","api_key":"YOUR_ZENDESK_TOKEN"}
   - Custom outbound webhook: {"name":"Service Desk","provider":"webhook","endpoint":"https://trusted.example.com/tickets","api_key":"YOUR_WEBHOOK_BEARER"}
3. Only HTTPS public endpoints are accepted; private-network, metadata, redirection, and nonstandard-port access is blocked. Webhook receivers must return JSON with an \`id\` (or \`ticket.id\`) after persisting the ticket. Restrict receivers to trusted domains and review their security.
4. **GET /api/operations/integrations** lists configurations without exposing credentials. **DELETE /api/operations/integrations/:id** disables the connector and clears its credential.

Provider keys are encrypted at rest using the app's existing AES-GCM encryption key. Keep the app data volume and encryption key backed up securely. Do not paste real provider API keys into a chat, GitHub issue, or repository file; enter them directly through an authenticated HTTPS session.

## Create, view, and revoke API keys

With an authenticated owner dashboard session:

- **POST /api/operations/keys** with \`{"name":"workflow","scopes":["events:write","tickets:write","tickets:read"],"expires_in_days":30}\`.
- **GET /api/operations/keys** lists key IDs, scopes, expiry, and usage metadata; never returns the token.
- **DELETE /api/operations/keys/:id** immediately revokes a key.

The created token is **shown only once** in the response. Copy it directly into a trusted external service's secret store. Only its SHA-256 hash is stored in the Air Agent database. API keys expire after at most 90 days; rotate them.

API calls use \`Authorization: Bearer YOUR_AIR_LIVE_TOKEN\`. No cookie sign-in is accepted for the external \`/api/v1\` endpoints. Each key is scoped to one Air Agent account. Maximum 60 requests/minute per key (per application instance).

## Incoming event (message)

\`POST /api/v1/events\` with scope \`events:write\`:

\`\`\`json
{
  "source": "crm",
  "source_id": "message-000123",
  "type": "message",
  "message": "Store #12 requests a price approval",
  "open_ticket": false
}
\`\`\`

Events are recorded once by \`(account, source, source_id)\`. The default **does not** create a ticket: a message may be informational. Set \`open_ticket: true\` only when an authorized upstream workflow has decided a ticket is required. That additionally requires \`tickets:write\`. Optional ticket fields: \`title\`, \`priority\` (1 to 4), \`requester_email\`. Ticket creation with a configured provider returns the local ticket status; a remote ticket is not considered created until the provider returns a ticket ID.

## Ticket API

- **POST /api/v1/tickets** with scope \`tickets:write\` and required \`Idempotency-Key\` header (at least 8 characters). JSON: \`{"title":"Approval required","description":"Store #12 needs a price update","priority":2,"requester_email":"requester@example.com"}\`
- **GET /api/v1/tickets** and **GET /api/v1/tickets/:id** require \`tickets:read\`.
- **GET /api/operations/tickets** and **POST /api/operations/tickets** work with an authenticated dashboard cookie and are intended for owner-facing administration.

If no provider is configured, a local record is stored with status **draft**, not falsely reported as sent. If an outbound request fails or returns no provider ticket ID, the status becomes **needs_review**. This is deliberate: the provider might have accepted a ticket before a connection broke. Investigate first; never automatically retry an uncertain write. Repeated requests with the same source ID / Idempotency-Key return the same local record, preventing most duplicate tickets.

## WhatsApp owner actions

With an active provider, Air Agent's owner (and explicitly trusted command numbers) can ask to **create a ticket**. The agent proposes the summary, asks for a yes/no confirmation even when ordinary action confirmations are disabled, and only then makes the provider call. The owner can ask for the last 10 tickets or a local ticket's status.

This does not silently monitor private employee accounts, create tickets from every message, or give non-owner contacts ticket permissions. An official business WhatsApp integration is preferable for commercial-scale reliability; the existing linked-device connection remains unofficial.

## Security and operating notes

- Keep API-key scopes minimal, expire unused keys, rotate on personnel changes, and review key usage.
- Gate approval and authorization decisions outside AI. This API cannot grant an operational approval.
- For production use, put the app behind HTTPS, restrict administrator access, and enforce central rate limiting and audit retention if deploying multiple replicas. The current limiter is process-local.
- Treat all incoming message content as untrusted. Never pass provider credentials through webhook message fields.
- Do not publish ticket content or customer personal information into public GitHub issues.
- Raw inbound operations events are pruned on the configured retention interval (default 30 days), while ticket records remain until the account is deleted or a separate ticket-retention policy is implemented. Avoid including unnecessary personal information in tickets.
- This integration does not yet synchronize provider-side ticket updates or manage full email CC/thread workflows. Add those only with provider-specific identity and permission checks.
