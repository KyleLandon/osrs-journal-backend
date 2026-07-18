/**
 * POST /sync — the plugin's single write path for game data.
 *
 * Auth: X-Sync-Token header. The token is resolved server-side to an RSN
 * (claimed characters first, then unexpired unclaimed pair sessions), and the
 * payload may only touch that RSN — so a token can never write another
 * player's data. All writes run with the service role; client roles have no
 * write access to these tables at all.
 *
 * The body is a batch: any combination of players / skills / quests /
 * equipment / bank in one request. Response includes `claimed` so the plugin
 * learns its linked state without a separate pair-init call.
 */
import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { adminClient, resolveSyncToken } from "../_shared/supabase.ts";
import { checkRateLimit } from "../_shared/rate_limit.ts";

const SYNC_LIMIT = 120;
const SYNC_WINDOW_MS = 60 * 1000;

type SyncBody = {
  rsn?: string;
  players?: Record<string, unknown>[];
  player_skills?: Record<string, unknown>[];
  player_quests?: Record<string, unknown>[];
  player_equipment?: Record<string, unknown>[];
  player_bank?: Record<string, unknown>[];
  player_diaries?: Record<string, unknown>[];
  player_combat_achievements?: Record<string, unknown>[];
  /** Inventory snapshot (counted with bank for ownership / quantities). */
  inventory_tracked?: unknown[];
  replace_equipment?: boolean;
  replace_bank?: boolean;
  touch_last_synced?: boolean;
  profile_public?: boolean;
};

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

  let body: SyncBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body");
  }

  const admin = adminClient();
  const resolved = await resolveSyncToken(admin, syncToken);
  if (!resolved) {
    return errorResponse("Invalid sync token", 401);
  }

  if (body.rsn && body.rsn !== resolved.rsn) {
    return errorResponse("RSN does not match sync token", 403);
  }

  const rsn = resolved.rsn;

  if (!(await checkRateLimit(`sync:token:${syncToken}`, SYNC_LIMIT, SYNC_WINDOW_MS))) {
    return errorResponse("Sync rate limit exceeded — try again shortly", 429);
  }

  const errors: string[] = [];

  try {
    if (body.replace_equipment) {
      const { error } = await admin.from("player_equipment").delete().eq("rsn", rsn);
      if (error) errors.push(`equipment delete: ${error.message}`);
    }
    if (body.replace_bank) {
      const { error } = await admin.from("player_bank").delete().eq("rsn", rsn);
      if (error) errors.push(`bank delete: ${error.message}`);
    }

    const hasGameData = Boolean(
      body.player_skills?.length ||
        body.player_quests?.length ||
        body.player_equipment?.length ||
        body.player_bank?.length ||
        body.player_diaries?.length ||
        body.player_combat_achievements?.length ||
        body.inventory_tracked !== undefined,
    );

    // players row must exist before skills/quests (FK). Errors here are non-fatal
    // so a bad players payload cannot block skill/quest updates for existing chars.
    if (body.players?.length) {
      const { error } = await admin.from("players").upsert(body.players, { onConflict: "rsn" });
      if (error) errors.push(`players: ${error.message}`);
    } else if (hasGameData) {
      const { error } = await admin.from("players").upsert({ rsn }, { onConflict: "rsn" });
      if (error) errors.push(`players stub: ${error.message}`);
    }

    if (body.player_skills?.length) {
      const { error } = await admin.from("player_skills").upsert(body.player_skills, {
        onConflict: "rsn,skill",
      });
      if (error) errors.push(`skills: ${error.message}`);

      // Daily XP snapshot: one row per skill per UTC day, last write wins.
      // Powers gains graphs / recommendations; non-fatal if it fails.
      const today = new Date().toISOString().slice(0, 10);
      const snaps = body.player_skills
        .filter((r) => r.skill != null && r.xp != null)
        .map((r) => ({
          rsn: (r.rsn as string) ?? rsn,
          snap_date: today,
          skill: r.skill,
          level: r.level ?? 1,
          xp: r.xp,
        }));
      if (snaps.length) {
        const { error: snapError } = await admin
          .from("player_snapshots")
          .upsert(snaps, { onConflict: "rsn,snap_date,skill" });
        if (snapError) errors.push(`snapshots: ${snapError.message}`);
      }
    }
    if (body.player_quests?.length) {
      const { error } = await admin.from("player_quests").upsert(body.player_quests, {
        onConflict: "rsn,quest_name",
      });
      if (error) errors.push(`quests: ${error.message}`);
    }
    if (body.player_equipment?.length) {
      const { error } = await admin.from("player_equipment").upsert(body.player_equipment, {
        onConflict: "rsn,slot_id",
      });
      if (error) errors.push(`equipment: ${error.message}`);
    }
    if (body.player_bank?.length) {
      const { error } = await admin.from("player_bank").upsert(body.player_bank, {
        onConflict: "rsn,item_id",
      });
      if (error) errors.push(`bank: ${error.message}`);
    }
    if (body.inventory_tracked !== undefined) {
      const { error } = await admin.from("players").upsert(
        { rsn, inventory_tracked: body.inventory_tracked ?? [] },
        { onConflict: "rsn" },
      );
      if (error) errors.push(`inventory_tracked: ${error.message}`);
    }
    if (body.player_diaries?.length) {
      const rows = body.player_diaries.map((r) => ({
        ...r,
        rsn: (r.rsn as string) ?? rsn,
        updated_at: new Date().toISOString(),
      }));
      const { error } = await admin.from("player_diaries").upsert(rows, {
        onConflict: "rsn,region,tier",
      });
      if (error) errors.push(`diaries: ${error.message}`);
    }
    if (body.player_combat_achievements?.length) {
      const rows = body.player_combat_achievements.map((r) => ({
        ...r,
        rsn: (r.rsn as string) ?? rsn,
        updated_at: new Date().toISOString(),
      }));
      const { error } = await admin.from("player_combat_achievements").upsert(rows, {
        onConflict: "rsn,tier",
      });
      if (error) errors.push(`combat_achievements: ${error.message}`);
    }

    if (body.touch_last_synced !== false) {
      const { error } = await admin
        .from("players")
        .upsert(
          { rsn, last_synced: new Date().toISOString() },
          { onConflict: "rsn" },
        );
      if (error) errors.push(`last_synced: ${error.message}`);
    }

    if (typeof body.profile_public === "boolean" && resolved.claimed) {
      const { error } = await admin
        .from("user_characters")
        .update({ is_public: body.profile_public, updated_at: new Date().toISOString() })
        .eq("sync_token", syncToken);
      if (error) errors.push(`profile_public: ${error.message}`);
    }

    if (errors.length) {
      console.error("sync partial errors for", rsn, errors);
      // Fail only when no game data was written at all.
      const wroteGameData = hasGameData;
      if (wroteGameData) {
        return jsonResponse({ ok: true, rsn, claimed: resolved.claimed, warnings: errors });
      }
      return errorResponse("Sync failed", 500);
    }

    return jsonResponse({ ok: true, rsn, claimed: resolved.claimed });
  } catch (err) {
    console.error("sync error", err);
    return errorResponse("Sync failed", 500);
  }
});
