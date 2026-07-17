/**
 * GET/POST /goals — persist the website goal planner per character.
 *
 * GET  ?rsn=Name  — returns { goals: [...] } for an owned character
 * POST { rsn, goals } — upserts the goals JSON array (JWT must own RSN)
 *
 * localStorage remains a cache; this is the source of truth when signed in.
 */
import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";

const MAX_GOALS = 40;

function sanitizeGoals(raw: unknown): unknown[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_GOALS) return null;
  return raw.map((g) => {
    if (!g || typeof g !== "object") return null;
    const o = g as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof o.label === "string") out.label = o.label.slice(0, 80);
    if (typeof o.quest === "string") out.quest = o.quest.slice(0, 80);
    if (typeof o.roadmap === "string") out.roadmap = o.roadmap.slice(0, 40);
    if (o.all === true) out.all = true;
    if (o.main === true) out.main = true;
    if (typeof o.id === "string") out.id = o.id.slice(0, 40);
    return out;
  }).filter(Boolean);
}

async function requireOwnedRsn(authHeader: string, rsn: string) {
  const userSb = userClient(authHeader);
  const { data: userData, error: userErr } = await userSb.auth.getUser();
  if (userErr || !userData.user) {
    return { error: errorResponse("Invalid session", 401) };
  }
  const admin = adminClient();
  const { data: character, error: charErr } = await admin
    .from("user_characters")
    .select("rsn")
    .eq("user_id", userData.user.id)
    .eq("rsn", rsn)
    .maybeSingle();
  if (charErr) {
    console.error("goals ownership", charErr);
    return { error: errorResponse("Lookup failed", 500) };
  }
  if (!character) {
    return { error: errorResponse("Character not linked to this account", 403) };
  }
  return { admin, rsn: character.rsn as string };
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse("Authorization required", 401);
  }

  if (req.method === "GET") {
    const url = new URL(req.url);
    const rsn = (url.searchParams.get("rsn") || "").trim();
    if (!rsn || rsn.length > 20) return errorResponse("Invalid rsn", 400);
    const owned = await requireOwnedRsn(authHeader, rsn);
    if ("error" in owned && owned.error) return owned.error;
    const { admin, rsn: ownedRsn } = owned as { admin: ReturnType<typeof adminClient>; rsn: string };
    const { data, error } = await admin
      .from("player_goals")
      .select("goals, updated_at")
      .eq("rsn", ownedRsn)
      .maybeSingle();
    if (error) {
      console.error("goals get", error);
      return errorResponse("Failed to load goals", 500);
    }
    return jsonResponse({ goals: data?.goals ?? [], updated_at: data?.updated_at ?? null });
  }

  if (req.method === "POST") {
    let body: { rsn?: unknown; goals?: unknown };
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }
    const rsn = typeof body.rsn === "string" ? body.rsn.trim() : "";
    if (!rsn || rsn.length > 20) return errorResponse("Invalid rsn", 400);
    const goals = sanitizeGoals(body.goals);
    if (!goals) return errorResponse("Invalid goals", 400);

    const owned = await requireOwnedRsn(authHeader, rsn);
    if ("error" in owned && owned.error) return owned.error;
    const { admin, rsn: ownedRsn } = owned as { admin: ReturnType<typeof adminClient>; rsn: string };

    // Ensure players row exists (FK)
    await admin.from("players").upsert({ rsn: ownedRsn }, { onConflict: "rsn" });

    const { error } = await admin.from("player_goals").upsert(
      { rsn: ownedRsn, goals, updated_at: new Date().toISOString() },
      { onConflict: "rsn" },
    );
    if (error) {
      console.error("goals upsert", error);
      return errorResponse("Failed to save goals", 500);
    }
    return jsonResponse({ ok: true });
  }

  return errorResponse("Method not allowed", 405);
});
