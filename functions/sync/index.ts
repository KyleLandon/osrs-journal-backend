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
 * equipment / bank / inventory / collection log in one request. Nested row
 * `rsn` fields are ignored and rewritten to the token-bound RSN. Response
 * includes `claimed` so the plugin learns its linked state without a
 * separate pair-init call.
 */
import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { adminClient, resolveSyncToken } from "../_shared/supabase.ts";
import { checkRateLimit } from "../_shared/rate_limit.ts";

const SYNC_LIMIT = 120;
const SYNC_WINDOW_MS = 60 * 1000;

type CollectionLogItem = {
  item_id?: unknown;
  item_name?: unknown;
  quantity?: unknown;
};

type CollectionLogKillCount = {
  name?: unknown;
  amount?: unknown;
};

type CollectionLogPage = {
  page?: unknown;
  items?: unknown;
  obtained?: unknown;
  obtained_total?: unknown;
  kill_counts?: unknown;
};

type SyncBody = {
  rsn?: string;
  players?: Record<string, unknown>[];
  player_skills?: Record<string, unknown>[];
  player_quests?: Record<string, unknown>[];
  player_equipment?: Record<string, unknown>[];
  player_bank?: Record<string, unknown>[];
  player_diaries?: Record<string, unknown>[];
  player_combat_achievements?: Record<string, unknown>[];
  /** Inventory rows (item_id, item_name, quantity). Written via atomic replace. */
  inventory_tracked?: unknown[];
  player_inventory?: Record<string, unknown>[];
  /** Single collection-log page replace. */
  collection_log?: CollectionLogPage;
  /** Batch of collection-log page replaces. */
  collection_log_pages?: CollectionLogPage[];
  replace_equipment?: boolean;
  replace_bank?: boolean;
  replace_inventory?: boolean;
  touch_last_synced?: boolean;
  profile_public?: boolean;
};

/** Force every row onto the token-bound RSN; never trust client-supplied rsn. */
function forceRsn(
  rows: Record<string, unknown>[] | undefined,
  rsn: string,
): Record<string, unknown>[] {
  if (!rows?.length) return [];
  return rows.map((row) => ({ ...row, rsn }));
}

function asItemJson(rows: unknown[] | undefined): unknown[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const r = (row && typeof row === "object") ? row as Record<string, unknown> : {};
    return {
      item_id: r.item_id,
      item_name: r.item_name ?? "Unknown",
      quantity: r.quantity ?? 0,
    };
  });
}

function asCollectionLogItems(items: unknown): unknown[] {
  if (!Array.isArray(items)) return [];
  return items.map((row) => {
    const r = (row && typeof row === "object") ? row as CollectionLogItem : {};
    return {
      item_id: r.item_id,
      item_name: r.item_name ?? "",
      quantity: r.quantity ?? 1,
    };
  });
}

function asKillCounts(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const row of raw) {
    const r = (row && typeof row === "object") ? row as CollectionLogKillCount : {};
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const amount = typeof r.amount === "number"
      ? r.amount
      : (typeof r.amount === "string" ? Number(r.amount) : NaN);
    if (!name || !Number.isFinite(amount)) continue;
    out.push({ name, amount: Math.trunc(amount) });
  }
  return out;
}

function asOptionalInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

