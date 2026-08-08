/**
 * POST /pair-claim — called by the website (signed-in user) to redeem a pairing
 * code and bind the character's sync token to their account.
 *
 * Requires a valid Supabase Auth JWT. If the RSN is already linked to another
 * account, claiming a fresh code re-links it to the claimer — intentional, since
 * producing a live code proves control of the RuneLite client logged in as that
 * character (this is also the account-recovery path).
 */
import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";
import { checkRateLimit, clientIp } from "../_shared/rate_limit.ts";

// Codes are short-lived but guessable in principle; cap attempts per user and IP.
const USER_LIMIT = 20;
const USER_WINDOW_MS = 15 * 60 * 1000;
const IP_LIMIT = 60;
const IP_WINDOW_MS = 60 * 60 * 1000;

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

  const userId = userData.user.id;

  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body");
  }

  const code = body.code?.trim().toUpperCase();
  if (!code) {
    return errorResponse("code is required");
  }

  const ip = clientIp(req);
  if (!(await checkRateLimit(`pair-claim:user:${userId}`, USER_LIMIT, USER_WINDOW_MS))) {
    return errorResponse("Too many claim attempts — try again later", 429);
  }
  if (!(await checkRateLimit(`pair-claim:ip:${ip}`, IP_LIMIT, IP_WINDOW_MS))) {
    return errorResponse("Too many claim attempts — try again later", 429);
  }

  const admin = adminClient();

  const { data: session, error: sessionErr } = await admin
    .from("pair_sessions")
    .select("*")
    .eq("code", code)
    .is("claimed_by", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (sessionErr || !session) {
    return errorResponse("Invalid or expired pairing code", 404);
  }

  const { data: existingChar } = await admin
    .from("user_characters")
    .select("id, user_id")
    .eq("rsn", session.rsn)
    .maybeSingle();

  if (existingChar) {
    const { error: updateErr } = await admin
      .from("user_characters")
      .update({ user_id: userId, sync_token: session.sync_token, updated_at: new Date().toISOString() })
      .eq("rsn", session.rsn);

    if (updateErr) {
      console.error("pair-claim update character", updateErr);
      return errorResponse("Failed to link character", 500);
    }
  } else {
    const { error: insertErr } = await admin.from("user_characters").insert({
      user_id: userId,
      rsn: session.rsn,
      sync_token: session.sync_token,
      is_public: true,
    });

    if (insertErr) {
      console.error("pair-claim insert character", insertErr);
      return errorResponse("Failed to link character", 500);
    }
  }

  await admin
    .from("players")
    .upsert({ rsn: session.rsn, owner_id: userId }, { onConflict: "rsn" });

  const { error: claimErr } = await admin
    .from("pair_sessions")
    .update({ claimed_by: userId, claimed_at: new Date().toISOString() })
    .eq("code", code);

  if (claimErr) {
    console.error("pair-claim mark session", claimErr);
  }

  return jsonResponse({
    rsn: session.rsn,
    linked: true,
  });
});
