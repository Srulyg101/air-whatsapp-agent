# WeChat integration requirements

## Current status

This app currently supports WhatsApp through its existing Baileys session flow. It does not connect to WeChat and does not forward messages between WhatsApp and WeChat.

The app must not automate a personal WeChat account by reading QR codes, extracting cookies, or using an unofficial session library. WeChat does not provide a supported public bot API for ordinary personal accounts.

## What is required for a supported integration

A future implementation must target an eligible WeChat Official Account or another officially supported business account/API product. The account owner must have the applicable API permissions and configure the official callback endpoint and credentials (for example, AppID/AppSecret and the callback verification settings required by the selected product). Availability and message permissions depend on the account type, region, verification status, and the platform's current rules.

Before implementation, confirm which account product the owner has: Official Account (subscription/service), WeCom/WeChat Customer Service, or a personal account. These are different APIs and user identifiers; they are not interchangeable.

## Cross-channel forwarding requirements

Forwarding must stay disabled by default. A future implementation must require explicit opt-in, an owner-approved mapping between a WhatsApp contact and the official WeChat recipient identifier, and separate allowlists for each direction. It must preserve source labels, record a deduplication/loop-prevention ID, support preview/confirmation, and report unsupported attachments instead of silently dropping them.

WhatsApp phone/JID values cannot be assumed to identify a WeChat recipient. WeChat recipients must be obtained through the supported account flow and knowingly mapped by the account owner/user. Messages sent through official customer-service APIs are subject to account eligibility and platform rules.
