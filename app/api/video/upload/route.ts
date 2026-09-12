import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  ensureVideoUploadBucket,
  normalizeUploadedVideo,
  removeStoredVideo,
  storeUploadedVideo,
  VIDEO_UPLOAD_BUCKET,
  VideoUploadError,
} from "@/lib/storage";
import {
  getVideoUploadContentType,
  validateVideoUpload,
  VIDEO_UPLOAD_MAX_BYTES,
  VIDEO_UPLOAD_TYPES,
} from "@/lib/video-upload";
import { syncPrimaryVideo, VIDEO_COLUMNS, type PendingVideoUpload, type VideoRow } from "@/lib/videos";

export const runtime = "nodejs";
export const maxDuration = 120;

type Snapshot = VideoRow & { updated_at: string };
type Admin = ReturnType<typeof createSupabaseAdmin>;

function revision(video: Snapshot) {
  return new Date(Math.max(Date.now(), Date.parse(video.updated_at) + 1)).toISOString();
}

async function context(request: NextRequest) {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { response: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  const body = await request.json().catch(() => null);
  if (!body || typeof body.videoId !== "string") {
    return { response: NextResponse.json({ error: "Missing video" }, { status: 400 }) };
  }
  const { data } = await supabase.from("project_videos")
    .select(`${VIDEO_COLUMNS}, updated_at`).eq("id", body.videoId).eq("user_id", user.id).maybeSingle();
  if (!data) return { response: NextResponse.json({ error: "Video not found" }, { status: 404 }) };
  const { data: project } = await supabase.from("projects").select("id")
    .eq("id", data.project_id).eq("user_id", user.id).maybeSingle();
  if (!project) return { response: NextResponse.json({ error: "Project not found" }, { status: 404 }) };
  return { user, body, video: data as Snapshot };
}

function conflict() {
  return NextResponse.json({ error: "This video changed while you were uploading. Try uploading it again." }, { status: 409 });
}

async function removeIncoming(admin: Admin, path: string) {
  const { error } = await admin.storage.from(VIDEO_UPLOAD_BUCKET).remove([path]);
  if (error) console.error("[video-upload] Could not remove incoming footage", error.message);
}

async function removeExpiredIncoming(admin: Admin, userId: string, video: Snapshot) {
  const prefix = `${userId}/${video.project_id}/${video.id}`;
  const { data } = await admin.storage.from(VIDEO_UPLOAD_BUCKET)
    .list(prefix, { limit: 100, sortBy: { column: "created_at", order: "asc" } });
  // Supabase upload signatures expire after two hours. Waiting until then
  // means a canceled signature cannot recreate a file just after cleanup.
  const stale = (data ?? []).filter((file) => file.id && file.created_at && Date.parse(file.created_at) < Date.now() - 2 * 60 * 60 * 1000)
    .map((file) => `${prefix}/${file.name}`);
  if (stale.length) await admin.storage.from(VIDEO_UPLOAD_BUCKET).remove(stale);
}

function matchesPending(video: Snapshot, userId: string, path: unknown): path is string {
  // Never download/delete a client-chosen arbitrary storage path, even via admin.
  return typeof path === "string"
    && path === video.settings?.uploadPending?.path
    && path.startsWith(`${userId}/${video.project_id}/${video.id}/`)
    && /^[a-zA-Z0-9/-]+\.(mp4|mov|webm)$/.test(path);
}

async function clearReservation(admin: Admin, userId: string, video: Snapshot, path: string) {
  const settings = { ...video.settings };
  delete settings.uploadPending;
  await admin.from("project_videos")
    .update({ settings, updated_at: revision(video) })
    .eq("id", video.id).eq("user_id", userId).eq("updated_at", video.updated_at)
    .eq("settings->uploadPending->>path", path);
}

// The browser sends the bytes directly to private Storage, avoiding serverless
// request body limits. Existing clips stay playable throughout the upload.
export async function POST(request: NextRequest) {
  const ctx = await context(request);
  if (ctx.response) return ctx.response;
  const { user, body, video } = ctx;
  if (video.status === "queued" || video.status === "running") {
    return NextResponse.json({ error: "Wait for this video to finish rendering before replacing it." }, { status: 409 });
  }
  const limited = await enforceRateLimit(user.id, "video_upload");
  if (limited) return limited;
  if (typeof body.filename !== "string" || typeof body.contentType !== "string" || typeof body.size !== "number") {
    return NextResponse.json({ error: "Missing video file details" }, { status: 400 });
  }
  const file = { name: body.filename, type: body.contentType, size: body.size };
  const invalid = validateVideoUpload(file);
  if (invalid) return NextResponse.json({ error: invalid }, { status: body.size > VIDEO_UPLOAD_MAX_BYTES ? 413 : 400 });

  const contentType = getVideoUploadContentType(file)!;
  const filename = body.filename.replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop()!.slice(0, 255);
  const path = `${user.id}/${video.project_id}/${video.id}/${randomUUID()}.${VIDEO_UPLOAD_TYPES[contentType]}`;
  const admin = createSupabaseAdmin();
  try {
    await ensureVideoUploadBucket(admin);
    await removeExpiredIncoming(admin, user.id, video);
    const { data, error } = await admin.storage.from(VIDEO_UPLOAD_BUCKET).createSignedUploadUrl(path, { upsert: false });
    if (error || !data) throw error ?? new Error("Could not create upload");
    const pending: PendingVideoUpload = {
      path, filename, contentType, size: body.size,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
    const { data: reserved, error: reserveError } = await admin.from("project_videos")
      .update({ settings: { ...video.settings, uploadPending: pending }, updated_at: revision(video) })
      .eq("id", video.id).eq("user_id", user.id).eq("updated_at", video.updated_at)
      .eq("status", video.status).select("id").maybeSingle();
    if (reserveError) throw reserveError;
    if (!reserved) return conflict();
    if (video.settings?.uploadPending && matchesPending(video, user.id, video.settings.uploadPending.path)) {
      await removeIncoming(admin, video.settings.uploadPending.path);
    }
    return NextResponse.json({ bucket: VIDEO_UPLOAD_BUCKET, path: data.path, token: data.token, contentType });
  } catch (err) {
    console.error("[video-upload] Could not prepare upload", err);
    return NextResponse.json({ error: "Could not start the upload. Please try again." }, { status: 502 });
  }
}

// Only a verified, normalized MP4 is made public and attached to the clip slot.
// Uploads intentionally never call entitlement, free-shot, or credit functions.
export async function PATCH(request: NextRequest) {
  const ctx = await context(request);
  if (ctx.response) return ctx.response;
  const { user, body, video } = ctx;
  if (!matchesPending(video, user.id, body.path)) return conflict();
  const path = body.path;
  const pending = video.settings!.uploadPending!;
  const admin = createSupabaseAdmin();
  if (Date.parse(pending.expiresAt) <= Date.now()) {
    await clearReservation(admin, user.id, video, path);
    await removeIncoming(admin, path);
    return NextResponse.json({ error: "This upload expired. Please upload the video again." }, { status: 410 });
  }
  if (pending.processing || video.status === "queued" || video.status === "running") return conflict();
  const limited = await enforceRateLimit(user.id, "video_upload_finalize");
  if (limited) return limited;
  const { data: claimed, error: claimError } = await admin.from("project_videos")
    .update({ settings: { ...video.settings, uploadPending: { ...pending, processing: true } }, updated_at: revision(video) })
    .eq("id", video.id).eq("user_id", user.id).eq("updated_at", video.updated_at).eq("status", video.status)
    .select(`${VIDEO_COLUMNS}, updated_at`).maybeSingle();
  if (claimError) return NextResponse.json({ error: "Could not import the video. Please try again." }, { status: 502 });
  if (!claimed) return conflict();
  const snapshot = claimed as Snapshot;
  let outputPath: string | undefined;
  let saved = false;
  try {
    const bucket = admin.storage.from(VIDEO_UPLOAD_BUCKET);
    const { data: metadata, error: infoError } = await bucket.info(path);
    if (infoError || !metadata) throw new VideoUploadError("The upload did not finish. Please upload the video again.");
    if (!Number.isSafeInteger(metadata.size) || metadata.size! <= 0 || metadata.size! > VIDEO_UPLOAD_MAX_BYTES || metadata.size !== pending.size) {
      throw new VideoUploadError("The uploaded file size does not match. Please upload the video again (up to 50 MB).");
    }
    if (metadata.contentType !== pending.contentType || !Object.hasOwn(VIDEO_UPLOAD_TYPES, metadata.contentType)) {
      throw new VideoUploadError("Choose an MP4, MOV, or WebM video.");
    }
    const { data: blob, error: downloadError } = await bucket.download(path);
    if (downloadError || !blob) throw new Error("Could not read the uploaded video. Please try again.");
    if (blob.size !== pending.size || blob.size > VIDEO_UPLOAD_MAX_BYTES) throw new VideoUploadError("The uploaded video is too large or incomplete.");
    const normalized = await normalizeUploadedVideo(Buffer.from(await blob.arrayBuffer()));
    const output = await storeUploadedVideo(admin, video.project_id, video.id, normalized.bytes);
    outputPath = output.path;
    const { data: updated, error: updateError } = await admin.from("project_videos")
      .update({
        status: "succeeded", task_id: null, prompt: null, url: output.url,
        settings: {
          source: "upload", originalName: pending.filename, originalSize: pending.size,
          duration: normalized.duration, uploadedAt: new Date().toISOString(), cost: 0,
        },
        updated_at: revision(snapshot),
      })
      .eq("id", video.id).eq("user_id", user.id).eq("updated_at", snapshot.updated_at)
      .eq("settings->uploadPending->>path", path).eq("status", snapshot.status)
      .select(VIDEO_COLUMNS).maybeSingle();
    if (updateError) throw new Error("Could not attach the video. Please try again.");
    if (!updated) return conflict();
    saved = true;
    await syncPrimaryVideo(admin, video.project_id);
    return NextResponse.json({ video: updated });
  } catch (err) {
    console.error("[video-upload] Import failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not import this video." }, { status: err instanceof VideoUploadError ? 400 : 502 });
  } finally {
    await removeIncoming(admin, path);
    if (!saved) {
      await clearReservation(admin, user.id, snapshot, path);
      if (outputPath) await removeStoredVideo(admin, outputPath);
    }
  }
}

/** Cancel a failed/interrupted browser transfer without touching its old clip. */
export async function DELETE(request: NextRequest) {
  const ctx = await context(request);
  if (ctx.response) return ctx.response;
  const { user, body, video } = ctx;
  if (!matchesPending(video, user.id, body.path)) return conflict();
  const admin = createSupabaseAdmin();
  await clearReservation(admin, user.id, video, body.path);
  await removeIncoming(admin, body.path);
  return NextResponse.json({ ok: true });
}
