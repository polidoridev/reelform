/** Shared by the picker and upload API; no server dependencies. */
export const VIDEO_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const VIDEO_UPLOAD_MAX_SECONDS = 60;
export const VIDEO_UPLOAD_ACCEPT = ".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm";
export const VIDEO_UPLOAD_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

type UploadFile = { name: string; type: string; size: number };

/** Some browsers leave File.type blank, especially for QuickTime footage. */
export function getVideoUploadContentType(file: Pick<UploadFile, "name" | "type">): string | null {
  const type = file.type.toLowerCase().split(";")[0].trim();
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (type) return Object.hasOwn(VIDEO_UPLOAD_TYPES, type) ? type : null;
  return Object.entries(VIDEO_UPLOAD_TYPES).find(([, ext]) => ext === extension)?.[0] ?? null;
}

export function validateVideoUpload(file: UploadFile): string | null {
  if (!file.name.trim() || !getVideoUploadContentType(file)) {
    return "Choose an MP4, MOV, or WebM video.";
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return "That video is empty or could not be read.";
  }
  if (file.size > VIDEO_UPLOAD_MAX_BYTES) {
    return "Choose a video under 50 MB.";
  }
  return null;
}
