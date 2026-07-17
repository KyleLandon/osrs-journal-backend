# OSRS Journal — backend

The complete backend for [OSRS Journal](https://journal.osrsjournal.com): Supabase
Edge Functions, database migrations, and security policies. Published so anyone —
including RuneLite Plugin Hub reviewers and users — can verify exactly what happens
to synced data.

Companion repos:

- Plugin: [osrs-journal-plugin](https://github.com/KyleLandon/osrs-journal-plugin) (RuneLite Plugin Hub)
- Website: [osrs-journal-web](https://github.com/KyleLandon/osrs-journal-web) (journal.osrsjournal.com)
- Privacy policy: https://journal.osrsjournal.com/privacy.html

## Architecture

```
RuneLite plugin ──X-Sync-Token──> Edge Functions ──service role──> Postgres (RLS)
website (Auth JWT) ──────────────> PostgREST / Edge Functions ────> own rows only
anyone ──anon key────────────────> PostgREST ─────────────────────> public profiles only
```

The plugin holds **no database credentials**. Every write goes through an Edge
Function that resolves the per-character sync token to an RSN server-side and
only writes that character's rows.

## Security model

| Layer | Enforcement |
|-------|-------------|
| Plugin writes | `X-Sync-Token` → RSN binding checked in `functions/sync`; a token can never write another character's data |
| Website reads | Supabase Auth JWT + RLS (`migrations/001_multi_user.sql`) — users see only their linked characters |
| Public profiles | RLS policies expose skills/quests/players rows only where `is_public = true`; **bank and equipment are never publicly readable** |
| Column privileges | `sync_token`, `user_id`, `owner_id` are revoked from client roles (`migrations/006`) so no credential or account-correlation data leaks through public rows |
| Direct writes | Client roles have no INSERT/UPDATE/DELETE on game tables at all (`migrations/007`) |
| Abuse | Sliding-window rate limits per IP / RSN / token (`functions/_shared/rate_limit.ts`) |
| Deletion | `functions/account-delete` removes all character data and the auth user (GDPR-style) |

## Endpoints

| Function | Auth | Purpose |
|----------|------|---------|
| `pair-init` | optional plugin client id | Issue pairing code + sync token for an RSN |
| `pair-claim` | user JWT | Link a pairing code to a website account |
| `sync` | `X-Sync-Token` | Batched upsert of skills / quests / equipment / bank |
| `localhost-session` | `X-Sync-Token` | Mint a ~5 min read-only session for "Open full journal" |
| `localhost-read` | session token | Full read (incl. private data) for that session's RSN |
| `account-delete` | user JWT | Delete account + all synced data |

Each function's `index.ts` has a header comment documenting its auth model and
design decisions.

## Self-hosting

1. Create a Supabase project with Auth enabled (see `AUTH_SETUP.md` for OAuth).
2. Apply `migrations/` in order (`supabase db push`).
3. Deploy functions: `supabase functions deploy pair-init pair-claim sync localhost-session localhost-read account-delete`
4. Optional hardening: `supabase secrets set PLUGIN_CLIENT_ID=<random>` and set the
   same value in the plugin's Advanced config.
5. Point the plugin's **API override** (Advanced config) and the website's
   `supabase-config.json` at your project.

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically when functions are deployed — no secrets live in this repo.
