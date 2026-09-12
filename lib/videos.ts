import type { SupabaseClient } from "@supabase/supabase-js";
import type { SiteVideo } from "./claude";

// A production can feature several clips (project_videos). The first one,
// position 0, is the hero, and is mirrored back onto projects.video_* so the
// single-video paths (export, showcase, older rows) keep working.

export type VideoStatus = "none" | "queued" | "running" | "succeeded" | "failed";

export interface PendingVideoUpload {
  path: string;
  filename: string;
  contentType: string;
  size: number;
  expiresAt: string;
  processing?: boolean;
}

export interface VideoRow {
  id: string;
  project_id: string;
  position: number;
  label: string;
  prompt: string | null;
  mode: "loop" | "scrub";
  status: VideoStatus;
  task_id: string | null;
  url: string | null;
  settings: {
    model?: string;
    resolution?: string;
    duration?: number;
    ratio?: string;
    cost?: number;
    free?: boolean;
    source?: "upload";
    originalName?: string;
    originalSize?: number;
    uploadedAt?: string;
    uploadPending?: PendingVideoUpload;
  } | null;
}

export const VIDEO_COLUMNS =
  "id, project_id, position, label, prompt, mode, status, task_id, url, settings";

export const MAX_VIDEOS_PER_PROJECT = 6;

/** Every clip of a project, hero first. */
export async function listVideos(
  supabase: SupabaseClient,
  projectId: string
): Promise<VideoRow[]> {
  const { data } = await supabase
    .from("project_videos")
    .select(VIDEO_COLUMNS)
    .eq("project_id", projectId)
    .order("position", { ascending: true });
  return (data as VideoRow[] | null) ?? [];
}

/** Only the clips that finished rendering, what the site can actually embed. */
export function readyVideos(rows: VideoRow[]): SiteVideo[] {
  return rows
    .filter((v): v is VideoRow & { url: string } => v.status === "succeeded" && Boolean(v.url))
    .map((v) => ({
      label: v.label || "Video",
      prompt: v.prompt ?? "",
      url: v.url,
      mode: v.mode === "scrub" ? "scrub" : "loop",
    }));
}

/**
 * Copies the hero clip onto the project's legacy video_* columns. Called after
 * any change to a project's clips so single-video consumers stay correct.
 */
export async function syncPrimaryVideo(admin: SupabaseClient, projectId: string): Promise<void> {
  const rows = await listVideos(admin, projectId);
  const hero = rows[0];
  await admin
    .from("projects")
    .update({
      video_brief: hero?.prompt ?? null,
      video_mode: hero?.mode ?? "loop",
      video_status: hero?.status ?? "none",
      video_task_id: hero?.task_id ?? null,
      video_url: hero?.url ?? null,
      video_settings: hero?.settings ?? {},
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId);
}
