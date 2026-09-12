import { VIDEO_MODELS, resolveShot, type Ratio, type Resolution, type VideoModelId } from "./higgsfield";
import { FREE_TIER, videoCost } from "./pricing";

export interface VideoRecommendation {
  model: VideoModelId;
  reason: string;
  resolution: Resolution;
  duration: number;
  ratio: Ratio;
  /** Catalog credits for this shot, or zero for the included free preset. */
  cost: number;
}

export interface RecommendationSettings {
  resolution: Resolution;
  duration: number;
  ratio: Ratio;
}

/** The same input normalization runs in the browser and at the charge boundary. */
export function normalizeRecommendationSettings(value: Partial<RecommendationSettings> | null | undefined): RecommendationSettings {
  return {
    resolution: value?.resolution === "480p" || value?.resolution === "1080p" ? value.resolution : "720p",
    duration: typeof value?.duration === "number" && Number.isFinite(value.duration)
      ? Math.min(12, Math.max(4, value.duration)) : 5,
    ratio: value?.ratio === "9:16" || value?.ratio === "1:1" || value?.ratio === "21:9" ? value.ratio : "16:9",
  };
}

type Intent = { match: RegExp; models: Partial<Record<VideoModelId, number>>; reason: string };

// Explainable routing rules based on the catalog's declared model strengths.
// These weights express product preferences, not measured model benchmarks.
// Capability mismatches are penalized separately, and price breaks equal fits.
// Primary references for the style/motion/sequence rules:
// https://www.minimax.io/news/minimax-hailuo-23
// https://ir.kuaishou.com/news-releases/news-release-details/kling-ai-launches-25-turbo-video-model-industry-leading/
// https://openai.com/index/sora-2/ (availability is always checked separately)
// https://seed.bytedance.com/en/seedance
// https://seed.bytedance.com/en/public_papers/seedance-1-0-exploring-the-boundaries-of-video-generation-models
const INTENTS: Intent[] = [
  { match: /\b(draft|rough|budget|cheap|inexpensive|low.cost|test render)\b/i,
    models: { "seedance-lite": 35, "ltx-2": 12 }, reason: "your request for a low-cost draft" },
  { match: /\b(anime|animation|animated|cartoon|stylized|stylised|surreal|fantasy|expressive|illustration|claymation)\b/i,
    models: { "hailuo-2.3": 28, "hailuo-2.3-pro": 28 }, reason: "the expressive or stylized look in your prompt" },
  { match: /\b(cinematic|tracking shot|dolly|orbit|chase|stunt|sports?|athlete|danc(?:e|er|ing)|physics|slow.motion|crash|splash)\b/i,
    models: { "kling-2.5-turbo-pro": 28, "kling-2.1-master": 18 }, reason: "the cinematic movement in your prompt" },
  { match: /\b(sequence|multi.shot|storyboard|first.+then|then.+finally|several scenes|multiple scenes|precise choreography)\b/i,
    models: { "sora-2": 28, "sora-2-pro": 28 }, reason: "the sequence of actions in your prompt" },
  { match: /\b(fast turnaround|quick render|render quickly|in a hurry|fast generation|quick draft)\b/i,
    models: { "seedance-pro-fast": 28, "ltx-2": 16 }, reason: "your request for a quick render" },
  { match: /\b(macro|close.up|product|photorealistic|detailed textures?|fine detail|handmade|ceramic)\b/i,
    models: { "seedance-lite": 20, "seedance-pro-fast": 20 }, reason: "the detailed imagery in your prompt" },
];

/**
 * Recommend from models the server has confirmed accessible. This is pure and
 * makes no generation or LLM calls, so a changing prompt can update instantly.
 * The free allowance always keeps its existing fixed model/length/quality.
 */
export function recommendVideoModel({ prompt, settings, available, pinned = false }: {
  prompt: string;
  settings: RecommendationSettings;
  available: Record<string, boolean>;
  pinned?: boolean;
}): VideoRecommendation | null {
  const want = normalizeRecommendationSettings(settings);
  if (pinned) {
    if (available[FREE_TIER.video.model] !== true) return null;
    return {
      ...FREE_TIER.video,
      ratio: want.ratio,
      cost: 0,
      reason: `Your included video uses Seedance 1 Lite at ${FREE_TIER.video.resolution} for ${FREE_TIER.video.duration} seconds. Prompt-based model matching is available with a subscription.`,
    };
  }

  const matches = INTENTS.filter((intent) => intent.match.test(prompt.slice(0, 6000)));
  const ranked = VIDEO_MODELS.map((entry) => {
    const model = entry.id as VideoModelId;
    const shot = resolveShot(model, want);
    const resolution = shot.resolution ?? "720p";
    const ratio = shot.ratio ?? "16:9";
    const cost = videoCost(model, resolution, shot.duration);
    const matched = matches.filter((intent) => intent.models[model]);
    let score = matched.reduce((sum, intent) => sum + (intent.models[model] ?? 0), 0);
    // Longer takes and explicitly chosen formats should not be dropped just
    // because a model matches a style word. Native/automatic settings remain
    // eligible for the default 720p widescreen shot.
    score -= Math.abs(shot.duration - want.duration) * 12;
    if (want.ratio !== "16:9" && shot.ratio !== want.ratio) score -= 80;
    if (want.resolution !== "720p" && shot.resolution !== want.resolution) score -= 60;
    return { model, entry, shot, resolution, ratio, cost, matched, score };
  }).sort((a, b) => b.score - a.score || a.cost - b.cost || a.model.localeCompare(b.model));

  const chosen = ranked.find((entry) => available[entry.model] === true);
  if (!chosen) return null;
  const preferred = ranked[0];
  let reason = chosen.matched.length
    ? `Recommended for ${chosen.matched[0].reason}.`
    : "The lowest-cost available match for your requested shot settings.";
  if (chosen.model !== preferred.model) {
    reason += ` ${preferred.entry.label} is unavailable, so this is the next available match.`;
  }
  if (chosen.shot.duration !== want.duration) reason += ` The closest supported length is ${chosen.shot.duration} seconds.`;
  if (chosen.shot.resolution !== want.resolution) {
    reason += chosen.shot.resolution
      ? ` This model uses ${chosen.resolution}.`
      : " Resolution is automatic for this model.";
  }
  if (chosen.shot.ratio !== want.ratio) {
    reason += chosen.shot.ratio ? ` Framing uses ${chosen.ratio}.` : " Framing is automatic for this model.";
  }
  return { model: chosen.model, reason, resolution: chosen.resolution, duration: chosen.shot.duration, ratio: chosen.ratio, cost: chosen.cost };
}

/** Never silently change a model, supported settings, or price after consent. */
export function matchesVideoRecommendation(quote: {
  model?: unknown; resolution?: unknown; duration?: unknown; ratio?: unknown; cost?: unknown;
}, recommendation: VideoRecommendation): boolean {
  return quote.model === recommendation.model && quote.resolution === recommendation.resolution &&
    quote.duration === recommendation.duration && quote.ratio === recommendation.ratio && quote.cost === recommendation.cost;
}
