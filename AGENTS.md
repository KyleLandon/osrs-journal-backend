# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is
Backend for **OSRS Journal**: Supabase **Edge Functions** (Deno/TypeScript in `functions/`)
plus Postgres **migrations** (`migrations/`) and the project config (`config.toml`).
There is no Node/`package.json`; Deno resolves dependencies from URL imports at runtime.
The plugin and website live in separate repos, so "run the app" here means running the
local Supabase stack (Postgres + Auth + PostgREST + Realtime + Edge runtime) and exercising
the HTTP functions.

### Runtime prerequisites (already provided in the Cloud VM image)
- **Docker** — the Supabase local stack runs in containers. The `ubuntu` user is in the
  `docker` group, which is effective in a fresh login shell. In a shell that predates that
  group membership, prefix docker/supabase commands with `sg docker -c "..."`.
- **Supabase CLI** and **Deno** (`deno` is on `PATH` via `~/.bashrc`).

### Non-obvious layout: the `supabase/` scaffolding
The Supabase CLI expects `supabase/config.toml`, `supabase/functions/`, and
`supabase/migrations/`, but this repo keeps those at the **repo root**. A committed
`supabase/` directory bridges the two:
- `supabase/config.toml` — full local-dev config (the root `config.toml` only holds the
  per-function `verify_jwt` flags, which are appended here).
- `supabase/functions` → symlink to `../functions`.
- `supabase/migrations/00X_*.sql` → symlinks to the repo's real `../../migrations/*.sql`.
- `supabase/migrations/000_local_base.sql` — **LOCAL DEVELOPMENT ONLY**. The published
  migrations start at `001_multi_user.sql` and build on game-data tables (`players`,
  `player_skills`, `player_quests`, `player_equipment`, `player_bank`) created during the
  project's unpublished single-user "personal setup" era. This file recreates those base
  tables so a from-scratch `supabase start` works. It also sets `ALTER DEFAULT PRIVILEGES`
  so the `service_role`/`anon`/`authenticated` roles get the grants the Edge Functions
  expect (older Supabase projects auto-granted new tables; local stacks do not, otherwise
  service-role writes fail with `permission denied for table pair_sessions`). **Never push
  `000_local_base.sql` to the real Supabase project** — it already has these tables.
- If a new `016_*.sql` (etc.) is added to the repo's `migrations/`, add a matching symlink
  under `supabase/migrations/` so the local stack applies it.

### Running the stack (from repo root)
- Start everything: `supabase start` (first run pulls images). Ports: API `54321`,
  Postgres `54322`, Studio `54323`, Mailpit `54324`.
- Serve functions with hot reload: `supabase functions serve` (long-running; leave it up).
- Reapply migrations after editing SQL: `supabase db reset`. Note this **restarts
  containers**, so a running `supabase functions serve` keeps working but the DB is wiped.
- Get local keys/URLs: `supabase status -o env` (`ANON_KEY`, `SERVICE_ROLE_KEY`, etc.).
- Stop: `supabase stop`.

### Calling functions
Requests go to `http://127.0.0.1:54321/functions/v1/<name>` and must include the gateway
header `Authorization: Bearer <ANON_KEY>` even for functions with `verify_jwt = false`.
Auth models: `sync` / `localhost-session` use `X-Sync-Token`; `pair-claim` / `goals` /
`networth` / `account-delete` use a user JWT (mint one via `POST /auth/v1/signup`).

### App-behavior gotcha (not an env issue)
`functions/sync` writes `player_bank` / `player_inventory` / `player_collection_log`
(all FK → `players`) **before** it upserts the `players` row. A brand-new RSN's very first
sync that includes bank/inventory/collection-log therefore fails with a `players` foreign
key violation. Real usage establishes the players row with an initial profile/skills sync
first (the plugin has a separate "Sync Bank & Inventory" action), so send bank/inventory in
a second sync.

### Lint / type-check
- Lint: `deno lint functions/`
- Type-check (closest thing to a build for the edge functions): `deno check functions/*/index.ts`
