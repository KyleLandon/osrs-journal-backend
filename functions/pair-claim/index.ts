/**
 * POST /pair-claim — called by the website (signed-in user) to redeem a pairing
 * code and bind the character's sync token to their account.
 *
 * Requires a valid Supabase Auth JWT. Existing characters may only be
 * re-paired by their current owner; knowing an RSN or obtaining a fresh code
 * does not prove ownership. Claiming and rotating credentials is atomic.
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

  const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
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

  const { data, error } = await admin.rpc("claim_pair_session", {
    p_code: code,
    p_user_id: userId,
  });
  if (error) {
    const status = error.message === "Character already linked to another account" ? 403
      : error.message === "Invalid or expired pairing code" ? 404 : 500;
    if (status === 500) console.error("pair-claim", error);
    return errorResponse(status === 500 ? "Failed to link character" : error.message, status);
  }
  return jsonResponse({ rsn: data, linked: true });
});
