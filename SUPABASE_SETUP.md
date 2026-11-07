# Supabase Setup

The CRM uses Supabase for Postgres, Auth, Storage, Realtime and RLS. Schema lives in
`supabase/migrations/` (53 idempotent files, `001`…`054`; `050` was intentionally renumbered to
`054` upstream, so the gap is expected).

## A. Local development stack (what is running now)

Requires Docker Desktop and the Supabase CLI (`npx supabase` works; v2.121 used).

```powershell
cd wacrm
npx supabase start -x edge-runtime,logflare,vector,supavisor   # first run pulls images (~10 min)
npx supabase status                                           # URLs + local demo keys
```

On a fresh volume `start` applies every migration in filename order. Verified 2026-10-17:
all 53 applied without error, and the repo's assertion script passes:

```powershell
npx supabase db query --local --file supabase/ci/verify-schema.sql
```

| Local service | URL |
|---|---|
| API (use as `NEXT_PUBLIC_SUPABASE_URL`) | http://127.0.0.1:54321 |
| Studio (DB browser) | http://127.0.0.1:54323 |
| Mailpit (captures auth emails) | http://127.0.0.1:54324 |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |

`npx supabase stop` keeps data; `npx supabase stop --no-backup` deletes it. `npx supabase db reset`
**wipes** the local DB and replays migrations — local only, never against a hosted project.

### Local property profile

After signing up `admin@vfarms.test` in the local stack, create the V-Farms property profile:

```powershell
node scripts/seed-vfarms.mjs --owner-email admin@vfarms.test
```

Local login: the dev account you created in the local stack (keep its password outside Git). Smoke-test users
`*@smoke.vfarms.test` also exist locally.

## B. New hosted development project (needs your Supabase account)

Not created during setup — it requires your account and is your decision (free tier is enough
for development).

1. supabase.com → New project. Region **Mumbai (ap-south-1)** for India latency; strong DB
   password stored in a password manager. Keep Postgres at the version `supabase/config.toml`
   expects (17) or update that file.
2. Apply migrations **in order** (non-destructive — every file is `IF NOT EXISTS`-guarded):
   ```powershell
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push            # applies supabase/migrations/* in filename order
   ```
   Alternative without the CLI: paste `supabase/apply/vfarms_full_setup.sql` (every migration,
   one transaction) into *SQL Editor* and run it. If the project already has tables in `public`
   that were made by another tool, that file first renames each one to
   `legacy_pre_vfarms_<name>`, keeping its rows, indexes and policies, then builds this app's
   schema. It refuses to run on a project that already has `public.profiles` (use section C).
   Rehearsed on a disposable database seeded with a copy of the 18 tables found in project
   `tcqiyydyhlnbzrtpbbgy` (`scripts/disposable-db/up.ps1 -Apply
   scripts/disposable-db/fixtures/foreign-resort-skeleton.sql,supabase/apply/vfarms_full_setup.sql`):
   applied without errors, legacy rows intact, RLS on every table, a second run refused, and the
   booking/RLS integration tests passed. Legacy tables keep their own policies; drop them once
   you no longer need them.
   **Never** run `db reset` or hand-written `DROP` statements against a project that holds data
   without a backup and explicit approval.
3. Verify: run `supabase/ci/verify-schema.sql` in the SQL editor → `schema verification passed`.
4. *Authentication → URL Configuration* (see [`docs/auth-emails.md`](./docs/auth-emails.md)):
   - Site URL: your app origin (e.g. `https://crm.vfarms.example`)
   - Redirect URLs: `https://crm.vfarms.example/**` plus `http://localhost:3001/**` for dev.
   Without this, confirmation/reset emails link to `localhost:3000`.
