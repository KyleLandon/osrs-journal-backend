/**
 * GET /health — unauthenticated liveness probe for uptime monitors.
 * Touches the database with the cheapest possible query so a green check
 * actually means "functions AND database are serving", not just cold storage.
 */
import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { adminClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  try {
    const admin = adminClient();
    const { error } = await admin.from("players").select("rsn", { head: true, count: "exact" }).limit(1);
    if (error) throw error;
    return jsonResponse({ ok: true, ts: new Date().toISOString() });
  } catch (err) {
    console.error("health", err);
    return errorResponse("unhealthy", 503);
  }
});
