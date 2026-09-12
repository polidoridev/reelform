"use client";

import { useEffect, useId, useRef, useState } from "react";
import { VIDEO_UPLOAD_ACCEPT, VIDEO_UPLOAD_MAX_SECONDS, validateVideoUpload } from "@/lib/video-upload";

// Check duration when this browser can decode the source. MOV codecs vary;
// unsupported previews still go through the server's authoritative validation.
async function checkDuration(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  try {
    return await new Promise((resolve) => {
      const finish = (error: string | null) => {
        clearTimeout(timer);
        video.onloadedmetadata = null;
        video.onerror = null;
        resolve(error);
      };
      const timer = setTimeout(() => finish(null), 5000);
      video.preload = "metadata";
      video.onloadedmetadata = () => finish(
        Number.isFinite(video.duration) && video.duration > VIDEO_UPLOAD_MAX_SECONDS
          ? `Choose a clip no longer than ${VIDEO_UPLOAD_MAX_SECONDS} seconds. Trim your footage and try again.`
          : null
      );
      video.onerror = () => finish(null);
      video.src = url;
    });
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

function LocalPreview({ file }: { file: File }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const video = videoRef.current;
    if (video) video.src = url;
    return () => {
      if (video) {
        video.removeAttribute("src");
        video.load();
      }
      URL.revokeObjectURL(url);
    };
  }, [file]);

  return (
    <div className="mt-4">
      <video
        ref={videoRef}
        controls
        muted
        playsInline
        preload="metadata"
        aria-label="Preview of your footage"
        onError={() => setUnavailable(true)}
        onLoadedMetadata={() => setUnavailable(false)}
        className={`aspect-video w-full rounded-lg bg-black object-contain ${unavailable ? "hidden" : ""}`}
      />
      {unavailable && <p className="text-xs text-muted">Your browser cannot preview this format. We&apos;ll convert it when you upload.</p>}
    </div>
  );
}

/** File selection is local; callers decide when to upload and save it. */
export default function FootageUpload({
  onSelect,
  disabled = false,
  busy = false,
  progress = null,
  file = null,
}: {
  onSelect: (file: File) => void;
  disabled?: boolean;
  busy?: boolean;
  progress?: number | null;
  file?: File | null;
}) {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [checking, setChecking] = useState(false);
  const selection = useRef(0);
  useEffect(() => () => { selection.current += 1; }, []);

  async function select(files: FileList | null) {
    if (disabled || busy || checking || !files?.length) return;
    if (files.length > 1) {
      setError("Choose one clip at a time. You can add more clips in the studio.");
      return;
    }
    const selected = files[0];
    const invalid = validateVideoUpload(selected);
    setError(invalid);
    if (invalid) return;
    const current = ++selection.current;
    setChecking(true);
    const durationError = await checkDuration(selected);
    if (current !== selection.current) return;
    setChecking(false);
    setError(durationError);
    if (!durationError) onSelect(selected);
  }

  return (
    <div aria-busy={busy || checking}>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled && !busy && !checking) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          select(event.dataTransfer.files);
        }}
        className={`rounded-xl border border-dashed p-5 transition-colors ${dragging ? "border-primary bg-primary-soft/30" : "border-line bg-bg-raise/30"}`}
      >
        <label htmlFor={inputId} className="block text-sm font-medium">{file ? "Choose different footage" : "Choose your footage or drop it here"}</label>
        <p id={`${inputId}-help`} className="mt-1 text-xs leading-relaxed text-muted">
          MP4, MOV or WebM · up to 50 MB · {VIDEO_UPLOAD_MAX_SECONDS} seconds max. No video generation credits.
        </p>
        <input
          id={inputId}
          type="file"
          accept={VIDEO_UPLOAD_ACCEPT}
          disabled={disabled || busy || checking}
          aria-describedby={`${inputId}-help`}
          className="mt-4 block w-full min-w-0 text-sm text-muted file:mr-3 file:rounded-full file:border-0 file:bg-primary-soft file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-deep disabled:opacity-50"
          onChange={(event) => {
            select(event.target.files);
            event.target.value = "";
          }}
        />
        {file && <p className="mt-3 break-all text-xs text-muted">Selected: {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {checking && <p role="status" className="mt-3 text-sm text-muted">Checking your footage…</p>}
      {file && <LocalPreview key={`${file.name}-${file.lastModified}-${file.size}`} file={file} />}
      {busy && <p role="status" className="mt-3 text-sm text-muted">{progress === 100 ? "Preparing your footage for smooth playback…" : "Uploading your footage…"} Keep this tab open.</p>}
    </div>
  );
}
