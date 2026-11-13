/**
 * Sliding-window rate limiting backed by the rate_limit_events table.
 *
 * Postgres-based rather than in-memory because Edge Function instances are
 * ephemeral and don't share state. The check is a single RPC (count + insert)
 * so /sync is not two extra round trips. Fails open on database errors — a
 * broken limiter should degrade to "no limiting", never to an outage.
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
  const { data, error } = await admin.rpc("check_rate_limit", {
    p_bucket: bucket,
    p_max_events: maxEvents,
    p_window_ms: windowMs,
  });

  if (error) {
    console.error("rate limit rpc", bucket, error);
    return true;
  }

  return data !== false;
}
