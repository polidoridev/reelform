import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { spendCredits, grantCredits } from "@/lib/credits";
import { isAdminUser } from "@/lib/admin";
import {
  createVideoTask,
  type VideoModelId,
  type Resolution,
  type Ratio,
} from "@/lib/higgsfield";
import { syncPrimaryVideo } from "@/lib/videos";
import { authorizeVideo, isSubscribed, releaseFree } from "@/lib/entitlements";
import { getVideoModelAccess } from "@/lib/video-model-access";
import { matchesVideoRecommendation, normalizeRecommendationSettings, recommendVideoModel, type RecommendationSettings } from "@/lib/video-recommendation";

export const runtime = "nodejs";
export const maxDuration = 90;

interface Body {
  videoId: string; // the clip slot being shot
  prompt: string;
  resolution: Resolution;
  duration: number;
  ratio: Ratio;
  model: VideoModelId;
  cost: number;
  recommendationPrompt?: string; // original site brief, before shot planning
  recommendationSettings?: RecommendationSettings; // unsnapped control values
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // Bounds provider spend per account, credits cap total spend, not rate.
  const limited = await enforceRateLimit(user.id, "video_generate");
  if (limited) return limited;

  const body = ((await request.json().catch(() => ({}))) ?? {}) as Body;
  if (typeof body.videoId !== "string" || typeof body.prompt !== "string" || !body.prompt.trim()) {
    return NextResponse.json({ error: "Missing video or prompt" }, { status: 400 });
  }

  // Ownership check (RLS also enforces this).
  const { data: video } = await supabase
    .from("project_videos")
    .select("id, project_id, position, status, task_id, url, prompt, settings, updated_at")
    .eq("id", body.videoId)
    .eq("user_id", user.id)
    .single();
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.status === "queued" || video.status === "running" ||
      (video.settings?.uploadPending && Date.parse(video.settings.uploadPending.expiresAt) > Date.now())) {
    return NextResponse.json({ error: "This video is already rendering or uploading. Wait for it to finish first." }, { status: 409 });
  }

  // Read plan status without consuming a free allowance. A changed quote is
  // returned for review before authorization, charging, or provider calls.
  const isAdmin = isAdminUser(user.id);
  const { data: profile } = await supabase.from("profiles")
    .select("plan, plan_status, free_video_used").eq("id", user.id).single();
  const pinned = !isAdmin && !isSubscribed(profile) && !profile?.free_video_used;
  const available = await getVideoModelAccess();
  const settings = normalizeRecommendationSettings(body.recommendationSettings ?? body);
  const recommendationPrompt = typeof body.recommendationPrompt === "string" && body.recommendationPrompt.trim()
    ? body.recommendationPrompt.trim() : body.prompt.trim();
  const recommendation = recommendVideoModel({ prompt: recommendationPrompt, settings, available, pinned });
  if (!recommendation) {
    return NextResponse.json({ error: "video_model_unavailable", message: "No supported video model is available right now. Please try again shortly.", available }, { status: 503 });
  }
  if (!matchesVideoRecommendation(body, recommendation)) {
    return NextResponse.json({ error: "recommendation_changed", message: "Your video recommendation or price changed. Review the updated shot before generating.", recommendation, available }, { status: 409 });
  }

  let freeShot = false;
  let cost = 0;
  if (!isAdmin) {
    const grant = await authorizeVideo(supabase, user.id);
    if (!grant.ok) {
      return NextResponse.json({ error: grant.reason, message: grant.message }, { status: 402 });
    }
    freeShot = grant.billing === "free";
    if (freeShot !== pinned) {
      if (freeShot) await releaseFree(user.id, "video");
      return NextResponse.json({ error: "recommendation_changed", message: "Your plan changed. Refresh your recommendation before generating.", recommendation: recommendVideoModel({ prompt: recommendationPrompt, settings, available, pinned: freeShot }), available }, { status: 409 });
    }
  }

  const { model: videoModel, resolution, duration, ratio } = recommendation;

  if (!isAdmin && !freeShot) {
    cost = recommendation.cost;
    const ok = await spendCredits(user.id, cost, "video_generation", video.project_id);
    if (!ok) {
      return NextResponse.json({ error: "insufficient_credits", cost }, { status: 402 });
    }
  }

  const undoCharge = async () => {
    if (freeShot) await releaseFree(user.id, "video");
    else if (!isAdmin && cost > 0) await grantCredits(user.id, cost, "refund", video.project_id);
  };
  const admin = createSupabaseAdmin();
  let conflicted = false;
  let submitted = false;

  try {
    const { taskId } = await createVideoTask({
      prompt: body.prompt.trim(),
      resolution,
      duration,
      ratio,
      model: videoModel,
    });

    const { data: saved, error: saveError } = await admin
      .from("project_videos")
      .update({
        prompt: body.prompt.trim(),
        task_id: taskId,
        status: "queued",
        url: null,
        settings: { resolution, duration, ratio, cost, free: freeShot, model: videoModel },
        updated_at: new Date().toISOString(),
      })
      // Keep the current clip intact while the provider accepts the task. A
      // newer upload or render wins; this request refunds its charge below.
      .eq("id", video.id).eq("user_id", user.id).eq("updated_at", video.updated_at).eq("status", video.status)
      .select("id").maybeSingle();
    if (saveError) throw new Error("Could not save the video request. Please try again.");
    if (!saved) {
      conflicted = true;
      throw new Error("This video changed. Refresh it and try again.");
    }
    submitted = true;

    if (video.position === 0) await syncPrimaryVideo(admin, video.project_id);

    await admin.from("messages").insert({
      project_id: video.project_id,
      user_id: user.id,
      role: "user",
      target: "video",
      content: body.prompt.trim(),
    });

    return NextResponse.json({ taskId, cost, recommendation, settings: { model: videoModel, resolution, duration, ratio, cost, free: freeShot } });
  } catch (err) {
    // A provider timeout or a superseded request must not cost the member.
    if (!submitted) await undoCharge();
    const message = err instanceof Error ? err.message : "Video generation failed";
    return NextResponse.json({ error: message }, { status: conflicted ? 409 : 502 });
  }
}