/** Normalize single-page + multi-page payloads into page records. */
function normalizeCollectionLogPages(body: SyncBody): {
  page: string;
  items: unknown[];
  obtained: number | null;
  obtained_total: number | null;
  kill_counts: unknown[];
}[] {
  const pages: {
    page: string;
    items: unknown[];
    obtained: number | null;
    obtained_total: number | null;
    kill_counts: unknown[];
  }[] = [];
  const push = (raw: CollectionLogPage | undefined) => {
    if (!raw || typeof raw !== "object") return;
    const page = typeof raw.page === "string" ? raw.page.trim() : "";
    if (!page) return;
    pages.push({
      page,
      items: asCollectionLogItems(raw.items),
      obtained: asOptionalInt(raw.obtained),
      obtained_total: asOptionalInt(raw.obtained_total),
      kill_counts: asKillCounts(raw.kill_counts),
    });
  };
  if (Array.isArray(body.collection_log_pages)) {
    for (const p of body.collection_log_pages) push(p);
  }
  if (body.collection_log) push(body.collection_log);
  return pages;
}

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
  const criticalErrors: string[] = [];

  const inventoryRows = body.player_inventory ??
    (Array.isArray(body.inventory_tracked)
      ? body.inventory_tracked as Record<string, unknown>[]
      : undefined);
  const replaceInventory = body.replace_inventory === true ||
    body.inventory_tracked !== undefined ||
    body.player_inventory !== undefined;

  try {
    if (body.replace_equipment) {
      const { error } = await admin.from("player_equipment").delete().eq("rsn", rsn);
      if (error) {
        errors.push(`equipment delete: ${error.message}`);
        criticalErrors.push(`equipment delete: ${error.message}`);
      }
    }

    // Bank: prefer atomic RPC when replacing; fall back to delete+upsert.
    if (body.replace_bank) {
      const { error } = await admin.rpc("sync_replace_bank", {
        p_rsn: rsn,
        p_items: asItemJson(body.player_bank),
      });
      if (error) {
        // Older DBs without the RPC still work via delete+upsert below.
        if (/sync_replace_bank|function .* does not exist/i.test(error.message)) {
          const del = await admin.from("player_bank").delete().eq("rsn", rsn);
          if (del.error) {
            errors.push(`bank delete: ${del.error.message}`);
            criticalErrors.push(`bank delete: ${del.error.message}`);
          } else if (body.player_bank?.length) {
            const rows = forceRsn(body.player_bank, rsn);
            const ups = await admin.from("player_bank").upsert(rows, { onConflict: "rsn,item_id" });
            if (ups.error) {
              errors.push(`bank: ${ups.error.message}`);
              criticalErrors.push(`bank: ${ups.error.message}`);
            }
          }
        } else {
          errors.push(`bank replace: ${error.message}`);
          criticalErrors.push(`bank replace: ${error.message}`);
        }
      }
    } else if (body.player_bank?.length) {
      const rows = forceRsn(body.player_bank, rsn);
      const { error } = await admin.from("player_bank").upsert(rows, { onConflict: "rsn,item_id" });
      if (error) {
        errors.push(`bank: ${error.message}`);
        criticalErrors.push(`bank: ${error.message}`);
      }
    }

    if (replaceInventory) {
      const { error } = await admin.rpc("sync_replace_inventory", {
        p_rsn: rsn,
        p_items: asItemJson(inventoryRows),
      });
      if (error) {
        if (/sync_replace_inventory|function .* does not exist/i.test(error.message)) {
          const del = await admin.from("player_inventory").delete().eq("rsn", rsn);
          if (del.error) {
            errors.push(`inventory delete: ${del.error.message}`);
            criticalErrors.push(`inventory delete: ${del.error.message}`);
          } else if (inventoryRows?.length) {
            const rows = forceRsn(inventoryRows, rsn);
            const ups = await admin.from("player_inventory").upsert(rows, {
              onConflict: "rsn,item_id",
            });
            if (ups.error) {
              errors.push(`inventory: ${ups.error.message}`);
              criticalErrors.push(`inventory: ${ups.error.message}`);
            }
          }
        } else {
          errors.push(`inventory replace: ${error.message}`);
          criticalErrors.push(`inventory replace: ${error.message}`);
        }
      }
    }

    const collectionLogPages = normalizeCollectionLogPages(body);
    for (const page of collectionLogPages) {
      const { error } = await admin.rpc("sync_replace_collection_log", {
        p_rsn: rsn,
        p_page: page.page,
        p_items: page.items,
        p_obtained: page.obtained,
        p_obtained_total: page.obtained_total,
        p_kill_counts: page.kill_counts,
      });
      if (error) {
        // Older DBs may only have the 3-arg RPC — retry without page metadata.
        if (/sync_replace_collection_log|function .* does not exist|Could not find the function/i.test(error.message)) {
          const fallback = await admin.rpc("sync_replace_collection_log", {
            p_rsn: rsn,
            p_page: page.page,
            p_items: page.items,
          });
          if (fallback.error) {
            errors.push(`collection_log (${page.page}): ${fallback.error.message}`);
            criticalErrors.push(`collection_log (${page.page}): ${fallback.error.message}`);
          }
        } else {
          errors.push(`collection_log (${page.page}): ${error.message}`);
          criticalErrors.push(`collection_log (${page.page}): ${error.message}`);
        }
      }
    }

    const hasGameData = Boolean(
      body.player_skills?.length ||
        body.player_quests?.length ||
        body.player_equipment?.length ||
        body.replace_equipment ||
        body.player_bank?.length ||
        body.replace_bank ||
        body.player_diaries?.length ||
        body.player_combat_achievements?.length ||
        replaceInventory ||
        collectionLogPages.length,
    );

    // players row must exist before skills/quests (FK). Never trust nested rsn /
    // owner_id / private columns from the client.
    if (body.players?.length) {
      const safePlayers = forceRsn(body.players, rsn).map((row) => {
        const out: Record<string, unknown> = { rsn };
        if (row.quest_points != null) out.quest_points = row.quest_points;
        if (row.last_synced != null) out.last_synced = row.last_synced;
        if (row.collection_count != null) out.collection_count = row.collection_count;
        if (row.collection_count_max != null) out.collection_count_max = row.collection_count_max;
        return out;
      });
      const { error } = await admin.from("players").upsert(safePlayers, { onConflict: "rsn" });
      if (error) errors.push(`players: ${error.message}`);
    } else if (hasGameData) {
      const { error } = await admin.from("players").upsert({ rsn }, { onConflict: "rsn" });
      if (error) errors.push(`players stub: ${error.message}`);
    }

    if (body.player_skills?.length) {
      const rows = forceRsn(body.player_skills, rsn);
      const { error } = await admin.from("player_skills").upsert(rows, {
        onConflict: "rsn,skill",
      });
      if (error) errors.push(`skills: ${error.message}`);

      const today = new Date().toISOString().slice(0, 10);
      const snaps = rows
        .filter((r) => r.skill != null && r.xp != null)
        .map((r) => ({
          rsn,
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
      const rows = forceRsn(body.player_quests, rsn);
      const { error } = await admin.from("player_quests").upsert(rows, {
        onConflict: "rsn,quest_name",
      });
      if (error) errors.push(`quests: ${error.message}`);
    }
    if (body.player_equipment?.length) {
      const rows = forceRsn(body.player_equipment, rsn);
      const { error } = await admin.from("player_equipment").upsert(rows, {
        onConflict: "rsn,slot_id",
      });
      if (error) {
        errors.push(`equipment: ${error.message}`);
        criticalErrors.push(`equipment: ${error.message}`);
      }
    }
    if (body.player_diaries?.length) {
      const rows = forceRsn(body.player_diaries, rsn).map((r) => ({
        ...r,
        rsn,
        updated_at: new Date().toISOString(),
      }));
      const { error } = await admin.from("player_diaries").upsert(rows, {
        onConflict: "rsn,region,tier",
      });
      if (error) errors.push(`diaries: ${error.message}`);
    }
    if (body.player_combat_achievements?.length) {
      const rows = forceRsn(body.player_combat_achievements, rsn).map((r) => ({
        ...r,
        rsn,
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

    if (criticalErrors.length) {
      console.error("sync critical errors for", rsn, criticalErrors);
      return errorResponse("Sync failed: " + criticalErrors[0], 500);
    }

    if (errors.length) {
      console.error("sync partial errors for", rsn, errors);
      if (hasGameData) {
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
