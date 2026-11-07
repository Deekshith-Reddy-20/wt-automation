# V-Farms

Resort CRM for V-Farms, with WhatsApp availability and booking automation,
built on Next.js and Supabase and talking directly to Meta's WhatsApp
Cloud API (`graph.facebook.com`).

## What it does

- **WhatsApp availability and booking automation** — the V-Farms bot
  (`src/lib/resort/bot/`) answers guests on WhatsApp: checks the live
  calendar for stay dates or event slots, suggests alternative dates,
  quotes from the configured pricing, takes the booking request and holds
  the dates, and hands over to staff on request (`HUMAN`) or as soon as a
  staff member replies. Nothing is confirmed automatically: staff confirm
  each request. Without a guest website (`RESORT_WEBSITE_URL`, unset by
  default) the bot sends no links and no online-payment requests; the team
  shares payment details itself.
- **Resort dashboard** (`/resort`) — property details, pricing, calendar
  and blocks, bookings (confirm, reject, check in/out, cancel, refunds),
  leads, bot/human mode per conversation, staff alerts and the WhatsApp
  reminder queue.
- **Inbound webhook** (`/api/whatsapp/webhook`) — Meta signature validation,
  duplicate-delivery protection, message status updates.
- **Shared inbox**, contacts, tags, custom fields, notes and conversation
  history for the reservations team.
- **Sales pipeline** (Kanban) with deals linked to conversations.
- **Automations and Flows** — follow-up reminders, agent assignment,
  escalation.
- **Broadcasts** with Meta-approved templates.
- **Optional:** AI reply assistant (bring your own key), public REST API
  (`/api/v1`, see [docs/public-api.md](./docs/public-api.md)) and outbound
  event webhooks.
- **Team access** — owner / admin / agent / viewer roles, enforced by the
  API and by Supabase row-level security.

## Local development

Requires Node.js 22.12+.

```bash
npm install
cp .env.local.example .env.local   # fill in Supabase + Meta values; never commit this file
npm run dev
```

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm test` | Unit and integration tests (Vitest, all external services mocked) |
| `npm run build` / `npm start` | Production build / server |

## Turning on the resort automation

1. Apply the migrations in `supabase/migrations/` in filename order,
   including `059`–`064` (resort tables, row-level security, booking
   functions, the resort automation registry). A project already at 058 can paste
   `supabase/apply/vfarms_resort_059_065.sql` into the SQL editor instead. See [SUPABASE_SETUP.md](./SUPABASE_SETUP.md).
   `supabase/rollback/063_vfarms_resort_automations_down.sql` undoes 063
   (run migration 062 again first to undo 064).
2. Sign up as the owner at `/signup`, then create the property profile:
   `node scripts/seed-vfarms.mjs --owner-email <owner email>`. It writes
   only facts the business has stated and leaves everything else
   "Not configured".
3. In **V-Farms Resort**, fill in Property (capacity, check-in/out times,
   policies) and Pricing. The bot quotes only what is entered there.
4. Connect WhatsApp under Settings → WhatsApp, then in V-Farms Resort →
   Settings turn the bot on. Keep **test mode** on at first: the bot then
   replies for real only to the staff numbers you list, and simulates
   every other reply.
5. Schedule `GET /api/resort/cron` (header `x-cron-secret`, value
   `CRON_SECRET` or `AUTOMATION_CRON_SECRET`) every few minutes. It expires
   holds, sends queued guest messages and queues enquiry follow-ups.
6. On **Automations**, review the V-Farms automations A–L. They start
   **disabled** (except F, human escalation, which can't be turned off).
   Configure each one (Edit), check it with **Run Test** — read-only: it
   never sends a message, creates a booking or changes data — then enable
   it. Every run is listed under **Execution History**. Reminders and
   follow-ups (H, I, K) send nothing until their timing is configured;
   outside WhatsApp's 24-hour window they need an approved template.
7. Optional: hide the leftover Suraj Solar records with
   `node scripts/archive-solar-records.mjs --owner-email <owner email>`
   (dry run; add `--apply` to archive). It writes a JSON backup to the
   git-ignored `backups/` folder first, archives automations and flows
   instead of deleting them, removes only unused solar tags, fields,
   quick replies, draft templates and the empty "Solar Sales" pipeline
   (each snapshotted in `legacy_archive`), and is undone with `--restore <backup file>`.
   It also renames an account called "Suraj Solar" to "V-Farms" and clears a solar AI
   system prompt (snapshotted; auto-reply turned off). Sample contacts are touched only
   with `--include-demo-contacts`; other records that merely mention solar are listed for
   review and archived only with `--include-flagged`. Real contacts are never removed.
   Against a hosted project, writes need `--allow-remote`.

## Documentation

| Topic | File |
|---|---|
| Environment variables | [ENV_CONFIGURATION.md](./ENV_CONFIGURATION.md), [.env.local.example](./.env.local.example) |
| Supabase project and migrations | [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) |
| Meta WhatsApp connection | [META_WHATSAPP_SETUP.md](./META_WHATSAPP_SETUP.md), [docs/whatsapp-connection-troubleshooting.md](./docs/whatsapp-connection-troubleshooting.md) |
| Deployment (Node.js host or Docker) | [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md), [docs/docker.md](./docs/docker.md) |
| Auth emails | [docs/auth-emails.md](./docs/auth-emails.md) |
| Module status | [MODULE_STATUS.md](./MODULE_STATUS.md) |

Database schema changes live in `supabase/migrations/` and are applied in
filename order. Never apply a migration to the production project without
reviewing it first.

## License

Based on [wacrm](https://github.com/ArnasDon/wacrm) by Arnas Donauskas,
used under the MIT License — see [LICENSE](./LICENSE). The license notice
must stay with the code.
