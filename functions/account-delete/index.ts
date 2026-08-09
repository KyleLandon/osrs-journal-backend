/**
 * POST /account-delete — GDPR-style full deletion, triggered from the website's
 * "Delete account & data" button (requires the user's Auth JWT).
 *
 * Removes every row for every character linked to the account — game data,
 * pair/localhost sessions, character links — then deletes the Auth user itself.
 * Order matters: child tables first (FK on players.rsn), user_characters next,
 * auth user last, so a partial failure leaves a re-runnable state rather than
 * an orphaned account.
 */
import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";

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
  const admin = adminClient();

  const { data: characters, error: charErr } = await admin
    .from("user_characters")
    .select("rsn")
    .eq("user_id", userId);

  if (charErr) {
    console.error("account-delete list characters", charErr);
    return errorResponse("Failed to load characters", 500);
  }

  const rsns = (characters ?? []).map((row) => row.rsn as string);

  try {
    for (const rsn of rsns) {
      await admin.from("player_bank").delete().eq("rsn", rsn);
      await admin.from("player_inventory").delete().eq("rsn", rsn);
      await admin.from("player_collection_log").delete().eq("rsn", rsn);
      await admin.from("player_equipment").delete().eq("rsn", rsn);
      await admin.from("player_quests").delete().eq("rsn", rsn);
      await admin.from("player_skills").delete().eq("rsn", rsn);
      await admin.from("player_snapshots").delete().eq("rsn", rsn);
      await admin.from("player_networth").delete().eq("rsn", rsn);
      await admin.from("player_goals").delete().eq("rsn", rsn);
      await admin.from("player_diaries").delete().eq("rsn", rsn);
      await admin.from("player_combat_achievements").delete().eq("rsn", rsn);
      await admin.from("players").delete().eq("rsn", rsn);
      await admin.from("pair_sessions").delete().eq("rsn", rsn);
      await admin.from("localhost_sessions").delete().eq("rsn", rsn);
    }

    const { error: unlinkErr } = await admin
      .from("user_characters")
      .delete()
      .eq("user_id", userId);

    if (unlinkErr) {
      console.error("account-delete unlink", unlinkErr);
      return errorResponse("Failed to unlink characters", 500);
    }

    const { error: deleteUserErr } = await admin.auth.admin.deleteUser(userId);
    if (deleteUserErr) {
      console.error("account-delete auth user", deleteUserErr);
      return errorResponse("Failed to delete account", 500);
    }

    return jsonResponse({ ok: true, deleted_characters: rsns.length });
  } catch (err) {
    console.error("account-delete", err);
    return errorResponse("Account deletion failed", 500);
  }
});
