import type { SupabaseClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { VIDEO_UPLOAD_MAX_BYTES, VIDEO_UPLOAD_MAX_SECONDS, VIDEO_UPLOAD_TYPES } from "./video-upload";
import { randomUUID } from "node:crypto";

const BUCKET = "videos";
export const VIDEO_UPLOAD_BUCKET = "video-uploads";

export class VideoUploadError extends Error {}

/** Signed uploads never land in the public bucket before validation. */
export async function ensureVideoUploadBucket(admin: SupabaseClient): Promise<void> {
  const options = {
    public: false,
    fileSizeLimit: VIDEO_UPLOAD_MAX_BYTES,
    allowedMimeTypes: Object.keys(VIDEO_UPLOAD_TYPES),
  };
  const { data } = await admin.storage.getBucket(VIDEO_UPLOAD_BUCKET);
  if (!data) {
    const { error } = await admin.storage.createBucket(VIDEO_UPLOAD_BUCKET, options);
    if (!error) return;
    if (!/already exists|duplicate/i.test(error.message)) throw error;
  }
  // Enforce limits even if the bucket was previously created with defaults.
  const { error } = await admin.storage.updateBucket(VIDEO_UPLOAD_BUCKET, options);
  if (error) throw error;
}

/** A strict encode for user footage; unlike provider copies there is no raw fallback. */
export async function normalizeUploadedVideo(
  input: Buffer
): Promise<{ bytes: Buffer; duration: number }> {
  if (!ffmpegPath) throw new Error("Video processing is unavailable. Please try again later.");
  if (!input.length || input.length > VIDEO_UPLOAD_MAX_BYTES) {
    throw new VideoUploadError("Choose a video under 50 MB.");
  }
  const atom = input.subarray(4, 8).toString("ascii");
  const isQuickTime = ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(atom);
  const isWebM = input.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!isQuickTime && !isWebM) {
    throw new VideoUploadError("That file is not a readable MP4, MOV, or WebM video.");
  }

  const dir = await mkdtemp(join(tmpdir(), "reelform-upload-"));
  try {
    const inPath = join(dir, "input");
    const outPath = join(dir, "output.mp4");
    await writeFile(inPath, input);
    let diagnostic = "";
    let progress = "";
    let timedOut = false;
    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn(ffmpegPath as string, [
        "-hide_banner", "-nostdin", "-y", "-xerror",
        // Reject playlists and network references in disguised media files.
        "-protocol_whitelist", "file,pipe", "-err_detect", "explode",
        ...(isQuickTime ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
        "-threads", "2", "-i", inPath,
        "-map", "0:v:0", "-an", "-sn", "-dn",
        // Decode just beyond the limit to also catch WebM without duration metadata.
        "-t", String(VIDEO_UPLOAD_MAX_SECONDS + 0.25),
        "-vf", "fps=24,scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        "-c:v", "libx264", "-threads", "2", "-profile:v", "high", "-level", "4.0",
        "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        // Members can switch any clip from looping to scrubbing later.
        "-g", "1", "-keyint_min", "1",
        "-x264-params", "keyint=1:min-keyint=1:scenecut=0",
        "-movflags", "+faststart", "-map_metadata", "-1",
        "-fs", String(VIDEO_UPLOAD_MAX_BYTES + 1),
        "-progress", "pipe:1", outPath,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      const timeout = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, 90_000);
      proc.stdout.on("data", (chunk: Buffer) => { progress = (progress + chunk.toString()).slice(-32_000); });
      proc.stderr.on("data", (chunk: Buffer) => {
        // Keep the input header (duration), and bound malformed-file diagnostics.
        if (diagnostic.length < 32_000) diagnostic += chunk.toString();
        const duration = diagnostic.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (duration && Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) > VIDEO_UPLOAD_MAX_SECONDS) {
          proc.kill("SIGKILL");
        }
      });
      proc.on("error", (error) => { console.error("[video-upload] Could not run ffmpeg", error.message); clearTimeout(timeout); resolve(false); });
      proc.on("close", (code) => { clearTimeout(timeout); resolve(code === 0); });
    });

    const durationMatch = diagnostic.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    const declaredDuration = durationMatch
      ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
      : 0;
    const times = [...progress.matchAll(/out_time_us=(\d+)/g)].map((match) => Number(match[1]) / 1_000_000);
    const decodedDuration = Math.max(0, ...times);
    if (declaredDuration > VIDEO_UPLOAD_MAX_SECONDS || decodedDuration > VIDEO_UPLOAD_MAX_SECONDS) {
      throw new VideoUploadError("Choose a video that is 60 seconds or shorter.");
    }
    if (timedOut) throw new VideoUploadError("That video took too long to process. Try a shorter or smaller clip.");
    if (!ok || decodedDuration <= 0) {
      throw new VideoUploadError("That video could not be processed. Try exporting it as MP4 and uploading again.");
    }
    const bytes = await readFile(outPath);
    if (!bytes.length || bytes.length > VIDEO_UPLOAD_MAX_BYTES) {
      throw new VideoUploadError("The processed video is too large. Try a shorter clip.");
    }
    return { bytes, duration: declaredDuration || decodedDuration };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function storeUploadedVideo(
  admin: SupabaseClient,
  projectId: string,
  videoId: string,
  bytes: Buffer
): Promise<{ path: string; url: string }> {
  const path = `${projectId}/${videoId}-${randomUUID()}.mp4`;
  let { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: "video/mp4", upsert: false });
  if (error && /not.*found|does not exist/i.test(error.message)) {
    await admin.storage.createBucket(BUCKET, { public: true });
    ({ error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: "video/mp4", upsert: false }));
  }
  if (error) throw new Error("Could not save the processed video. Please try again.");
  return { path, url: admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl };
}

