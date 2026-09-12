"use client";

import { createSupabaseBrowser } from "./supabase/client";
import { validateVideoUpload } from "./video-upload";
import type { VideoRow } from "./videos";

/** Upload directly to Storage, then validate and prepare the clip on the server. */
export async function uploadFootage(
  videoId: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<VideoRow> {
  const invalid = validateVideoUpload(file);
  if (invalid) throw new Error(invalid);
  onProgress?.(0);

  const start = await fetch("/api/video/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, filename: file.name, contentType: file.type, size: file.size }),
  });
  const upload = await start.json().catch(() => ({}));
  if (!start.ok || !upload.path || !upload.token || !upload.bucket) {
    throw new Error(upload.error ?? "Could not start the upload. Please try again.");
  }

  try {
    // Blob MIME is used by the SDK's multipart body, even when contentType is
    // passed as an option. Normalize it for cameras/browsers that omit it.
    const body = file.slice(0, file.size, upload.contentType || file.type);
    const { error } = await createSupabaseBrowser().storage
      .from(upload.bucket)
      .uploadToSignedUrl(upload.path, upload.token, body);
    if (error) throw new Error("The footage could not be uploaded. Check your connection and try again.");
    onProgress?.(100);

    const finish = await fetch("/api/video/upload", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId, path: upload.path, filename: file.name }),
    });
    const result = await finish.json().catch(() => ({}));
    if (!finish.ok || !result.video) {
      throw new Error(result.error ?? "Could not prepare the footage. Please try again.");
    }
    return result.video as VideoRow;
  } catch (error) {
    // Best effort: release a failed reservation so retrying does not leave a
    // clip locked until its signed upload expires.
    await fetch("/api/video/upload", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId, path: upload.path }),
    }).catch(() => {});
    throw error;
  }
}
