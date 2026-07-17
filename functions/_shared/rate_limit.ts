/**
 * Sliding-window rate limiting backed by the rate_limit_events table.
 *
 * Postgres-based rather than in-memory because Edge Function instances are
 * ephemeral and don't share state. Each allowed request inserts one row keyed
 * by an arbitrary bucket string (e.g. "sync:token:<uuid>", "pair-init:ip:<ip>");
 * the check counts rows in the window. Fails open on database errors — a broken
 * limiter should degrade to "no limiting", never to an outage.
 */
import { adminClient } from "./supabase.ts";

/** Real client IP behind Cloudflare/Supabase proxies (best effort). */
export function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Returns true if the request is within the limit, false if rate limited.
 */
export async function checkRateLimit(
  bucket: string,
  maxEvents: number,
  windowMs: number,
): Promise<boolean> {
  const admin = adminClient();
  const since = new Date(Date.now() - windowMs).toISOString();

  const { count, error: countErr } = await admin
    .from("rate_limit_events")
    .select("id", { count: "exact", head: true })
    .eq("bucket", bucket)
    .gte("created_at", since);

  if (countErr) {
    console.error("rate limit count", bucket, countErr);
    return true;
  }

  if ((count ?? 0) >= maxEvents) {
    return false;
  }

  const { error: insertErr } = await admin.from("rate_limit_events").insert({ bucket });
  if (insertErr) {
    console.error("rate limit insert", bucket, insertErr);
  }

  // Best-effort cleanup of stale rows (keep table small)
  if (Math.random() < 0.02) {
    const stale = new Date(Date.now() - windowMs * 4).toISOString();
    await admin.from("rate_limit_events").delete().lt("created_at", stale);
  }

  return true;
}