export async function removeStoredVideo(admin: SupabaseClient, path: string): Promise<void> {
  const { error } = await admin.storage.from(BUCKET).remove([path]);
  if (error) console.error("[video-upload] Could not remove unused output", error.message);
}

/** Runs ffmpeg over `input` and returns the output bytes, or null on failure. */
async function transcode(input: Buffer, args: (inPath: string, outPath: string) => string[]) {
  if (!ffmpegPath) return null;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "reelform-"));
    const inPath = join(dir, "in.mp4");
    const outPath = join(dir, "out.mp4");
    await writeFile(inPath, input);

    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn(ffmpegPath as string, args(inPath, outPath), { stdio: "ignore" });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    });
    if (!ok) return null;

    return await readFile(outPath);
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Re-encodes a hero video so every frame is a keyframe (all-intra). Scroll-scrub
// playback drives the video via currentTime; on a normal MP4 (keyframes ~1-2s
// apart) the browser must decode from the nearest keyframe on every seek, so
// mid-keyframe frames are slow and scrubbing stutters. An all-intra clip makes
// every frame instantly seekable → smooth frame-by-frame scrubbing.
// Returns null on any failure so callers fall back to the original bytes.
function reencodeAllIntra(input: Buffer): Promise<Buffer | null> {
  return transcode(input, (inPath, outPath) => [
    "-y",
    "-i", inPath,
    "-an", // scrub videos are muted; drop audio
    // Keyframe-per-frame is expensive in bytes: a 1080p source encodes to
    // roughly 20 Mbit/s, which is a hero video a phone will never finish
    // downloading. 720p is the ceiling the hero actually renders at anyway,
    // and it lands around a third of the size. Sources already smaller are
    // left alone rather than upscaled.
    "-vf", "scale='min(1280,iw)':-2:flags=lanczos",
    "-c:v", "libx264",
    // baseline/main-only decoders are long gone, but the level cap keeps the
    // stream inside what older mobile hardware decoders will accept.
    "-profile:v", "high",
    "-level", "4.0",
    "-preset", "veryfast",
    "-crf", "23",
    // keyframe on every frame + no scene-cut keyframe shuffling
    "-g", "1",
    "-keyint_min", "1",
    "-x264-params", "keyint=1:min-keyint=1:scenecut=0",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outPath,
  ]);
}

// Moves the MP4 index (the `moov` atom) to the front without touching a single
// frame. Providers commonly write it last, and a browser can't render anything
// until it has read the index: on a phone that means staring at a black box
// while the entire file downloads. This is the floor we guarantee when the
// all-intra re-encode above isn't available.
function remuxFaststart(input: Buffer): Promise<Buffer | null> {
  return transcode(input, (inPath, outPath) => [
    "-y",
    "-i", inPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outPath,
  ]);
}

// Copies a provider-hosted video into our own Supabase Storage and returns a
// permanent public URL. Provider CDN links (Higgsfield included) expire,
// a site shipped with an expiring URL would silently lose its hero video.
// Returns null on any failure so callers can fall back to the provider URL.
export async function storeVideo(
  admin: SupabaseClient,
  projectId: string,
  sourceUrl: string
): Promise<string | null> {
  try {
    const res = await fetch(sourceUrl);
    if (!res.ok) return null;
    const original = Buffer.from(await res.arrayBuffer());
    // Re-encode for smooth scrubbing. If that fails, still make sure the file
    // starts playing before it finishes downloading; only if even the remux
    // fails do we ship the provider's bytes untouched.
    const bytes =
      (await reencodeAllIntra(original)) ?? (await remuxFaststart(original)) ?? original;
    const path = `${projectId}/${Date.now()}.mp4`;

    let { error } = await admin.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: "video/mp4", upsert: true });

    // First run on a fresh project: create the public bucket, then retry once.
    if (error && /not.*found|does not exist/i.test(error.message)) {
      await admin.storage.createBucket(BUCKET, { public: true });
      ({ error } = await admin.storage
        .from(BUCKET)
        .upload(path, bytes, { contentType: "video/mp4", upsert: true }));
    }
    if (error) return null;

    const { data } = admin.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl ?? null;
  } catch {
    return null;
  }
}
