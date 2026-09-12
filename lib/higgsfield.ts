// Higgsfield client, one asynchronous generation API in front of several
// hosted video models (https://docs.higgsfield.ai).
//
// The shape is: POST to a per-model path, get back a `request_id` plus a
// `status_url`, then poll until the request reaches a terminal state. That is
// the whole contract the rest of the app depends on, `createVideoTask` and
// `getVideoTask`. Swapping models is an env change (HIGGSFIELD_MODEL); swapping
// providers again means rewriting only these two functions.

const BASE = (process.env.HIGGSFIELD_API_BASE ?? "https://api.higgsfield.ai").replace(/\/$/, "");

export type Resolution = "480p" | "720p" | "1080p";
export type Ratio = "16:9" | "9:16" | "1:1" | "21:9";

export interface CreateVideoParams {
  prompt: string;
  resolution: Resolution;
  duration: number;
  ratio: Ratio;
  /** Per-shot override; falls back to HIGGSFIELD_MODEL, then the default. */
  model?: string;
}

export interface VideoTaskStatus {
  status: "queued" | "running" | "succeeded" | "failed";
  videoUrl?: string;
  error?: string;
}

interface Model {
  id: string;
  label: string;
  blurb: string;
  /** Path under the API base, from the published OpenAPI spec. */
  path: string;
  /** Durations in seconds the model accepts; we snap to the nearest one. */
  durations: number[];
  /** Aspect ratios it accepts, or null when it has no such control. */
  ratios: Ratio[] | null;
  /** Resolutions it accepts, or null when the model picks its own. */
  resolutions: Resolution[] | null;
  body(p: CreateVideoParams, resolved: { duration: number; ratio: Ratio | null }): Record<string, unknown>;
}

