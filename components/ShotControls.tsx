"use client";

import { useId } from "react";
import {
  VIDEO_MODELS,
  type VideoModelId,
  type Resolution,
  type Ratio,
} from "@/lib/higgsfield";
import { FREE_TIER } from "@/lib/pricing";
import type { VideoRecommendation } from "@/lib/video-recommendation";
import { Select, type SelectOption } from "@/components/ui/Select";

export interface ShotSettings {
  model: VideoModelId;
  resolution: Resolution;
  duration: number;
  ratio: Ratio;
}

const RATIOS: SelectOption<Ratio>[] = [
  { value: "16:9", label: "Wide 16:9" },
  { value: "21:9", label: "Cinema 21:9" },
  { value: "1:1", label: "Square 1:1" },
  { value: "9:16", label: "Tall 9:16" },
];
const RESOLUTIONS: SelectOption<Resolution>[] = [
  { value: "480p", label: "480p", meta: "draft" },
  { value: "720p", label: "720p", meta: "standard" },
  { value: "1080p", label: "1080p", meta: "sharpest" },
];
const DURATIONS = [...new Set(VIDEO_MODELS.flatMap((model) => model.durations))].sort((a, b) => a - b);

/** A prompt-based recommendation and the user's preferred output settings. */
export function ShotControls({
  value,
  onChange,
  recommendation,
  recommendationLoading = false,
  recommendationError = null,
  onRetry,
  showRatio = false,
  costLabel,
  pinned = false,
  className = "",
}: {
  value: ShotSettings;
  onChange: (patch: Partial<ShotSettings>) => void;
  recommendation: VideoRecommendation | null;
  recommendationLoading?: boolean;
  recommendationError?: string | null;
  onRetry?: () => void;
  showRatio?: boolean;
  costLabel?: (credits: number) => string;
  /** The free hero uses its included preset, regardless of prompt or settings. */
  pinned?: boolean;
  className?: string;
}) {
  const id = useId();
  const model = recommendation && VIDEO_MODELS.find((entry) => entry.id === recommendation.model);
  const resolution = pinned ? FREE_TIER.video.resolution : value.resolution;
  const duration = pinned ? FREE_TIER.video.duration : value.duration;
  const stopIndex = Math.max(0, DURATIONS.indexOf(duration));

  return (
    <div className={className}>
      <div className="rounded-lg border border-line-strong bg-bg-raise px-3.5 py-3" role="status" aria-live="polite">
        <p className="mono-label !text-primary">
          {pinned ? "INCLUDED VIDEO MODEL" : "RECOMMENDED VIDEO MODEL"}
        </p>
        {recommendationLoading ? (
          <p className="mt-2 text-sm text-muted">Checking available video models…</p>
        ) : recommendationError ? (
          <div className="mt-2">
            <p className="text-sm text-danger">{recommendationError}</p>
            {onRetry && (
              <button type="button" onClick={onRetry} className="mt-2 text-sm font-medium text-primary underline underline-offset-4">
                Try again
              </button>
            )}
          </div>
        ) : recommendation && model ? (
          <>
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium">{model.label}</p>
              <p className="text-sm font-medium tabular-nums">
                {pinned ? "Included in your free shot" : costLabel ? costLabel(recommendation.cost) : `${recommendation.cost} credits`}
              </p>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">{recommendation.reason}</p>
            <p className="mt-2 text-xs text-muted">
              {model.resolutions ? recommendation.resolution : "Native resolution"} · {recommendation.duration}s
              {showRatio && ` · ${model.ratios ? recommendation.ratio : "Native framing"}`}
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">
            {pinned
              ? "Describe your shot to review the included model and settings."
              : "Describe your shot and we’ll recommend a model for its style, motion and detail."}
          </p>
        )}
      </div>

      <div className={`mt-4 grid gap-4 ${showRatio ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
        <div>
          <label className="mono-label block mb-1.5" htmlFor={`${id}-quality`}>QUALITY</label>
          <Select
            id={`${id}-quality`}
            value={resolution}
            onChange={(next) => onChange({ resolution: next })}
            disabled={pinned}
            groups={[{ options: RESOLUTIONS }]}
          />
          <p className="mt-1.5 text-xs text-muted leading-snug">
            {pinned ? "Included at 720p." : "Preferred quality. The recommendation shows the actual output."}
          </p>
        </div>

        {showRatio && (
          <div>
            <label className="mono-label block mb-1.5" htmlFor={`${id}-ratio`}>SHAPE</label>
            <Select
              id={`${id}-ratio`}
              value={value.ratio}
              onChange={(ratio) => onChange({ ratio })}
              groups={[{ options: RATIOS }]}
            />
            <p className="mt-1.5 text-xs text-muted leading-snug">Preferred framing of the finished clip.</p>
          </div>
        )}

        <div>
          <div className="flex items-baseline justify-between gap-2">
            <label className="mono-label" htmlFor={`${id}-length`}>LENGTH</label>
            <span className="text-sm font-medium tabular-nums">{duration}s</span>
          </div>
          <input
            id={`${id}-length`}
            type="range"
            className="range mt-2 w-full"
            min={0}
            max={DURATIONS.length - 1}
            step={1}
            value={stopIndex}
            disabled={pinned}
            onChange={(event) => onChange({ duration: DURATIONS[Number(event.target.value)] })}
            aria-valuetext={`${duration} seconds`}
          />
          <div className="mt-1 flex justify-between text-xs text-faint tabular-nums">
            <span>{DURATIONS[0]}s</span>
            <span>{DURATIONS[DURATIONS.length - 1]}s</span>
          </div>
          <p className="mt-1 text-xs text-muted leading-snug">
            {pinned ? "One 5-second take is included." : "We’ll match the closest length the recommended model supports."}
          </p>
        </div>
      </div>
    </div>
  );
}
