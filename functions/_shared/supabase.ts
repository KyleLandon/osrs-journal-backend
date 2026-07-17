import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

/**
 * Service-role client — bypasses RLS and column grants. This is how all plugin
 * writes happen; the corresponding trust decision is that every function using
 * it must scope queries to an RSN/user it has already authenticated.
 */
export function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Anon-key client that forwards the caller's Authorization header — used only
 * to validate a website user's JWT via auth.getUser(), never for data access.
 */
export function userClient(authHeader: string) {
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  }
  return createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Optional hardening: if the PLUGIN_CLIENT_ID secret is set, pair-init requires
 * a matching X-Plugin-Client-Id header. Unset (the default) accepts everything —
 * the shared ID only raises the bar for lazy abuse, it is not a real secret
 * since it ships inside the public plugin jar.
 */
export function checkPluginClientId(req: Request): boolean {
  const expected = Deno.env.get("PLUGIN_CLIENT_ID");
  if (!expected) {
    return true;
  }
  return req.headers.get("x-plugin-client-id") === expected;
}

/**
 * 8-char code shown in the RuneLite sidebar (formatted XXXX-XXXX). Alphabet
 * omits 0/O/1/I to avoid transcription errors; 32^8 ≈ 1.1e12 combinations
 * against a 10-minute TTL and per-IP rate limits makes guessing impractical.
 */
export function generatePairCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += chars[Math.floor(Math.random() * chars.length)];
  }
  return raw.slice(0, 4) + "-" + raw.slice(4);
}

/**
 * Maps a sync token to its RSN. Claimed characters (user_characters) win;
 * otherwise an unexpired, unclaimed pair session is accepted so the plugin can
 * sync during the window between pair-init and the user entering the code.
 * `claimed=false` tells callers the character isn't linked to an account yet.
 */
export async function resolveSyncToken(
  admin: ReturnType<typeof adminClient>,
  token: string,
): Promise<{ rsn: string; claimed: boolean } | null> {
  const { data: character } = await admin
    .from("user_characters")
    .select("rsn")
    .eq("sync_token", token)
    .maybeSingle();

  if (character?.rsn) {
    return { rsn: character.rsn, claimed: true };
  }

  const { data: session } = await admin
    .from("pair_sessions")
    .select("rsn, expires_at, claimed_by")
    .eq("sync_token", token)
    .is("claimed_by", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (session?.rsn) {
    return { rsn: session.rsn, claimed: false };
  }

  return null;
}