// Every text-to-video model Higgsfield publishes, in ascending order of cost
// (see VIDEO_MODEL_USD_PER_SECOND in lib/pricing.ts, the picker groups on the
// same order). Capabilities are taken from the published OpenAPI spec at
// https://docs.higgsfield.ai/docs/openapi.json rather than guessed: each entry
// declares only the controls that model really has, because the API rejects
// values outside its enum, and anything a model can't express is dropped rather
// than faked.
//
// Access is gated per account, so a model listed here may still answer
// `model_not_found`, /api/video/models probes which ones this account can
// reach and the picker marks the rest unavailable instead of letting someone
// pick a certain failure.
const MODELS = {
  "seedance-lite": {
    id: "seedance-lite",
    label: "Seedance 1 Lite",
    blurb: "Cheapest way to shoot a draft",
    path: "/bytedance/seedance/v1/lite/text-to-video",
    durations: [5, 10],
    ratios: ["16:9", "9:16", "1:1", "21:9"],
    resolutions: ["480p", "720p", "1080p"],
    // Seedance names resolutions without the "p".
    body: (p, r) => ({
      prompt: p.prompt,
      duration: r.duration,
      resolution: p.resolution.replace("p", ""),
      aspect_ratio: r.ratio,
    }),
  },
  "ltx-2": {
    id: "ltx-2",
    label: "LTX-2",
    blurb: "Quick, clean motion on a budget",
    path: "/ltx-2/text-to-video",
    durations: [5, 10],
    ratios: null,
    resolutions: null,
    body: (p, r) => ({ prompt: p.prompt, duration: r.duration }),
  },
  "hailuo-02": {
    id: "hailuo-02",
    label: "Hailuo 02",
    blurb: "Dependable all-rounder, low cost",
    path: "/minimax/hailuo-02/standard/text-to-video",
    durations: [6, 10],
    ratios: null,
    resolutions: null,
    body: (p, r) => ({ prompt: p.prompt, duration: r.duration }),
  },
  "hailuo-2.3": {
    id: "hailuo-2.3",
    label: "Hailuo 2.3",
    blurb: "Expressive, stylised look",
    path: "/minimax/hailuo-2.3/standard/text-to-video",
    durations: [6, 10],
    ratios: null,
    resolutions: null,
    body: (p, r) => ({ prompt: p.prompt, duration: r.duration }),
  },
  "seedance-pro-fast": {
    id: "seedance-pro-fast",
    label: "Seedance 1 Pro Fast",
    blurb: "Seedance quality at speed",
    path: "/bytedance/seedance/v1/pro/fast/text-to-video",
    durations: [5, 10],
    ratios: ["16:9", "9:16", "1:1", "21:9"],
    resolutions: ["480p", "720p", "1080p"],
    body: (p, r) => ({
      prompt: p.prompt,
      duration: r.duration,
      resolution: p.resolution.replace("p", ""),
      aspect_ratio: r.ratio,
    }),
  },
  "kling-2.5-turbo-pro": {
    id: "kling-2.5-turbo-pro",
    label: "Kling 2.5 Turbo Pro",
    blurb: "Dynamic motion and camera movement",
    path: "/kling-video/v2.5-turbo/pro/text-to-video",
    durations: [5, 10],
    ratios: null,
    resolutions: null,
    body: (p, r) => ({ prompt: p.prompt, duration: r.duration }),
  },
  "hailuo-02-pro": {
    id: "hailuo-02-pro",
    label: "Hailuo 02 Pro",
    blurb: "Sharper Hailuo, fixed 6-second take",
    path: "/minimax/hailuo-02/pro/text-to-video",
    durations: [6],
    ratios: null,
    resolutions: null,
    body: (p) => ({ prompt: p.prompt }),
  },
  "hailuo-2.3-pro": {
    id: "hailuo-2.3-pro",
    label: "Hailuo 2.3 Pro",
    blurb: "Best Hailuo detail, fixed 6-second take",
    path: "/minimax/hailuo-2.3/pro/text-to-video",
    durations: [6],
    ratios: null,
    resolutions: null,
    body: (p) => ({ prompt: p.prompt }),
  },
  "wan-2.5": {
    id: "wan-2.5",
    label: "WAN 2.5",
    blurb: "Best all-round; honours length and quality",
    path: "/wan-25-preview/text-to-video",
    durations: [5, 10],
    ratios: null,
    resolutions: ["480p", "720p", "1080p"],
    body: (p, r) => ({ prompt: p.prompt, duration: r.duration, resolution: p.resolution }),
  },
  "sora-2": {
    id: "sora-2",
    label: "Sora 2",
    blurb: "Strong prompt-following; up to 12 seconds",
    path: "/sora-2/text-to-video",
    durations: [4, 8, 12],
    ratios: ["16:9", "9:16"],
    resolutions: ["720p"],
    body: (p, r) => ({
      prompt: p.prompt,
      duration: r.duration,
      resolution: "720p",
      aspect_ratio: r.ratio,
    }),
  },
  "kling-2.1-master": {
    id: "kling-2.1-master",
    label: "Kling 2.1 Master",
    blurb: "Cinematic motion, strong physics",
    path: "/kling-video/v2.1/master/text-to-video",
    durations: [5, 10],
    ratios: ["16:9", "9:16", "1:1"],
    resolutions: null,
    body: (p, r) => ({ prompt: p.prompt, duration: r.duration, aspect_ratio: r.ratio }),
  },
  "sora-2-pro": {
    id: "sora-2-pro",
    label: "Sora 2 Pro",
    blurb: "The most expensive shot money can buy here",
    path: "/sora-2/text-to-video/pro",
    durations: [4, 8, 12],
    ratios: ["16:9", "9:16"],
    resolutions: ["720p", "1080p"],
    body: (p, r) => ({
      prompt: p.prompt,
      duration: r.duration,
      resolution: p.resolution === "480p" ? "720p" : p.resolution,
      aspect_ratio: r.ratio,
    }),
  },
} satisfies Record<string, Model>;

export type VideoModelId = keyof typeof MODELS;

export const DEFAULT_VIDEO_MODEL: VideoModelId = "wan-2.5";