5. *Authentication → Providers → Email*: keep "Confirm email" on for production. Configure custom
   SMTP (Supabase's built-in mailer is rate-limited) under *Authentication → SMTP*.
6. *Project Settings → API*: copy URL, `anon`, `service_role` into the environment
   (`ENV_CONFIGURATION.md`). The service-role key is used only in server code
   (`src/lib/**/admin-client.ts`, webhook, cron, public-API auth) — verified that no
   `NEXT_PUBLIC_` variable carries it.
7. Create the V-Farms property profile for the owner after they sign up (writes only stated
   facts; everything else stays "Not configured"):
   ```powershell
   node scripts/seed-vfarms.mjs --owner-email owner@vfarms.example
   ```

## C. Existing project stopped at migration 058 (calendar shows "Database setup required")

The resort screens need migrations `059`–`065`. Without them PostgREST answers
`PGRST205 Could not find the table 'public.availability_blocks'`, and the dashboard shows a
setup banner and a **Run health check** button (`GET /api/admin/health`, read-only). The health
check tells apart: missing configuration, missing tables (with the migration that creates
each), access errors (row-level security or rejected API keys), an unreachable database, and
other query failures.

**Status of the hosted project (`rafdwhqohsdtawfftxdm`) on 27 Oct 2026:** migrations up to 058
are applied; 059–065 are **not** — nobody with database access has run them yet. The app has
only API keys, which cannot create tables, so this step is manual.

Migration order (all in `supabase/migrations/`, each idempotent):

| # | File | Creates |
|---|---|---|
| 059 | `059_vfarms_resort_schema.sql` | 22 tables (property settings, media, amenities, FAQs, pricing rules, seasonal rates, event packages, add-ons, leads, lead notes, conversation states, bookings, booking guests, quotes, event requests, availability blocks, payments, refunds, notification jobs, audit logs, webhook events, consent records); the `availability_blocks` exclusion constraint `EXCLUDE USING gist (account_id WITH =, period WITH &&) WHERE (status = 'active')` that makes overlapping stays, events, live holds and blocks impossible; RLS on every table through `is_account_member(account_id, role)` (viewer reads; agent manages leads/bookings/conversations; admin/owner manages property, pricing and settings) |
| 060 | `060_vfarms_resort_functions.sql` | Reservation and payment functions, each serialised per account by an advisory lock with the exclusion constraint as the final guarantee: `resort_reserve`, `resort_release_booking`, `resort_expire_stale_holds`, `resort_find_conflicts`, `resort_lock_estate`, `resort_apply_verified_payment`, `resort_recompute_booking_money`, `resort_confirm_booking`, `resort_claim_notification_jobs`, audit trigger. Executable by the service role only |
| 061 | `061_vfarms_bot_test_numbers.sql` | Staff test-number allowlist for the bot's test mode |
| 062 | `062_redeem_invitation_resort_guard.sql` | Invitation redemption never deletes an account that holds resort data |
| 063 | `063_vfarms_resort_automations.sql` | `resort_automations` (registry, disabled by default), `resort_automation_runs` (history; a trigger updates the counters from each run), `booking_feedback`, `booking_change_requests`, `legacy_archive`, `automations.archived_at` |
| 064 | `064_redeem_invitation_automation_guard.sql` | Same guard for the 063 tables |
| 065 | `065_vfarms_booking_request_flow.sql` | Allows the "Booking Request" flow key (`booking_request`) |

Guests never write to these tables directly. Their only way in is the WhatsApp webhook
(`/api/whatsapp/webhook`, Meta signature verified), which runs the bot on the server and
reserves dates only through `resort_reserve`. There is no public website enquiry endpoint
yet. Dates are converted from IST (`Asia/Kolkata`) to instants: a stay occupies check-in
time to check-out time, an event its start to end plus the configured buffer.

1. Back up first: *Database → Backups* (or `pg_dump`).
2. *SQL Editor* → paste `supabase/apply/vfarms_resort_059_065.sql` → Run. It is one
   transaction (all or nothing), refuses to run if 058 is missing, and is safe to run again.
   If the project already has an unrelated table with a V-Farms name (the hosted project has
   an older `leads` table without the V-Farms columns), it is renamed to
   `legacy_pre_vfarms_<name>` with its rows, indexes and policies intact, and a NOTICE says so.
   To undo: drop or rename the new V-Farms table, then rename the legacy one back.
   Regenerate it after editing a migration: `node scripts/bundle-resort-migrations.mjs`
   (`--check` reports drift). CLI alternative: `npx supabase db push`.
3. Reload the calendar and run the health check again — every line should be OK.
4. Finish the Suraj Solar cleanup (reversible; see README → *Turning on the resort
   automation*, step 7). On 27 Oct 2026 the first pass ran against the hosted project before
   these migrations existed: account renamed to V-Farms, nine solar automations turned off,
   the solar flow and the "Lead capture" flow archived (backup in `backups/`). Re-run it now
   to hide the automations and remove the unused solar templates, quick replies, tags and
   fields (each snapshotted in `legacy_archive`). Dry run first:
   ```powershell
   node scripts/archive-solar-records.mjs --owner-email owner@vfarms.example
   node scripts/archive-solar-records.mjs --owner-email owner@vfarms.example --apply --allow-remote
   ```

Rehearsed on a disposable database at the 058 state (`scripts/disposable-db/up.ps1 -UpTo 058`):
the bundle applied twice without error (also with pre-existing `leads` / `audit_logs` tables,
which were kept as `legacy_pre_vfarms_*` with their rows), and the archive script's dry run,
apply and restore round-tripped every row. The two-pass cleanup (first pass before the
migrations, second after) was rehearsed the same way.

Rollback: `supabase/rollback/065_vfarms_booking_request_flow_down.sql`, then
`supabase/rollback/063_vfarms_resort_automations_down.sql` (re-run 062 first, as 064 notes).
059/060 have no scripted rollback because dropping them deletes booking data; restore the
backup from step 1 instead.

## What the migrations create

| Area | Objects |
|---|---|
| Tables | 37 in `public`, **all with RLS enabled** |
| Tenancy | `accounts`, `profiles.account_id` + `account_role` (owner/admin/agent/viewer), `is_account_member()` used by policies |
| Signup provisioning | `handle_new_user()` trigger on `auth.users` → profile + personal account (owner). Verified. |
| Service-only tables | `automation_pending_executions`, `pending_message_statuses` — RLS on, no policies (server writes via service role) |
| Storage buckets | `avatars` (2 MB), `chat-media` (16 MB), `flow-media` (16 MB) — public read by URL; listing restricted to account members (043) |
| Realtime publication | `conversations`, `messages`, `message_reactions`, `notifications`, `member_presence`, `flow_runs` |
| Extensions | `pgcrypto`, `uuid-ossp`, `vector` (pgvector 0.8, for AI knowledge base) |
| Internal SECURITY DEFINER functions | Execute revoked from `anon`/`authenticated` (044, asserted by verify-schema) |
| Key indexes | per-table `account_id` indexes, unique `(conversation_id, message_id)` for webhook idempotency, unique phone / BSUID per account (022, 040), partial index for due automation jobs |

## Security checks performed

- RLS on every public table; no policy with a literal `true` qual/check remains (the permissive
  `messages` insert policy from 001 was replaced in later migrations).
- `whatsapp_config` writes require admin (`is_account_member(account_id,'admin')`); reads are
  member-level but the token column is AES-256-GCM ciphertext.
- Cross-tenant test: a user from another account read **zero** rows from contacts,
  conversations, messages, automations, pipelines, deals, whatsapp_config, api_keys,
  custom_fields. Anonymous client reads nothing.

## Privacy recommendation — media buckets

`chat-media` is a *public* bucket: inbound customer files (electricity-bill photos contain
name, address and consumer number) are served to anyone who holds the URL. Paths include the
random account UUID, so they are not guessable, but a forwarded link stays valid. For stricter
privacy, convert the bucket to private and serve signed URLs (code change across the media
proxy/inbox — not done in this setup).

## Backups

- Hosted free tier: no point-in-time recovery. Pro: daily backups (7 days); PITR is an add-on.
- Independently schedule `npx supabase db dump --linked -f backup-$(date).sql` (schema) and
  `--data-only` dumps to off-site storage; storage buckets are **not** included in DB dumps —
  copy them via the S3-compatible API.
- Store `ENCRYPTION_KEY` alongside backups (separately secured): a restored DB without it cannot
  decrypt WhatsApp/AI tokens.
- Test a restore into a scratch project before go-live.
