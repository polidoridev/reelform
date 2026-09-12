import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { grantCredits } from "@/lib/credits";
import { getVideoTask } from "@/lib/higgsfield";
import { storeVideo } from "@/lib/storage";
import { syncPrimaryVideo } from "@/lib/videos";
import { releaseFree } from "@/lib/entitlements";

// storeVideo spawns ffmpeg (all-intra re-encode) and reads the filesystem, so
// this handler must run on the Node runtime, not edge, with room to encode.
export const runtime = "nodejs";
export const maxDuration = 60;

// GET /api/video/status?videoId=... polls the Higgsfield request for one clip
// and persists the outcome.
export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const videoId = request.nextUrl.searchParams.get("videoId");
  if (!videoId) return NextResponse.json({ error: "Missing videoId" }, { status: 400 });

  const { data: video } = await supabase
    .from("project_videos")
    .select("id, project_id, position, task_id, status, url, settings")
    .eq("id", videoId)
    .eq("user_id", user.id)
    .single();
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  // Already settled, nothing to poll.
  if (video.status === "succeeded" || video.status === "failed" || !video.task_id) {
    return NextResponse.json({ videoId, status: video.status, videoUrl: video.url });
  }

  const task = await getVideoTask(video.task_id);
  const admin = createSupabaseAdmin();
  const currentStatus = async () => {
    const { data: current } = await supabase.from("project_videos").select("status, url").eq("id", video.id).maybeSingle();
    return NextResponse.json({ videoId, status: current?.status ?? video.status, videoUrl: current?.url ?? video.url });
  };

  if (task.status === "succeeded") {
    // Re-host in our own storage, provider CDN URLs can expire.
    const permanentUrl = task.videoUrl ? await storeVideo(admin, video.project_id, task.videoUrl) : null;
    const videoUrl = permanentUrl ?? task.videoUrl;
    const { data: settled } = await admin
      .from("project_videos")
      .update({ status: "succeeded", url: videoUrl, updated_at: new Date().toISOString() })
      .eq("id", video.id).eq("task_id", video.task_id).in("status", ["queued", "running"])
      .select("id").maybeSingle();
    if (!settled) {
      return currentStatus();
    }
    if (video.position === 0) await syncPrimaryVideo(admin, video.project_id);
    return NextResponse.json({ videoId, status: "succeeded", videoUrl });
  }

  if (task.status === "failed") {
    // The refund must fire exactly once. The studio polls every clip on an
    // interval, so two in-flight polls (a second tab, or a slow storeVideo
    // overlapping the next tick) can both get here having read a non-failed
    // status. Guarding the UPDATE with the active task and status makes the
    // transition itself the lock: under READ COMMITTED the loser re-checks the
    // predicate after the winner commits and matches zero rows, so only the
    // request that actually flipped the row pays out.
    const { data: transitioned } = await admin
      .from("project_videos")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", video.id)
      .eq("task_id", video.task_id)
      .in("status", ["queued", "running"])
      .select("id");

    if (!transitioned?.length) return currentStatus();

    if (video.position === 0) await syncPrimaryVideo(admin, video.project_id);

    if (transitioned && transitioned.length > 0) {
      // A shot the provider failed to render shouldn't burn the one free one.
      const settings = (video.settings ?? {}) as { cost?: number; free?: boolean };
      if (settings.free) await releaseFree(user.id, "video");
      else if ((settings.cost ?? 0) > 0) {
        await grantCredits(user.id, settings.cost ?? 0, "refund", video.project_id);
      }
    }
    return NextResponse.json({ videoId, status: "failed", error: task.error });
  }

  if (video.status !== task.status) {
    const { data: transitioned } = await admin.from("project_videos")
      .update({ status: task.status, updated_at: new Date().toISOString() })
      .eq("id", video.id).eq("task_id", video.task_id).in("status", ["queued", "running"])
      .select("id").maybeSingle();
    if (!transitioned) return currentStatus();
    if (video.position === 0) await syncPrimaryVideo(admin, video.project_id);
  }
  return currentStatus();
}