/** The catalog in picker order, cheapest first. */
export const VIDEO_MODELS = Object.values(MODELS) as readonly Model[];

export function isVideoModel(v: unknown): v is VideoModelId {
  return typeof v === "string" && v in MODELS;
}

/** The longest take any model in the catalog can shoot. */
export const MAX_DURATION = Math.max(...VIDEO_MODELS.flatMap((m) => m.durations));
/** The shortest. */
export const MIN_DURATION = Math.min(...VIDEO_MODELS.flatMap((m) => m.durations));

/**
 * What a model will actually shoot given what the user asked for. The studio
 * shows this so nobody picks 1080p on a model that has no resolution control
 * and wonders why the file came back at 720p.
 */
export function resolveShot(
  id: VideoModelId,
  want: { resolution: Resolution; duration: number; ratio: Ratio }
): { resolution: Resolution | null; duration: number; ratio: Ratio | null } {
  const m: Model = MODELS[id];
  return {
    resolution: m.resolutions
      ? m.resolutions.includes(want.resolution)
        ? want.resolution
        : nearestResolution(m.resolutions, want.resolution)
      : null,
    duration: nearest([...m.durations], want.duration),
    ratio: m.ratios ? (m.ratios.includes(want.ratio) ? want.ratio : m.ratios[0]) : null,
  };
}

const RES_ORDER: Resolution[] = ["480p", "720p", "1080p"];

function nearestResolution(available: readonly Resolution[], want: Resolution): Resolution {
  const target = RES_ORDER.indexOf(want);
  return [...available].reduce((best, r) =>
    Math.abs(RES_ORDER.indexOf(r) - target) < Math.abs(RES_ORDER.indexOf(best) - target) ? r : best
  );
}

function model(override?: string): Model {
  const key = override?.trim() || process.env.HIGGSFIELD_MODEL?.trim() || DEFAULT_VIDEO_MODEL;
  if (!isVideoModel(key)) {
    throw new Error(
      `Unknown video model "${key}"; expected one of: ${Object.keys(MODELS).join(", ")}`
    );
  }
  return MODELS[key];
}

function headers() {
  // Credentials are a key-id/secret pair. Accept either two vars or a single
  // "id:secret" string, which is how the console hands the pair over.
  const id = process.env.HIGGSFIELD_API_KEY?.trim() ?? "";
  const secret = process.env.HIGGSFIELD_API_SECRET?.trim();
  const credentials = secret ? `${id}:${secret}` : id;
  return {
    "Content-Type": "application/json",
    Authorization: `Key ${credentials}`,
  };
}

/** Snaps a requested duration onto the closest one the model actually supports. */
function nearest(values: number[], want: number): number {
  return values.reduce((best, v) => (Math.abs(v - want) < Math.abs(best - want) ? v : best));
}

