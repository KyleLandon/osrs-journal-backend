/**
 * POST /networth — record today's GE-estimated bank value for a character.
 *
 * The website computes the value client-side (bank rows × OSRS wiki GE prices)
 * because prices are a ~1MB payload the browser already has. This function
 * only verifies the caller's JWT owns the RSN, then upserts one row per UTC
 * day into player_networth (owner-only reads; wealth never shows publicly).
 *
 * Body: { rsn: string, value: number }
 */
import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";

const MAX_VALUE = 1_000_000_000_000_000; // sanity bound, far above max cash

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse("Authorization required", 401);
  }

  const userSb = userClient(authHeader);
  const { data: userData, error: userErr } = await userSb.auth.getUser();
  if (userErr || !userData.user) {
    return errorResponse("Invalid session", 401);
  }

  let body: { rsn?: unknown; value?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const rsn = typeof body.rsn === "string" ? body.rsn.trim() : "";
  const value = typeof body.value === "number" ? Math.round(body.value) : NaN;
  if (!rsn || rsn.length > 20) {
    return errorResponse("Invalid rsn", 400);
  }
  if (!Number.isFinite(value) || value < 0 || value > MAX_VALUE) {
    return errorResponse("Invalid value", 400);
  }

  const admin = adminClient();

  const { data: character, error: charErr } = await admin
    .from("user_characters")
    .select("rsn")
    .eq("user_id", userData.user.id)
    .eq("rsn", rsn)
    .maybeSingle();

  if (charErr) {
    console.error("networth ownership check", charErr);
    return errorResponse("Lookup failed", 500);
  }
  if (!character) {
    return errorResponse("Character not linked to this account", 403);
  }

  const snapDate = new Date().toISOString().slice(0, 10);
  const { error: upsertErr } = await admin
    .from("player_networth")
    .upsert(
      { rsn: character.rsn, snap_date: snapDate, value },
      { onConflict: "rsn,snap_date" },
    );

  if (upsertErr) {
    console.error("networth upsert", upsertErr);
    return errorResponse("Failed to record net worth", 500);
  }

  return jsonResponse({ ok: true, snap_date: snapDate });
});
