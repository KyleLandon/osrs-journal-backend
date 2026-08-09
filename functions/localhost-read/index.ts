/**
 * GET /localhost-read?session=<token> — full data read (including private bank
 * and equipment) for the RSN bound to an unexpired localhost session.
 * Complements /localhost-session; this is the only way private data leaves the
 * database without a signed-in owner, and it is scoped to one character for
 * ~5 minutes.
 */
import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { adminClient } from "../_shared/supabase.ts";
import { checkRateLimit, clientIp } from "../_shared/rate_limit.ts";

const IP_LIMIT = 300;
const IP_WINDOW_MS = 60 * 60 * 1000;
const SESSION_LIMIT = 60;
const SESSION_WINDOW_MS = 5 * 60 * 1000;

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  if (req.method !== "GET") {
    return errorResponse("Method not allowed", 405);
  }

  const url = new URL(req.url);
  const sessionToken = url.searchParams.get("session");
  if (!sessionToken) {
    return errorResponse("session query param required");
  }

  const ip = clientIp(req);
  if (!(await checkRateLimit(`localhost-read:ip:${ip}`, IP_LIMIT, IP_WINDOW_MS))) {
    return errorResponse("Too many read requests — try again later", 429);
  }
  if (!(await checkRateLimit(`localhost-read:session:${sessionToken}`, SESSION_LIMIT, SESSION_WINDOW_MS))) {
    return errorResponse("Too many read requests for this session", 429);
  }

  const admin = adminClient();

  const { data: session, error: sessionErr } = await admin
    .from("localhost_sessions")
    .select("rsn, expires_at")
    .eq("token", sessionToken)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (sessionErr || !session) {
    return errorResponse("Invalid or expired session", 401);
  }

  const rsn = session.rsn;

  const [players, skills, quests, equipment, bank, inventory, collectionLog, collectionPages] =
    await Promise.all([
      admin.from("players")
        .select("rsn, last_synced, quest_points, collection_count, collection_count_max")
        .eq("rsn", rsn),
      admin.from("player_skills").select("skill, level, xp").eq("rsn", rsn),
      admin.from("player_quests").select("quest_name, state").eq("rsn", rsn),
      admin.from("player_equipment").select("slot_id, slot_name, item_id, item_name").eq("rsn", rsn),
      admin.from("player_bank").select("item_id, item_name, quantity").eq("rsn", rsn),
      admin.from("player_inventory").select("item_id, item_name, quantity").eq("rsn", rsn),
      admin.from("player_collection_log")
        .select("page, item_id, item_name, quantity")
        .eq("rsn", rsn),
      admin.from("player_collection_pages")
        .select("page, obtained, obtained_total, kill_counts")
        .eq("rsn", rsn),
    ]);

  if (players.error) {
    console.error("localhost-read players", players.error);
    return errorResponse("Read failed", 500);
  }

  if (!skills.data?.length) {
    return errorResponse("No synced data for this character yet", 404);
  }

  return jsonResponse({
    rsn,
    player: players.data?.[0] ?? null,
    skills: skills.data ?? [],
    quests: quests.data ?? [],
    equipment: equipment.data ?? [],
    bank: bank.data ?? [],
    inventory: inventory.data ?? [],
    collection_log: collectionLog.data ?? [],
    collection_pages: collectionPages.data ?? [],
  });
});
