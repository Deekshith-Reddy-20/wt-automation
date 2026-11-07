# MSG91 WhatsApp in the main CRM (port 3000)

Guest WhatsApp is handled **inside this repo’s Next.js app** — same process as the dashboard. No second server is needed.

## Environment (repo root `.env.local`)

```env
MSG91_AUTHKEY=your_authkey_from_msg91_dashboard
MSG91_INTEGRATED_NUMBER=919876543210
# Optional:
# MSG91_WEBHOOK_SECRET=…
# MSG91_ADMIN_TOKEN=…
# MSG91_DRY_RUN=true
```

See also `.env.local.example`.

## Webhook URL for MSG91

Point **WhatsApp → Webhook (New) → On Inbound Request Received** at:

```text
https://YOUR-PUBLIC-HOST/api/msg91/webhook
```

For local testing, run `npm run dev` (default **http://localhost:3000**) and tunnel with `ngrok http 3000`, then use `https://YOUR-NGROK_HOST/api/msg91/webhook`.

### Keep the webhook URL stable

A free ngrok URL changes every time ngrok restarts. When that happens MSG91 keeps posting to the old URL and guests get no reply. To avoid that:

- Claim the free static domain in the ngrok dashboard (Domains), then always start the tunnel with `ngrok http --url=YOUR-STATIC-DOMAIN.ngrok-free.app 3000`. The MSG91 webhook URL then never changes.
- Or deploy the app (see `DEPLOYMENT_GUIDE.md`) and point the MSG91 webhook at `https://YOUR-DOMAIN/api/msg91/webhook`.

To check delivery, open **Automations → WhatsApp Integration Health → Check Now**. With MSG91 configured, it shows the provider, the last MSG91 webhook POST and the last inbound/outbound message.

## How a guest message flows

1. MSG91 POSTs the inbound message to `/api/msg91/webhook`.
2. The message is stored in the normal **Inbox** (contact + conversation are created on first contact).
3. The **V-Farms resort bot** (Automations → V-Farms resort automations) answers: welcome menu, stay enquiry, availability, pricing, events, human handoff.
4. Bot replies are sent through MSG91 and appear in the same Inbox thread. Staff text replies from the Inbox also go through MSG91 and pause the bot for that guest.

While **test mode** is on (V-Farms Resort → Settings), the bot only really sends to the numbers listed as test numbers; everyone else gets a simulated reply recorded in the Inbox as `[test mode — not sent]`.

## Meta vs MSG91

Configure the business number only in the **MSG91** dashboard. This stack does not use Meta Cloud API webhooks for MSG91 traffic.
