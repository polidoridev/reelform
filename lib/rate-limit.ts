import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "./supabase/admin";

// Per-user rate limits on the endpoints that cost us real money at a provider.
// Credits bound total spend but not *rate*, and admin ids bypass credits
// entirely, so without this a single account can drive the Anthropic and
// Higgsfield bills as fast as the network allows.
//
// Backed by Postgres (see supabase/migrations/20260806_rate_limits.sql) because
// the app runs serverless: an in-memory counter would be per-instance and would
// reset on every cold start.

export type LimitBucket =
  | "site_generate"
  | "site_edit"
  | "site_export"
  | "site_deploy"
  | "video_request"
  | "video_generate"
  | "video_upload"
  | "video_upload_finalize"
  | "suggest_shot"
  | "project_create"
  | "avatar_upload";

interface Limit {
  /** Calls allowed per window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Shown to the user when they hit it. */
  label: string;
}

// Ceilings sit well above real interactive use, a person iterating hard on a
// site will not notice them. They exist to stop scripts, not customers.
const LIMITS: Record<LimitBucket, Limit> = {
  site_generate: { max: 20, windowSeconds: 3600, label: "site builds" },
  site_edit: { max: 120, windowSeconds: 3600, label: "site edits" },
  site_export: { max: 60, windowSeconds: 3600, label: "exports" },
  // Deploys run on the customer's own Vercel/Supabase quota, but each one
  // uploads the full bundle, the ceiling is here to stop a runaway client.
  site_deploy: { max: 30, windowSeconds: 3600, label: "deploys" },
  video_request: { max: 40, windowSeconds: 3600, label: "video requests" },
  video_generate: { max: 40, windowSeconds: 3600, label: "video renders" },
  video_upload: { max: 20, windowSeconds: 3600, label: "footage uploads" },
  video_upload_finalize: { max: 20, windowSeconds: 3600, label: "footage imports" },
  suggest_shot: { max: 60, windowSeconds: 3600, label: "shot suggestions" },
  project_create: { max: 30, windowSeconds: 3600, label: "new productions" },
  // Costs nothing at a provider, but it does write to our storage bucket.
  avatar_upload: { max: 20, windowSeconds: 3600, label: "profile picture changes" },
};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  limit: number;
}

export async function checkRateLimit(
  userId: string,
  bucket: LimitBucket
): Promise<RateLimitResult> {
  const limit = LIMITS[bucket];
  try {
    const admin = createSupabaseAdmin();
    const { data, error } = await admin.rpc("consume_rate_limit", {
      p_user: userId,
      p_bucket: bucket,
      p_limit: limit.max,
      p_window_seconds: limit.windowSeconds,
    });
    if (error) throw error;

    const row = data as { allowed: boolean; remaining: number; reset_at: string };
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      resetAt: new Date(row.reset_at),
      limit: limit.max,
    };
  } catch (err) {
    // Fail open. A limiter outage must not take down the product it protects,
    // but it must be loud, because it means the ceiling is currently off.
    console.error(`[rate-limit] check failed for ${bucket}, allowing request:`, err);
    return {
      allowed: true,
      remaining: limit.max,
      resetAt: new Date(Date.now() + limit.windowSeconds * 1000),
      limit: limit.max,
    };
  }
}

/**
 * Guards a route. Returns a ready-to-send 429 when the caller is over the
 * limit, or null when the request may proceed.
 *
 *   const limited = await enforceRateLimit(user.id, "site_generate");
 *   if (limited) return limited;
 */
export async function enforceRateLimit(
  userId: string,
  bucket: LimitBucket
): Promise<NextResponse | null> {
  const result = await checkRateLimit(userId, bucket);
  if (result.allowed) return null;

  const retryAfter = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
  const minutes = Math.ceil(retryAfter / 60);

  return NextResponse.json(
    {
      error: "rate_limited",
      message:
        `You've hit the hourly limit for ${LIMITS[bucket].label} ` +
        `(${result.limit} per hour). Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      retryAfter,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "RateLimit-Limit": String(result.limit),
        "RateLimit-Remaining": "0",
        "RateLimit-Reset": String(retryAfter),
      },
    }
  );
}
