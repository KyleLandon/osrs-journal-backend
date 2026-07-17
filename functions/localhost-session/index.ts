/**
 * POST /localhost-session — exchanges a sync token for a ~5 minute read-only
 * session token. Used by the plugin's "Open full journal" button so the browser
 * can show private data (bank, gear) without the user signing in: the URL
 * carries ?local_session=<token> and the site reads via /localhost-read.
 * Short TTL keeps a leaked URL (e.g. streamed screen) low-risk.
 */
import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { adminClient, resolveSyncToken } from "../_shared/supabase.ts";

const SESSION_TTL_MINUTES = 5;

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const syncToken = req.headers.get("x-sync-token");
  if (!syncToken) {
    return errorResponse("X-Sync-Token header required", 401);
  }

  const admin = adminClient();
  const resolved = await resolveSyncToken(admin, syncToken);
  if (!resolved) {
    return errorResponse("Invalid sync token", 401);
  }

  // Opportunistic cleanup of expired sessions (indexed on expires_at)
  await admin
    .from("localhost_sessions")
    .delete()
    .lt("expires_at", new Date().toISOString());

  const sessionToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000).toISOString();

  const { error } = await admin.from("localhost_sessions").insert({
    token: sessionToken,
    rsn: resolved.rsn,
    expires_at: expiresAt,
  });

  if (error) {
    console.error("localhost-session insert", error);
    return errorResponse("Failed to create session", 500);
  }

  return jsonResponse({
    session_token: sessionToken,
    rsn: resolved.rsn,
    expires_in: SESSION_TTL_MINUTES * 60,
  });
});
