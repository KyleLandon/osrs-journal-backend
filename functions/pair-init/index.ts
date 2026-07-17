/**
 * POST /pair-init — called by the RuneLite plugin to start (or refresh) pairing.
 *
 * Anyone can call this with any RSN; that is by design. Knowing an RSN grants
 * nothing: the pairing code is only ever displayed inside the RuneLite client
 * of whoever made the request, so a code can only be claimed by someone who
 * can see that client. For an RSN that is already linked the existing sync
 * token is reused (re-pairing on a new PC keeps the same data); otherwise a
 * new token is minted. Rate limits (per IP and per RSN) blunt code-guessing
 * and enumeration.
 *
 * Response: { code, sync_token, expires_in, linked }
 */
import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { adminClient, checkPluginClientId, generatePairCode } from "../_shared/supabase.ts";
import { checkRateLimit, clientIp } from "../_shared/rate_limit.ts";

const PAIR_TTL_MINUTES = 10;
const IP_LIMIT = 30;
const IP_WINDOW_MS = 60 * 60 * 1000;
const RSN_LIMIT = 10;
const RSN_WINDOW_MS = 60 * 60 * 1000;

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  if (!checkPluginClientId(req)) {
    return errorResponse("Invalid plugin client id", 403);
  }

  let body: { rsn?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body");
  }

  const rsn = body.rsn?.trim();
  if (!rsn || rsn.length > 32) {
    return errorResponse("rsn is required");
  }

  const ip = clientIp(req);
  if (!(await checkRateLimit(`pair-init:ip:${ip}`, IP_LIMIT, IP_WINDOW_MS))) {
    return errorResponse("Too many pairing requests — try again later", 429);
  }
  if (!(await checkRateLimit(`pair-init:rsn:${rsn.toLowerCase()}`, RSN_LIMIT, RSN_WINDOW_MS))) {
    return errorResponse("Too many pairing requests for this character", 429);
  }

  const admin = adminClient();

  // Opportunistic cleanup: expired unclaimed sessions are useless, and the
  // expires_at partial index makes this cheap.
  await admin
    .from("pair_sessions")
    .delete()
    .is("claimed_by", null)
    .lt("expires_at", new Date().toISOString());

  const { data: existing } = await admin
    .from("user_characters")
    .select("sync_token, user_id")
    .eq("rsn", rsn)
    .maybeSingle();

  if (existing?.sync_token) {
    const code = generatePairCode();
    const expiresAt = new Date(Date.now() + PAIR_TTL_MINUTES * 60 * 1000).toISOString();

    await admin.from("pair_sessions").delete().eq("rsn", rsn).is("claimed_by", null);

    const { error: insertErr } = await admin.from("pair_sessions").insert({
      code,
      rsn,
      sync_token: existing.sync_token,
      expires_at: expiresAt,
    });

    if (insertErr) {
      console.error("pair-init existing insert", insertErr);
      return errorResponse("Failed to create pair session", 500);
    }

    return jsonResponse({
      code,
      sync_token: existing.sync_token,
      expires_in: PAIR_TTL_MINUTES * 60,
      linked: true,
    });
  }

  const syncToken = crypto.randomUUID();
  const code = generatePairCode();
  const expiresAt = new Date(Date.now() + PAIR_TTL_MINUTES * 60 * 1000).toISOString();

  await admin.from("pair_sessions").delete().eq("rsn", rsn).is("claimed_by", null);

  const { error: insertErr } = await admin.from("pair_sessions").insert({
    code,
    rsn,
    sync_token: syncToken,
    expires_at: expiresAt,
  });

  if (insertErr) {
    console.error("pair-init insert", insertErr);
    return errorResponse("Failed to create pair session", 500);
  }

  return jsonResponse({
    code,
    sync_token: syncToken,
    expires_in: PAIR_TTL_MINUTES * 60,
    linked: false,
  });
});
