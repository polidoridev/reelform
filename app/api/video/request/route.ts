import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { spendCredits, grantCredits } from "@/lib/credits";
import { isAdminUser } from "@/lib/admin";
import { authorizeVideo, isSubscribed, releaseFree } from "@/lib/entitlements";
import { planClip } from "@/lib/claude";
import { createVideoTask } from "@/lib/higgsfield";
import { getVideoModelAccess } from "@/lib/video-model-access";
import { matchesVideoRecommendation, normalizeRecommendationSettings, recommendVideoModel } from "@/lib/video-recommendation";
import { listVideos, VIDEO_COLUMNS, MAX_VIDEOS_PER_PROJECT } from "@/lib/videos";

// Asking for another video in plain language: Claude turns the request into a
// named slot with a real shot prompt, then it goes straight to render. The
// clips a production already has are the context, so shots don't repeat.
export const maxDuration = 120;
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // Bounds provider spend per account, credits cap total spend, not rate.
  const limited = await enforceRateLimit(user.id, "video_request");
  if (limited) return limited;

  const body = (await request.json().catch(() => ({}))) ?? {};
  if (typeof body.projectId !== "string" || typeof body.request !== "string" || !body.request.trim()) {
    return NextResponse.json({ error: "Describe the video you want" }, { status: 400 });
  }
  const ask = body.request.trim().slice(0, 2000);

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, industry, site_brief")
    .eq("id", body.projectId)
    .single();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const clips = await listVideos(supabase, project.id);
  if (!clips.some((c) => c.status === "succeeded")) {
    return NextResponse.json(
      { error: "Shoot your first video before asking for another one." },
      { status: 400 }
    );
  }
  if (clips.length >= MAX_VIDEOS_PER_PROJECT) {
    return NextResponse.json(
      { error: `A production can hold up to ${MAX_VIDEOS_PER_PROJECT} videos.` },
      { status: 400 }
    );
  }

  const isAdmin = isAdminUser(user.id);
  const { data: profile } = await supabase.from("profiles")
    .select("plan, plan_status, free_video_used").eq("id", user.id).single();
  const pinned = !isAdmin && !isSubscribed(profile) && !profile?.free_video_used;
  const available = await getVideoModelAccess();
  const settings = normalizeRecommendationSettings(body.recommendationSettings ?? body);
  const recommendation = recommendVideoModel({ prompt: ask, settings, available, pinned });
  if (!recommendation) {
    return NextResponse.json({ error: "video_model_unavailable", message: "No supported video model is available right now. Please try again shortly.", available }, { status: 503 });
  }
  if (!matchesVideoRecommendation(body, recommendation)) {
    return NextResponse.json({ error: "recommendation_changed", message: "Your video recommendation or price changed. Review the updated shot before generating.", recommendation, available }, { status: 409 });
  }

  // Authorize before planning. `planClip` is a real Anthropic call, so running
  // it ahead of the entitlement check meant every denied request still cost us
  // a generation, and the rate limiter allows 40 an hour per account.
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
      return NextResponse.json({ error: "recommendation_changed", message: "Your plan changed. Refresh your recommendation before generating.", recommendation: recommendVideoModel({ prompt: ask, settings, available, pinned: freeShot }), available }, { status: 409 });
    }
    if (!freeShot) {
      cost = recommendation.cost;
      const ok = await spendCredits(user.id, cost, "video_generation", project.id);
      if (!ok) return NextResponse.json({ error: "insufficient_credits", cost }, { status: 402 });
    }
  }

  // Undoes whichever form the charge took. Planning now happens *after* the
  // charge, so a plan that fails has to hand it back.
  const undoCharge = async () => {
    if (freeShot) await releaseFree(user.id, "video");
    else if (!isAdmin && cost > 0) {
      await grantCredits(user.id, cost, "refund", project.id).catch(() => {});
    }
  };

  let plan;
  try {
    plan = await planClip({
      name: project.name ?? "",
      industry: project.industry ?? "",
      siteBrief: project.site_brief ?? "",
      existing: clips
        .filter((c) => c.prompt)
        .map((c) => ({ label: c.label, prompt: c.prompt ?? "", mode: c.mode })),
      request: ask,
    });
  } catch {
    plan = null;
  }
  if (!plan) {
    await undoCharge();
    return NextResponse.json(
      { error: "Could not work out that shot. Try describing it a different way." },
      { status: 502 }
    );
  }

  const { model, resolution, duration, ratio } = recommendation;

  try {
    const { taskId } = await createVideoTask({
      prompt: plan.prompt,
      resolution,
      duration,
      ratio,
      model,
    });

    const admin = createSupabaseAdmin();
    const { data: video, error } = await admin
      .from("project_videos")
      .insert({
        project_id: project.id,
        user_id: user.id,
        position: clips.length,
        label: plan.label,
        prompt: plan.prompt,
        mode: plan.mode,
        status: "queued",
        task_id: taskId,
        settings: {
          resolution,
          duration,
          ratio,
          cost,
          free: freeShot,
          model,
        },
      })
      .select(VIDEO_COLUMNS)
      .single();

    if (error || !video) throw new Error(error?.message ?? "Could not save the clip");

    await admin.from("messages").insert([
      { project_id: project.id, user_id: user.id, role: "user", target: "video", content: ask },
      {
        project_id: project.id,
        user_id: user.id,
        role: "assistant",
        target: "video",
        content: plan.reply,
      },
    ]);

    return NextResponse.json({ video, reply: plan.reply, cost, recommendation });
  } catch (err) {
    // Nothing was queued, give the credits back.
    await undoCharge();
    const message = err instanceof Error ? err.message : "Video generation failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