export async function createVideoTask(params: CreateVideoParams): Promise<{ taskId: string }> {
  const m = model(params.model);
  const resolved = {
    ratio: m.ratios ? (m.ratios.includes(params.ratio) ? params.ratio : m.ratios[0]) : null,
    duration: nearest([...m.durations], params.duration),
  };

  const res = await fetch(`${BASE}${m.path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(m.body(params, resolved)),
    // Leave room in the route's function budget to restore the user's charge
    // when the provider does not acknowledge a submission.
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    // Access can change after a recommendation was shown.
    if (res.status === 404 && detail.includes("model_not_found")) {
      throw new Error(`${m.label} is currently unavailable. Please try again shortly.`);
    }
    throw new Error(`Higgsfield task creation failed (${res.status}): ${detail}`);
  }
  const data = (await res.json()) as { request_id?: string; id?: string };
  const taskId = data.request_id ?? data.id;
  if (!taskId) throw new Error("Higgsfield response had no request id");
  return { taskId };
}

// A completed request carries its output under one of a few keys depending on
// the model, so check each rather than assuming one shape.
function pickVideoUrl(data: Record<string, unknown>): string | undefined {
  const asUrl = (v: unknown): string | undefined => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && typeof (v as { url?: unknown }).url === "string") {
      return (v as { url: string }).url;
    }
    return undefined;
  };
  const videos = data.videos;
  return (
    asUrl(data.video) ??
    asUrl(Array.isArray(videos) ? videos[0] : undefined) ??
    asUrl((data.results as { raw?: unknown } | undefined)?.raw) ??
    asUrl(data.output)
  );
}

export async function getVideoTask(taskId: string): Promise<VideoTaskStatus> {
  const res = await fetch(`${BASE}/requests/${taskId}/status`, {
    headers: headers(),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Higgsfield task lookup failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as Record<string, unknown> & {
    status?: string;
    error?: { message?: string } | string;
  };

  const status = String(data.status ?? "").toLowerCase();
  switch (status) {
    case "completed":
      return { status: "succeeded", videoUrl: pickVideoUrl(data) };
    case "nsfw":
      // A terminal refusal, not an outage. Say so, since a retry of the same
      // prompt will fail the same way. The caller refunds either way.
      return { status: "failed", error: "The prompt was rejected by the content filter" };
    case "failed":
    case "canceled":
    case "cancelled": {
      const msg = typeof data.error === "string" ? data.error : data.error?.message;
      return { status: "failed", error: msg ?? "Video generation failed" };
    }
    case "in_progress":
    case "processing":
    case "running":
      return { status: "running" };
    default:
      return { status: "queued" };
  }
}

// ── Provider health ────────────────────────────────────────────────
//
// There is no documented health endpoint, so we ask the API something it can
// answer cheaply: the status of a request id that cannot exist. A 4xx "not
// found" is a healthy answer, it means the service is up and our credentials
// were accepted. Only an auth rejection, a 5xx, or no answer at all counts as
// down, which is exactly what a user needs to know before spending credits.

export interface ProviderHealth {
  status: "live" | "offline";
  /** Short, user-facing reason when offline. */
  detail?: string;
  checkedAt: string;
}

const PROBE_ID = "00000000-0000-0000-0000-000000000000";
const PROBE_TIMEOUT_MS = 6000;

export async function checkHealth(): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString();
  if (!process.env.HIGGSFIELD_API_KEY?.trim()) {
    return { status: "offline", detail: "Not configured", checkedAt };
  }

  try {
    const res = await fetch(`${BASE}/requests/${PROBE_ID}/status`, {
      headers: headers(),
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (res.status === 401 || res.status === 403) {
      return { status: "offline", detail: "Credentials rejected", checkedAt };
    }
    if (res.status === 429) {
      // Answering at all means the service is up; we're just being throttled.
      return { status: "live", detail: "Rate limited", checkedAt };
    }
    if (res.status >= 500) {
      return { status: "offline", detail: `Provider error (${res.status})`, checkedAt };
    }
    return { status: "live", checkedAt };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      status: "offline",
      detail: timedOut ? "No response" : "Unreachable",
      checkedAt,
    };
  }
}

/**
 * Which catalog models this account may actually call.
 *
 * The probe is a POST with an empty body: a model that exists answers 400
 * ("'prompt' is a required property") and a gated one answers 404
 * `model_not_found`. Because the body carries no prompt, nothing can be
 * generated by asking, this must stay true of any future probe body, since a
 * request the API considers *valid* starts a paid render.
 */
export async function checkModelAccess(): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    VIDEO_MODELS.map(async (m) => {
      try {
        const res = await fetch(`${BASE}${m.path}`, {
          method: "POST",
          headers: headers(),
          body: "{}",
          cache: "no-store",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        // Only validation errors confirm that this endpoint exists and our
        // account reached input validation. Auth failures, throttling, and
        // outages must never turn into permission to start a paid render.
        return [m.id, res.status === 400 || res.status === 422] as const;
      } catch {
        return [m.id, false] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}
