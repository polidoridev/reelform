"use client";

import { useState } from "react";
import { VIDEO_TEMPLATES } from "@/lib/templates";
import { ShotControls, type ShotSettings } from "@/components/ShotControls";
import { VIDEO_MODELS, resolveShot } from "@/lib/higgsfield";
import { videoCost } from "@/lib/pricing";
import type { VideoRow } from "@/lib/videos";
import FootageUpload from "@/components/FootageUpload";

export type { Ratio } from "@/lib/higgsfield";

export interface ClipDraft extends ShotSettings {
  prompt: string;
}

const chipCls =
  "rounded-full border border-line-strong px-3 py-1.5 text-xs font-medium text-muted hover:border-primary hover:text-primary transition-colors cursor-pointer";

// One video slot in a production: name it, say how it should play, direct the
// shot, and review the footage once it lands.
export function ClipCard({
  clip,
  index,
  draft,
  onDraftChange,
  onRename,
  onModeChange,
  onGenerate,
  onUpload,
  onSuggest,
  onRemove,
  suggesting,
  busy,
  uploading,
  uploadProgress,
  removable,
  costLabel,
  isAdmin = false,
  pinnedShot = false,
}: {
  clip: VideoRow;
  index: number;
  draft: ClipDraft;
  onDraftChange: (patch: Partial<ClipDraft>) => void;
  onRename: (label: string) => void;
  onModeChange: (mode: "loop" | "scrub") => void;
  onGenerate: () => void;
  onUpload: (file: File) => Promise<boolean>;
  onSuggest: () => void;
  onRemove: () => void;
  suggesting: boolean;
  busy: boolean;
  uploading: boolean;
  uploadProgress: number | null;
  removable: boolean;
  costLabel: (n: number) => string;
  isAdmin?: boolean;
  /** The free hero shot runs on a fixed preset; see ShotControls. */
  pinnedShot?: boolean;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [reshooting, setReshooting] = useState(false);
  const [labelDraft, setLabelDraft] = useState(clip.label);
  const [source, setSource] = useState<"upload" | "ai">("upload");
  const [file, setFile] = useState<File | null>(null);

  const rendering = clip.status === "queued" || clip.status === "running";
  const ready = clip.status === "succeeded" && Boolean(clip.url);
  const uploaded = clip.settings?.source === "upload";
  const showControls = !ready || reshooting;
  const model = VIDEO_MODELS.find((m) => m.id === draft.model);
  const shot = resolveShot(draft.model, draft);
  const cost = videoCost(draft.model, shot.resolution ?? "720p", shot.duration);

  async function useFootage() {
    if (!file || busy) return;
    if (await onUpload(file)) {
      setFile(null);
      setReshooting(false);
    }
  }

  return (
    <div className="card !rounded-xl overflow-hidden">
      {/* ── Card head: what this clip is and how it plays ── */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-line bg-bg">
        <span className="mono-label !text-primary shrink-0">
          {index === 0 ? "HERO" : `CLIP ${index + 1}`}
        </span>
        <input
          className="flex-1 min-w-[8rem] bg-transparent text-sm font-medium outline-none border-b border-transparent focus:border-line-strong"
          value={labelDraft}
          disabled={busy || rendering}
          onChange={(e) => setLabelDraft(e.target.value)}
          onBlur={() => {
            const next = labelDraft.trim();
            if (next && next !== clip.label) onRename(next);
            else setLabelDraft(clip.label);
          }}
          aria-label="What this video is for"
        />
        <div className="flex items-center gap-1 shrink-0">
          {(["scrub", "loop"] as const).map((m) => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              disabled={busy || rendering}
              aria-pressed={clip.mode === m}
              title={
                m === "scrub"
                  ? "Scrolling drives this video forward and back"
                  : "This video plays on repeat by itself"
              }
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                clip.mode === m
                  ? "bg-primary text-white"
                  : "text-muted hover:text-primary border border-line-strong"
              }`}
            >
              {m === "scrub" ? "Scrub" : "Loop"}
            </button>
          ))}
          {removable && (
            <button
              onClick={onRemove}
              disabled={busy || rendering}
              className="ml-1 px-2 py-1 text-xs text-faint hover:text-danger transition-colors"
              title="Remove this video"
              aria-label={`Remove ${clip.label || "this video"}`}
            >
              <span aria-hidden>✕</span>
            </button>
          )}
        </div>
      </div>

      {/* ── Card body ── */}
      {rendering ? (
        <div className="p-8 flex flex-col items-center gap-2 text-center" role="status" aria-live="polite">
          <p className="mono-label flex items-center gap-2">
            <span className="rec-dot" aria-hidden /> RENDERING
          </p>
          <p className="text-sm text-muted">
            Usually under two minutes. It&apos;ll appear here the moment it&apos;s ready.
          </p>
        </div>
      ) : ready && !reshooting ? (
        <div className="p-4 space-y-3">
          <video
            src={clip.url!}
            controls
            muted
            loop
            playsInline
            /* metadata, not auto: the review player shouldn't pull the whole
               clip over cellular before the user asks to watch it, but it does
               need enough to paint a first frame instead of a black box. */
            preload="metadata"
            className="w-full rounded-lg border border-line bg-black"
          />
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="mono-label !text-primary">{uploaded ? "YOUR FOOTAGE" : "AI GENERATED"}</p>
              <p className="mt-1 text-xs text-muted line-clamp-2">
                {uploaded ? clip.settings?.originalName || "Uploaded video" : clip.prompt}
              </p>
            </div>
            <button onClick={() => setReshooting(true)} disabled={busy} className="btn-ghost !py-2 !px-3.5 !text-xs shrink-0">
              Replace footage
            </button>
          </div>
        </div>
      ) : null}

      {showControls && !rendering && (
        <div className="p-4 space-y-3">
          {reshooting && (
            <button
              onClick={() => setReshooting(false)}
              disabled={busy}
              className="mono-label hover:!text-ink transition-colors"
            >
              ← Back to current footage
            </button>
          )}

          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Footage source">
            {(["upload", "ai"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={source === option}
                disabled={busy}
                onClick={() => setSource(option)}
                className={`rounded-lg border px-3 py-3 text-sm font-medium transition-colors disabled:opacity-60 ${
                  source === option
                    ? "border-primary bg-primary-soft/40 text-primary"
                    : "border-line-strong text-muted hover:border-primary hover:text-primary"
                }`}
              >
                {option === "upload" ? "Use my footage" : "Generate with AI"}
              </button>
            ))}
          </div>

          {source === "upload" ? (
            <>
              <p className="text-xs text-muted">Bring your own video. Uploads use no AI credits.</p>
              <FootageUpload
                onSelect={setFile}
                file={file}
                disabled={busy}
                busy={uploading}
                progress={uploadProgress}
              />
              <button
                type="button"
                onClick={useFootage}
                disabled={busy || !file}
                className="btn-primary w-full !py-3"
              >
                {uploading ? "Uploading footage…" : ready ? "Replace with this footage · Free" : "Use this footage · Free"}
              </button>
            </>
          ) : (
            <>
              {clip.status === "failed" && (
                <p className="text-xs text-danger">
                  That render failed and your credits were refunded. Try adjusting the shot.
                </p>
              )}

              <div className="flex flex-wrap gap-1.5">
                {VIDEO_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    className={chipCls}
                    title={t.hint}
                    disabled={busy}
                    onClick={() => onDraftChange({ prompt: t.prompt })}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <textarea
                className="field min-h-[110px] resize-y"
                placeholder="Describe the shot: subject, camera movement, lighting, mood… Or let us suggest one from your brief."
                value={draft.prompt}
                disabled={busy}
                aria-label="Describe the video shot"
                onChange={(e) => onDraftChange({ prompt: e.target.value })}
              />

              <button onClick={onSuggest} disabled={suggesting || busy} className="btn-ghost w-full !text-xs">
                {suggesting ? "Thinking up a shot…" : "✨ Suggest a shot from my brief · free"}
              </button>

              <div className="rounded-lg border border-line">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  disabled={busy}
                  className="w-full flex items-center justify-between px-3 py-2 text-left"
                >
                  <span className="mono-label">
                    {model?.label ?? draft.model} · {shot.resolution ?? "native"} · {shot.duration}s ·{" "}
                    {shot.ratio ?? "native"}
                  </span>
                  <span className="text-faint text-xs">{showAdvanced ? "▲" : "▾"}</span>
                </button>
                {showAdvanced && (
                  <ShotControls
                    className="px-3 pb-3"
                    value={draft}
                    onChange={onDraftChange}
                    showRatio
                    costLabel={costLabel}
                    isAdmin={isAdmin}
                    pinned={pinnedShot}
                  />
                )}
              </div>

              <button
                onClick={onGenerate}
                disabled={busy || !draft.prompt.trim()}
                className="btn-primary w-full !py-3"
              >
                {ready ? `Reshoot · ${costLabel(cost)}` : `Generate video · ${costLabel(cost)}`}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
