# Auth setup for journal.osrsjournal.com

Domain registered on **Cloudflare** (`OSRSJOURNAL.COM`). Configure in three places —
they use **different** URLs.

## Quick reference

| Where | What to put |
|-------|-------------|
| **Supabase** → URL configuration | Your journal site (`journal.osrsjournal.com`) |
| **Google** → Authorized redirect URI | Supabase callback only |
| **Discord** → Redirect URI | Supabase callback only |

**Do not** put `journal.osrsjournal.com` in Google or Discord redirect URIs.

---

## 1. Supabase — URL configuration

[Supabase Dashboard](https://supabase.com/dashboard) → **Authentication** → **URL configuration**

| Setting | Value |
|---------|-------|
| Site URL | `https://journal.osrsjournal.com` |

**Redirect URLs** (add each line separately):

```
https://journal.osrsjournal.com/
https://journal.osrsjournal.com/**
http://127.0.0.1:**
http://localhost:**
```

The trailing slash on the first line matters — the app redirects to `https://journal.osrsjournal.com/` after OAuth.

Optional if you use the apex domain later:

```
https://osrsjournal.com/
https://osrsjournal.com/**
```

---

## 2. Google

[Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → your **OAuth 2.0 Client ID** (Web application)

| Field | Value |
|-------|-------|
| Authorized JavaScript origins | `https://journal.osrsjournal.com` |
| | `https://ahutsqmyahyxmrocrmwd.supabase.co` |
| Authorized redirect URIs | `https://ahutsqmyahyxmrocrmwd.supabase.co/auth/v1/callback` |

Copy **Client ID** and **Client secret** into Supabase → **Authentication** → **Providers** → **Google**.

---

## 3. Discord

[Discord Developer Portal](https://discord.com/developers/applications) → your app → **OAuth2**

| Field | Value |
|-------|-------|
| Redirects | `https://ahutsqmyahyxmrocrmwd.supabase.co/auth/v1/callback` |

Copy **Client ID** and **Client secret** into Supabase → **Authentication** → **Providers** → **Discord**.

---

## 4. Email / password

Supabase → Auth → Providers → **Email**:

- Enable Email provider
- Optional: disable “Confirm email” for faster dev testing
- Magic links also work via **Email me a sign-in link** in the journal

---

## OAuth flow (why the URLs differ)

1. User clicks **Google** or **Discord** on `https://journal.osrsjournal.com`
2. Browser goes to Google/Discord, then to **Supabase**:
   `https://ahutsqmyahyxmrocrmwd.supabase.co/auth/v1/callback`
3. Supabase sends the user back to **your site**:
   `https://journal.osrsjournal.com/`

Google and Discord only ever see the Supabase callback URL (step 2).  
Supabase only allows returning to URLs in its Redirect URLs list (step 3).

---

## Troubleshooting

| Symptom | Likely fix |
|---------|------------|
| **`localhost` refused to connect after Google/Discord** | Supabase **Site URL** is still `http://localhost:...` — change it to `https://journal.osrsjournal.com`. Also add `https://journal.osrsjournal.com/` to **Redirect URLs**. |
| Google: `redirect_uri_mismatch` | Google redirect URI must be exactly `https://ahutsqmyahyxmrocrmwd.supabase.co/auth/v1/callback` — not your journal domain |
| Discord: `Invalid OAuth2 redirect_uri` | Same — use the Supabase callback URL in Discord OAuth2 → Redirects |
| Lands on Supabase error / wrong site after login | Fix Supabase **Site URL** and add `https://journal.osrsjournal.com/` to **Redirect URLs** |
| Signed in from RuneLite plugin, OAuth broke | Use **Open full journal** again (plugin now opens `journal.osrsjournal.com`, not `127.0.0.1`) |

---

## What players see

- **Sign in** with Google, Discord, or email — no database jargon
- **Public profiles** on by default (skills + quests, like Wise Old Man)
- **Privacy toggle** in Account panel — bank and gear always private
- Plugin requires **zero configuration** for cloud sync
