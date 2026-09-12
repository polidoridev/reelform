"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import { toast } from "@/components/ui/Toaster";
import {
  MODELS,
  FREE_TIER,
  estimateBuildCredits,
  resolveModel,
  type ModelId,
  DEPLOY_ENABLED,
} from "@/lib/pricing";
import {
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODELS,
  isVideoModel,
  type Resolution,
  type VideoModelId,
} from "@/lib/higgsfield";
import { SITE_TEMPLATES } from "@/lib/templates";
import { MAX_VIDEOS_PER_PROJECT, type VideoRow } from "@/lib/videos";
import ProviderStatus from "@/components/ProviderStatus";
import { Select } from "@/components/ui/Select";
import { ClipCard, type ClipDraft, type Ratio } from "@/components/ClipCard";
import { DeployPanel } from "@/components/DeployPanel";
import { SiteChat, type ChatMessage } from "@/components/SiteChat";
import { trackEvent } from "@/lib/analytics";
import { BrandMark } from "@/components/BrandMark";
import { uploadFootage } from "@/lib/upload-footage";
import { useVideoRecommendation } from "@/lib/use-video-recommendation";
import type { VideoRecommendation } from "@/lib/video-recommendation";

const ERROR_SENTINEL = "\n<<<REELFORM_ERROR>>>";

interface ProjectRow {
  id: string;
  name: string;
  industry: string | null;
  site_brief: string | null;
  video_mode: "loop" | "scrub";
  site_html: string | null;
  model: string;
  published: boolean;
  vercel_url: string | null;
  supabase_project_ref: string | null;
}

interface MessageRow {
  role: string;
  target: string;
  content: string;
  created_at: string;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : trimmed;
}

const chipCls =
  "rounded-full border border-line-strong px-3 py-1.5 text-xs font-medium text-muted hover:border-primary hover:text-primary transition-colors cursor-pointer";

// Names the slot the "+" would add next, by how many clips already exist.
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth"];

function draftFor(clip: VideoRow): ClipDraft {
  const s = clip.settings ?? {};
  return {
    prompt: clip.prompt ?? "",
    model: isVideoModel(s.model) ? (s.model as VideoModelId) : DEFAULT_VIDEO_MODEL,
    resolution: (s.resolution as Resolution) ?? "720p",
    duration: typeof s.duration === "number" ? s.duration : 5,
    ratio: (s.ratio as Ratio) ?? "16:9",
  };
}

export function Studio({
  project,
  initialVideos,
  initialCredits,
  initialMessages,
  plan,
  isAdmin = false,
  pinnedShot = false,
  freeBuild = false,
}: {
  project: ProjectRow;
  initialVideos: VideoRow[];
  initialCredits: number;
  initialMessages: MessageRow[];
  plan: string;
  isAdmin?: boolean;
  /** The free hero shot runs on a fixed preset; see ShotControls. */
  pinnedShot?: boolean;
  /** The one free site build runs on a fixed model and is not charged for. */
  freeBuild?: boolean;
}) {
  const [freeShotAvailable, setFreeShotAvailable] = useState(pinnedShot);
  // Brief
  const [name, setName] = useState(project.name);
  const [industry, setIndustry] = useState(project.industry ?? "");
  const [siteBrief, setSiteBrief] = useState(project.site_brief ?? "");

  // Videos: a production can feature several clips.
  const [clips, setClips] = useState<VideoRow[]>(initialVideos);
  const [drafts, setDrafts] = useState<Record<string, ClipDraft>>(() =>
    Object.fromEntries(initialVideos.map((c) => [c.id, draftFor(c)]))
  );
  const [busyClip, setBusyClip] = useState<string | null>(null);
  const [suggestingClip, setSuggestingClip] = useState<string | null>(null);
  const [addingClip, setAddingClip] = useState(false);
  const [uploadingClip, setUploadingClip] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const uploadInFlight = useRef(false);

  // Asking for the next video in plain language, once the first one exists.
  const [shotChat, setShotChat] = useState<ChatMessage[]>(() =>
    initialMessages.filter((m) => m.target === "video").map((m) => ({ role: m.role, content: m.content }))
  );
  const [shotDraft, setShotDraft] = useState("");
  const [requestingClip, setRequestingClip] = useState(false);

  // Build
  const [model, setModel] = useState<ModelId>(
    freeBuild ? FREE_TIER.siteModel : resolveModel(project.model)
  );
  const [siteHtml, setSiteHtml] = useState(project.site_html);
  const [published, setPublished] = useState(project.published);
  const [publishing, setPublishing] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Publishing to the user's own Vercel / Supabase accounts.
  const [deployOpen, setDeployOpen] = useState(false);
  const [liveUrl, setLiveUrl] = useState<string | null>(project.vercel_url);

  // UI
  const [credits, setCredits] = useState(initialCredits);
  const [showBuildAdvanced, setShowBuildAdvanced] = useState(false);
  const [building, setBuilding] = useState(false);
  const [streamedChars, setStreamedChars] = useState(0);
  const [streamTail, setStreamTail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);

  // The conversation under the preview: past turns plus the edit running now.
  const [chat, setChat] = useState<ChatMessage[]>(() =>
    initialMessages.filter((m) => m.target === "claude").map((m) => ({ role: m.role, content: m.content }))
  );
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [editTranscript, setEditTranscript] = useState("");
  const [lastEditCost, setLastEditCost] = useState<number | null>(null);

  // Wizard: one step owns the whole screen at a time.
  const [step, setStep] = useState<1 | 2 | 3>(
    project.site_html ? 3 : initialVideos.some((v) => v.status === "succeeded") ? 2 : 1
  );

  const streamRef = useRef("");

  // How much of the screen the site preview takes; the chat gets the rest.
  const [previewPct, setPreviewPct] = useState(58);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  function startDragSplit(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const container = splitRef.current;
    if (!container) return;
    // The preview is a cross-origin iframe, so it eats pointer events the
    // moment the cursor crosses back over it — which used to make the drag
    // one-way: you could grow the site but never give the chat its room back.
    // Capturing the pointer on the handle (and letting the drag flag switch
    // the frame inert below) keeps every move coming back to us.
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDraggingSplit(true);
    const move = (ev: PointerEvent) => {
      const { top, height } = container.getBoundingClientRect();
      const pct = ((ev.clientY - top) / height) * 100;
      setPreviewPct(Math.min(85, Math.max(25, pct)));
    };
    const stop = () => {
      setDraggingSplit(false);
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  const readyClips = useMemo(
    () => clips.filter((c) => c.status === "succeeded" && c.url),
    [clips]
  );
  const pendingClips = useMemo(
    () => clips.filter((c) => c.status === "queued" || c.status === "running"),
    [clips]
  );

  const refreshCredits = useCallback(async () => {
    const supabase = createSupabaseBrowser();
    const { data } = await supabase.from("profiles").select("credits").single();
    if (data) setCredits(data.credits);
  }, []);

  const patchClip = useCallback((id: string, patch: Partial<VideoRow>) => {
    setClips((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  // ── Video polling: every clip still rendering ──────────────────────
  const pendingIds = pendingClips.map((c) => c.id).join(",");
  useEffect(() => {
    if (!pendingIds) return;
    const ids = pendingIds.split(",");
    const timer = setInterval(async () => {
      for (const id of ids) {
        try {
          const res = await fetch(`/api/video/status?videoId=${id}`);
          const data = await res.json();
          if (data.status === "succeeded") {
            patchClip(id, { status: "succeeded", url: data.videoUrl });
            trackEvent("video_succeeded");
            toast("Footage is ready. Review it in the studio.", "success");
          } else if (data.status === "failed") {
            patchClip(id, { status: "failed" });
            trackEvent("video_failed");
            if (pinnedShot) setFreeShotAvailable(true);
            setError(data.error ?? "Video generation failed; credits refunded.");
            refreshCredits();
          } else if (data.status) {
            patchClip(id, { status: data.status });
          }
        } catch {
          // transient network error: keep polling
        }
      }
    }, 10000); // Higgsfield asks for <=1 status poll per request per 10s
    return () => clearInterval(timer);
  }, [pendingIds, patchClip, refreshCredits, pinnedShot]);

  // ── Clip actions ───────────────────────────────────────────────────
  function setDraftFor(id: string, patch: Partial<ClipDraft>) {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  }

  // Ask for the next video in words; Claude works out the shot and rolls it.
  async function requestClip() {
    const ask = shotDraft.trim();
    if (!ask || !extraVideo.recommendation || requestingClip || uploadInFlight.current || building || editing) return;
    setError(null);
    setRequestingClip(true);
    setShotChat((c) => [...c, { role: "user", content: ask }]);
    try {
      const res = await fetch("/api/video/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, request: ask, ...extraVideo.recommendation, recommendationSettings: extraSettings }),
      });
      const data = await res.json();
      if (!res.ok || !data.video) {
        if (res.status === 409 || res.status === 503) extraVideo.refresh();
        const message = data.message ?? (
          res.status === 402 && typeof data.cost === "number"
            ? `Not enough credits (${data.cost} needed). Top up on the pricing page.`
            : data.error ?? "Could not start that video.");
        setError(message);
        setShotChat((c) => [...c, { role: "assistant", content: message }]);
        return;
      }
      const video = data.video as VideoRow;
      if (video.settings?.free) setFreeShotAvailable(false);
      setShotDraft("");
      trackEvent("video_requested", { source: "chat" });
      setClips((cs) => [...cs, video]);
      setDrafts((d) => ({ ...d, [video.id]: draftFor(video) }));
      setShotChat((c) => [...c, { role: "assistant", content: data.reply }]);
    } catch {
      const message = "Network error. Please try again.";
      setError(message);
      setShotChat((c) => [...c, { role: "assistant", content: message }]);
    } finally {
      setRequestingClip(false);
      refreshCredits();
    }
  }

  // Add the next empty slot by hand. One card at a time: the next "+" only
  // shows once this one exists, so nobody faces six blank squares at once.
  async function addClip() {
    if (addingClip || uploadInFlight.current || building || editing || clips.length >= MAX_VIDEOS_PER_PROJECT) return;
    setAddingClip(true);
    try {
      const res = await fetch("/api/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.video) {
        toast(data.message ?? data.error ?? "Could not add another video. Try again.", "error");
        return;
      }
      const clip = data.video as VideoRow;
      setClips((cs) => [...cs, clip]);
      setDrafts((d) => ({ ...d, [clip.id]: draftFor(clip) }));
    } catch {
      toast("Could not add another video. Check your connection.", "error");
    } finally {
      setAddingClip(false);
    }
  }

  async function removeClip(id: string) {
    if (uploadInFlight.current || busyClip || building || editing) return;
    const previous = clips;
    setClips((cs) => cs.filter((c) => c.id !== id));
    const res = await fetch(`/api/videos?videoId=${id}`, { method: "DELETE" });
    if (!res.ok) {
      setClips(previous);
      // 409 means it's still rendering; the server explains why in `error`.
      const data = await res.json().catch(() => null);
      toast(data?.error ?? "Could not remove that video. Try again.", "error");
    }
  }

  async function updateClip(id: string, patch: { label?: string; mode?: "loop" | "scrub" }) {
    if (uploadInFlight.current || busyClip || building || editing) return;
    const previous = clips.find((c) => c.id === id);
    patchClip(id, patch);
    const res = await fetch("/api/videos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: id, ...patch }),
    });
    if (!res.ok && previous) {
      patchClip(id, { label: previous.label, mode: previous.mode });
      toast("Could not save that change. Try again.", "error");
    }
  }

  async function generateClip(id: string, recommendation: VideoRecommendation, refreshRecommendation: () => void) {
    if (uploadInFlight.current || busyClip || building || editing) return;
    const d = drafts[id];
    if (!d?.prompt.trim()) {
      setError("Describe the video first, or start from a shot style.");
      return;
    }
    setError(null);
    setBusyClip(id);
    try {
      const res = await fetch("/api/video/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: id,
          prompt: d.prompt,
          ...recommendation,
          recommendationSettings: { resolution: d.resolution, duration: d.duration, ratio: d.ratio },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 || res.status === 503) refreshRecommendation();
        setError(data.message ?? (res.status === 402 && typeof data.cost === "number"
          ? `Not enough credits (${data.cost} needed). Top up on the pricing page.`
          : data.error ?? "Video generation failed."));
      } else {
        const selected = data.recommendation ?? recommendation;
        if (data.settings?.free) setFreeShotAvailable(false);
        patchClip(id, {
          status: "queued",
          url: null,
          task_id: data.taskId,
          prompt: d.prompt,
          settings: {
            model: selected.model,
            resolution: selected.resolution,
            duration: selected.duration,
            ratio: selected.ratio,
            cost: data.cost,
            free: data.settings?.free ?? false,
          },
        });
        trackEvent("video_requested", {
          resolution: selected.resolution,
          duration: selected.duration,
          ratio: selected.ratio,
          model: selected.model,
          source: "recommended",
        });
      }
    } catch {
      setError("Could not start video generation. Check your connection and try again.");
    } finally {
      setBusyClip(null);
      refreshCredits();
    }
  }

  async function uploadClip(id: string, file: File): Promise<boolean> {
    if (uploadInFlight.current || busyClip || building || editing) return false;
    const clip = clips.find((c) => c.id === id);
    if (!clip || clip.status === "queued" || clip.status === "running") return false;
    uploadInFlight.current = true;
    setUploadingClip(id);
    setUploadProgress(0);
    setError(null);
    try {
      const uploaded = await uploadFootage(id, file, setUploadProgress);
      patchClip(id, uploaded);
      setDrafts((current) => ({ ...current, [id]: draftFor(uploaded) }));
      trackEvent("video_succeeded", { source: "upload" });
      toast(
        siteHtml ? "Footage uploaded. Rebuild with your current footage to update the website." : "Footage uploaded. You can build your website now.",
        "success"
      );
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload your footage. Please try again.");
      return false;
    } finally {
      uploadInFlight.current = false;
      setUploadingClip(null);
      setUploadProgress(null);
    }
  }

  async function suggestShot(id: string) {
    if (uploadInFlight.current || building || editing) return;
    if (!industry.trim() && !siteBrief.trim()) {
      setError("Fill in the brief first, then I'll suggest a shot.");
      return;
    }
    setError(null);
    setSuggestingClip(id);
    try {
      const clip = clips.find((c) => c.id === id);
      const res = await fetch("/api/site/suggest-shot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, industry, siteBrief, role: clip?.label }),
      });
      const data = await res.json();
      if (!res.ok || !data.prompt) {
        setError(data.message ?? data.error ?? "Could not suggest a shot. Try again.");
        return;
      }
      setDraftFor(id, { prompt: data.prompt });
      toast("Shot suggested. Tweak it or generate as-is.", "success");
    } catch {
      setError("Could not suggest a shot. Check your connection and try again.");
    } finally {
      setSuggestingClip(null);
    }
  }

  // ── Build ──────────────────────────────────────────────────────────
  async function runClaude() {
    if (uploadInFlight.current || building || editing || readyClips.length === 0) return;
    setError(null);
    setBuilding(true);
    setStreamedChars(0);
    setStreamTail("");
    streamRef.current = "";
    trackEvent("site_build_started", { model, clips: clips.length });

    const userMessage = siteBrief.trim();

    try {
      const res = await fetch("/api/site/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          mode: "create",
          model,
          name,
          industry,
          siteBrief,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(
          res.status === 402
            ? `Not enough credits (${data.cost} needed). Top up on the pricing page.`
            : // 429 ships a human-readable `message`; everything else uses `error`.
              data.message ?? data.error ?? "Generation failed."
        );
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        streamRef.current += decoder.decode(value, { stream: true });
        setStreamedChars(streamRef.current.length);
        setStreamTail(streamRef.current.slice(-600));
      }

      const full = streamRef.current;
      const sentinelAt = full.indexOf(ERROR_SENTINEL);
      if (sentinelAt !== -1) {
        setError(full.slice(sentinelAt + ERROR_SENTINEL.length));
        return;
      }

      const html = stripFences(full);
      setSiteHtml(html);
      trackEvent("site_build_completed", { model, chars: html.length });
      toast("Your site is live in the preview. Scroll through it.", "success");
      setPreviewVersion((v) => v + 1);
      setChat((c) => [
        ...c,
        { role: "user", content: userMessage },
        { role: "assistant", content: "Built the first version of the site." },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed.");
    } finally {
      setBuilding(false);
      refreshCredits();
    }
  }

  // Claude-Code-style edit: streams narration live and charges by real usage.
  async function runEdit() {
    const change = draft.trim();
    if (!change || editing || uploadInFlight.current) return;
    setError(null);
    setEditing(true);
    setLastEditCost(null);
    setEditTranscript("");
    setChat((c) => [...c, { role: "user", content: change }]);
    setDraft("");

    let transcript = "";

    try {
      const res = await fetch("/api/site/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, model, instruction: change }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message =
          res.status === 402
            ? `Not enough credits (~${data.cost} needed to start). Top up on the pricing page.`
            : data.error ?? "Edit failed.";
        setError(message);
        // Keep the thread readable: never leave a question without an answer.
        setChat((c) => [...c, { role: "assistant", content: message }]);
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });

        // Newline-delimited JSON events.
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let evt: {
            type: string;
            text?: string;
            label?: string;
            html?: string;
            credits?: number;
            summary?: string;
            message?: string;
          };
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.type === "text" && evt.text) {
            transcript += evt.text;
            setEditTranscript(transcript);
          } else if (evt.type === "step" && evt.label) {
            transcript += `\n· ${evt.label}\n`;
            setEditTranscript(transcript);
          } else if (evt.type === "error") {
            const message = evt.message ?? "Edit failed.";
            setError(message);
            setChat((c) => [...c, { role: "assistant", content: message }]);
            setEditTranscript("");
          } else if (evt.type === "done") {
            if (evt.html) {
              setSiteHtml(evt.html);
              setPreviewVersion((v) => v + 1);
            }
            if (typeof evt.credits === "number") setLastEditCost(evt.credits);
            setChat((c) => [...c, { role: "assistant", content: evt.summary ?? "Applied your change." }]);
            setEditTranscript("");
            trackEvent("site_edited", { model });
            toast(isAdmin ? "Change applied." : `Change applied · ${evt.credits} credits.`, "success");
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Edit failed.");
    } finally {
      setEditing(false);
      refreshCredits();
    }
  }

  async function togglePublish() {
    if (!siteHtml || publishing) return;
    setPublishing(true);
    const next = !published;
    try {
      const supabase = createSupabaseBrowser();
      const { error } = await supabase
        .from("projects")
        .update({ published: next, published_at: next ? new Date().toISOString() : null })
        .eq("id", project.id);
      if (error) {
        toast("Could not update the showcase status. Try again.", "error");
        return;
      }
      setPublished(next);
      if (next) trackEvent("site_published");
      toast(
        next
          ? "Published. Your site is now featured in the showcase."
          : "Removed from the showcase.",
        "success"
      );
    } finally {
      setPublishing(false);
    }
  }

  async function downloadHtml() {
    if (!siteHtml || downloading) return;
    setDownloading(true);
    toast("Packaging your site and videos…", "info");
    try {
      const res = await fetch("/api/site/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast(data?.message ?? data?.error ?? "Could not package the download. Try again.", "error");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name.replace(/\s+/g, "-").toLowerCase() || "site"}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      trackEvent("site_exported", { clips: clips.length });
      toast("Downloaded. Unzip and host the folder anywhere.", "success");
    } catch {
      toast("Could not package the download. Try again.", "error");
    } finally {
      setDownloading(false);
    }
  }

  function openInNewTab() {
    if (!siteHtml) return;
    const blob = new Blob([siteHtml], { type: "text/html" });
    window.open(URL.createObjectURL(blob), "_blank");
  }

  function applySiteTemplate(id: string) {
    const t = SITE_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setIndustry(t.industry);
    setSiteBrief(t.brief);
    toast("Template loaded. Replace the [bracketed] parts with your details.", "info");
  }

  // Builds are metered: this is the ceiling held up front, and anything the
  // build does not spend comes straight back (see /api/site/generate).
  const claudeCost = estimateBuildCredits(model).hold;
  // Chat recommendations use the request text and the hero framing.
  const extraSettings = { model: DEFAULT_VIDEO_MODEL, resolution: "720p" as const, duration: 5, ratio: (clips[0]?.settings?.ratio ?? "16:9") as Ratio };
  const extraVideo = useVideoRecommendation(shotDraft.trim().slice(0, 2000), extraSettings, freeShotAvailable,
    readyClips.length > 0 && clips.length < MAX_VIDEOS_PER_PROJECT);
  const extraModel = VIDEO_MODELS.find((model) => model.id === extraVideo.recommendation?.model);
  const extraModelName = extraModel?.label;

  // Admins never spend credits, and a free account's first shot and first
  // build are on us: show that rather than a price nobody is going to pay.
  const costLabel = (n: number) =>
    isAdmin || freeShotAvailable ? "Free" : `${n} credits`;

  const steps = [
    { n: 1 as const, label: "Brief", done: siteBrief.trim().length > 0 },
    { n: 2 as const, label: "Videos", done: readyClips.length > 0 },
    { n: 3 as const, label: "Build", done: Boolean(siteHtml) },
  ];

  function goStep(n: 1 | 2 | 3) {
    if (uploadInFlight.current) return;
    setError(null);
    setStep(n);
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="h-[100dvh] flex flex-col overflow-hidden">
      {/* ── Top bar: identity + credits + (once built) export actions ── */}
      <header className="flex flex-wrap items-center justify-between gap-y-2 px-4 sm:px-6 py-3 sm:py-3.5 border-b border-line shrink-0 bg-bg">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          {/* The studio is a full-screen workspace, so this row is the only
              way out of it. Logo home, then the breadcrumb back to the
              project list, then where you actually are. */}
          <Link href="/" className="flex items-center shrink-0" title="Reelform home">
            <BrandMark />
            <span className="sr-only">Reelform home</span>
          </Link>
          <Link href="/dashboard" className="mono-label hover:!text-ink transition-colors shrink-0">
            ← DASHBOARD
          </Link>
          <span className="text-line-strong">/</span>
          <span className="font-medium truncate">{name}</span>
        </div>
        <div className="flex w-full sm:w-auto items-center gap-2 sm:gap-3 overflow-x-auto sm:overflow-visible no-scrollbar shrink-0">
          {/* The credit count doubles as the way into the account: it is the
              number people click when they want to know where it went. */}
          {isAdmin ? (
            <Link
              href="/account"
              className="mono-label !text-primary mr-2 hover:opacity-70 transition-opacity shrink-0"
            >
              ADMIN · UNLIMITED
            </Link>
          ) : (
            <>
              <Link
                href="/account"
                title="Your account"
                className="mono-label !text-primary mr-2 hover:opacity-70 transition-opacity shrink-0"
              >
                {credits.toLocaleString()} CREDITS
              </Link>
              <Link href="/pricing" className="btn-ghost !py-2 !px-3.5 !text-xs shrink-0">
                Top up
              </Link>
            </>
          )}
          {siteHtml && (
            <>
              <button
                onClick={togglePublish}
                disabled={publishing}
                title={
                  published
                    ? "Your site is live in the public showcase. Click to remove it"
                    : "Feature your site in the public Reelform showcase"
                }
                className={`shrink-0 !py-2 !px-3.5 !text-xs ${published ? "btn-primary" : "btn-ghost"}`}
              >
                {publishing ? "…" : published ? "★ Featured" : "☆ Get featured"}
              </button>
              <button
                onClick={downloadHtml}
                disabled={downloading}
                className="btn-ghost !py-2 !px-3.5 !text-xs shrink-0"
              >
                {downloading ? "Packaging…" : "⬇ Download"}
              </button>
              {DEPLOY_ENABLED && (
              <button
                onClick={() => setDeployOpen(true)}
                title={liveUrl ? `Live at ${liveUrl}. Click to ship the latest version` : "Push this site live on your own Vercel and Supabase"}
                className="btn-primary !py-2 !px-4 !text-xs shrink-0"
              >
                {liveUrl ? "◉ Live · redeploy" : "↑ Publish live"}
              </button>
              )}
            </>
          )}
        </div>
      </header>

      {/* ── Stepper: full width, click to jump between steps ─────────── */}
      <nav className="flex items-center justify-center gap-3 sm:gap-6 px-6 py-3 border-b border-line shrink-0 bg-bg">
        {steps.map((s, i) => {
          const active = step === s.n;
          return (
            <div key={s.n} className="flex items-center gap-3 sm:gap-6">
              <button
                onClick={() => goStep(s.n)}
                disabled={uploadingClip !== null}
                className="flex items-center gap-2 group"
                aria-current={active ? "step" : undefined}
              >
                <span
                  className={`w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center transition-colors ${
                    s.done
                      ? "bg-primary text-white"
                      : active
                      ? "bg-bg text-primary border-2 border-primary"
                      : "bg-bg-raise text-faint border border-line-strong group-hover:border-primary"
                  }`}
                >
                  {s.done ? "✓" : s.n}
                </span>
                <span
                  className={`text-xs font-bold uppercase tracking-wider transition-colors ${
                    active ? "text-ink" : s.done ? "text-muted" : "text-faint group-hover:text-muted"
                  }`}
                >
                  {s.label}
                </span>
              </button>
              {i < steps.length - 1 && <span className="w-8 sm:w-14 h-px bg-line-strong" aria-hidden />}
            </div>
          );
        })}
      </nav>

      {/* ── Body: one step owns the whole area ───────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col bg-bg-raise">
        {error && (
          <div className="mx-auto mt-4 w-full max-w-2xl px-6 shrink-0">
            {/* assertive: a failed render or a refused build is the one thing
                the user must hear about immediately. */}
            <div
              role="alert"
              aria-live="assertive"
              className="p-3 border border-danger/40 bg-danger/5 text-danger text-sm rounded-lg"
            >
              {error}
            </div>
          </div>
        )}

        {/* ══ STEP 1 · BRIEF ══ */}
        {step === 1 && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="mx-auto w-full max-w-2xl px-6 py-10">
              <p className="mono-label !text-primary">STEP 1 · THE BRIEF</p>
              <h1 className="mt-2 text-3xl font-bold tracking-tight">What are we building?</h1>
              <p className="mt-2 text-muted">
                A sentence or two is enough to start. The more specific you are, the better the result.
              </p>

              <div className="mt-8">
                <p className="mono-label mb-2">START FROM A TEMPLATE</p>
                <div className="flex flex-wrap gap-1.5">
                  {SITE_TEMPLATES.map((t) => (
                    <button key={t.id} className={chipCls} onClick={() => applySiteTemplate(t.id)}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-6 space-y-4">
                <div>
                  <label className="mono-label block mb-1.5">PROJECT NAME</label>
                  <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div>
                  <label className="mono-label block mb-1.5">INDUSTRY</label>
                  <input
                    className="field"
                    placeholder="e.g. Specialty coffee roastery"
                    value={industry}
                    onChange={(e) => setIndustry(e.target.value)}
                  />
                </div>
                <div>
                  <label className="mono-label block mb-1.5">DESCRIBE THE WEBSITE</label>
                  <textarea
                    className="field min-h-[160px] resize-y"
                    placeholder="Who is it for, what should it say, what sections do you want, what's the vibe…"
                    value={siteBrief}
                    onChange={(e) => setSiteBrief(e.target.value)}
                  />
                </div>
              </div>

              <div className="mt-8 flex justify-end">
                <button
                  onClick={() => goStep(2)}
                  disabled={!siteBrief.trim()}
                  className="btn-primary !py-3 !px-6"
                >
                  Next: add your videos →
                </button>
              </div>

            </div>
          </div>
        )}

        {/* ══ STEP 2 · VIDEOS ══ */}
        {step === 2 && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="mx-auto w-full max-w-2xl px-6 py-10">
              <div className="flex items-center justify-between gap-4">
                <p className="mono-label !text-primary">STEP 2 · YOUR VIDEOS</p>
                <ProviderStatus />
              </div>
              <h1 className="mt-2 text-3xl font-bold tracking-tight">Add your footage</h1>
              <p className="mt-2 text-muted">
                Upload your own clips or generate them with AI. The first clip opens your site;
                add more and Claude will place them down the page.
                Each one plays the way you set it: scrubbing with the scroll, or looping on its own.
              </p>

              <div className="mt-8 space-y-4">
                {clips.map((clip, i) => (
                  <ClipCard
                    key={clip.id}
                    clip={clip}
                    index={i}
                    draft={drafts[clip.id] ?? draftFor(clip)}
                    onDraftChange={(patch) => setDraftFor(clip.id, patch)}
                    onRename={(label) => updateClip(clip.id, { label })}
                    onModeChange={(mode) => updateClip(clip.id, { mode })}
                    onGenerate={(recommendation, refresh) => generateClip(clip.id, recommendation, refresh)}
                    onUpload={(file) => uploadClip(clip.id, file)}
                    onSuggest={() => suggestShot(clip.id)}
                    onRemove={() => removeClip(clip.id)}
                    suggesting={suggestingClip === clip.id}
                    busy={busyClip !== null || uploadingClip !== null || building || editing}
                    uploading={uploadingClip === clip.id}
                    uploadProgress={uploadingClip === clip.id ? uploadProgress : null}
                    removable={clips.length > 1}
                    costLabel={costLabel}
                    pinnedShot={freeShotAvailable}
                  />
                ))}
              </div>

              {/* One slot at a time: the next square only appears when asked for. */}
              {clips.length < MAX_VIDEOS_PER_PROJECT && (
                <button
                  onClick={addClip}
                  disabled={addingClip || uploadingClip !== null || building || editing}
                  className="mt-4 w-full flex items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-4 text-sm font-medium text-muted hover:border-primary hover:text-primary transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                >
                  <span className="text-lg leading-none">+</span>
                  {addingClip ? "Adding…" : `Add ${ORDINALS[clips.length] ?? "another"} video`}
                </button>
              )}

              {/* AI generation remains an optional way to add another clip. */}
              {readyClips.length > 0 && (
                <div className="mt-6 card !rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-line bg-bg">
                    <p className="mono-label !text-primary">OR GENERATE ANOTHER VIDEO WITH AI</p>
                    <p className="mt-1 text-sm text-muted leading-relaxed">
                      {clips.length >= MAX_VIDEOS_PER_PROJECT
                        ? `You've reached the ${MAX_VIDEOS_PER_PROJECT}-video limit for one production.`
                        : "Describe what you want and I'll work out the shot and generate it. It'll appear above as it renders."}
                    </p>
                  </div>
                  {clips.length < MAX_VIDEOS_PER_PROJECT && (
                    <div className="h-[26rem] flex flex-col">
                      <div className="border-b border-line px-5 py-3 text-sm" role="status" aria-live="polite">
                        {extraVideo.recommendation ? <>
                          <p className="font-medium">Recommended: {extraModelName} · {isAdmin || freeShotAvailable ? "Free" : `${extraVideo.recommendation.cost} credits`}</p>
                          <p className="mt-1 text-xs text-muted">{extraVideo.recommendation.reason}</p>
                        </> : <p className="text-muted">{extraVideo.loading ? "Checking available video models…" : extraVideo.error ?? "Describe your next shot to get a model recommendation."}</p>}
                        {extraVideo.error && <button type="button" className="mt-2 text-primary underline" onClick={extraVideo.refresh}>Try again</button>}
                      </div>
                      <SiteChat
                        messages={shotChat}
                        draft={shotDraft}
                        onDraftChange={setShotDraft}
                        onSend={requestClip}
                        sendDisabled={!extraVideo.recommendation}
                        maxLength={2000}
                        busy={requestingClip || uploadingClip !== null || building || editing}
                        transcript=""
                        placeholder="e.g. now a slow close-up of the beans being roasted"
                        busyLabel={uploadingClip !== null ? "Finishing your footage upload…" : "Working out the shot…"}
                        emptyState="Tell me what you want to see next: “a slow pan across the workshop”, “steam rising off a fresh cup, close up”. I'll write the shot, pick how it plays, and start rendering it."
                        hint={
                          isAdmin
                            ? "Extra videos are free for admins. Enter to send, Shift+Enter for a new line."
                            : extraVideo.recommendation
                              ? `${extraVideo.recommendation.cost} credits · ${extraModel?.resolutions ? extraVideo.recommendation.resolution : "native resolution"} · ${extraVideo.recommendation.duration}s. Enter to generate.`
                              : "The recommended model and price will appear before you generate."
                        }
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="mt-8 flex items-center justify-between gap-3">
                <p className="text-xs text-faint">
                  {readyClips.length === 0
                    ? "Upload or generate at least one video to continue."
                    : `${readyClips.length} of ${clips.length} ready.`}
                </p>
                <button
                  onClick={() => goStep(3)}
                  disabled={readyClips.length === 0 || uploadingClip !== null}
                  className="btn-primary !py-3 !px-6"
                >
                  Build my website →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══ STEP 3 · BUILD ══ */}
        {step === 3 && (
          <div className="flex-1 min-h-0 flex flex-col">
            {building ? (
              // Streaming: full screen
              <div className="flex-1 flex flex-col">
                <div className="stream-bar" />
                <div className="flex-1 flex flex-col items-center justify-center p-10 gap-6">
                  {/* The character counter ticks constantly, so the live region
                      wraps only the headline and the raw stream stays silent,
                      otherwise a screen reader would never stop talking. */}
                  <p className="mono-label flex items-center gap-2" role="status" aria-live="polite">
                    <span className="rec-dot" aria-hidden /> CLAUDE IS WRITING YOUR SITE ·{" "}
                    <span aria-hidden>{streamedChars.toLocaleString()} CHARACTERS</span>
                  </p>
                  <pre
                    aria-hidden
                    className="w-full max-w-2xl h-64 overflow-hidden card !rounded-lg p-4 text-[11px] leading-relaxed text-faint whitespace-pre-wrap"
                  >
                    {streamTail || "…"}
                  </pre>
                </div>
              </div>
            ) : siteHtml ? (
              // Site ready: the real website above, the chat about it below
              <>
                <div className="flex flex-wrap items-center justify-between gap-y-2 px-4 sm:px-5 py-2.5 border-b border-line bg-bg shrink-0">
                  <p className="mono-label flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-primary" aria-hidden /> LIVE PREVIEW ·
                    SCROLL IT
                  </p>
                  <div className="flex w-full sm:w-auto items-center gap-2 overflow-x-auto sm:overflow-visible no-scrollbar">
                    <button onClick={openInNewTab} className="btn-ghost !py-1.5 !px-3 !text-xs shrink-0">
                      Open in new tab ↗
                    </button>
                    <button
                      onClick={() => runClaude()}
                      disabled={editing || building || uploadingClip !== null || !siteBrief.trim()}
                      className="btn-ghost !py-1.5 !px-3 !text-xs shrink-0"
                    >
                      Rebuild with current footage
                    </button>
                    <button
                      onClick={downloadHtml}
                      disabled={downloading}
                      className="btn-ghost !py-1.5 !px-3 !text-xs shrink-0"
                    >
                      {downloading ? "Packaging…" : "⬇ Download"}
                    </button>
                    {DEPLOY_ENABLED && (
                    <button
                      onClick={() => setDeployOpen(true)}
                      className="btn-primary !py-1.5 !px-3.5 !text-xs shrink-0"
                    >
                      {liveUrl ? "◉ Live · redeploy" : "↑ Publish live"}
                    </button>
                    )}
                  </div>
                </div>

                <div
                  ref={splitRef}
                  className={`flex-1 min-h-0 flex flex-col ${draggingSplit ? "select-none" : ""}`}
                >
                  {/* The website itself: scrollable, exactly as visitors see it. */}
                  <iframe
                    key={previewVersion}
                    srcDoc={siteHtml}
                    title="Site preview"
                    className={`w-full bg-white shrink-0 ${draggingSplit ? "pointer-events-none" : ""}`}
                    style={{ height: `${previewPct}%` }}
                    // allow-scripts only, deliberately WITHOUT allow-same-origin.
                    // Granting both together defeats the sandbox: the frame would
                    // share this origin, so generated markup could read the
                    // Supabase session from storage and call our APIs as the user.
                    // Opaque-origin still runs the scroll-scrub scripts and loads
                    // the video fine. Matches the CSP on /showcase/[id].
                    sandbox="allow-scripts"
                  />

                  {/* Drag to give the site more room, or the chat. */}
                  <div
                    onPointerDown={startDragSplit}
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Resize the preview"
                    className="group h-2 shrink-0 cursor-row-resize bg-bg border-y border-line flex items-center justify-center touch-none"
                  >
                    <span className="h-0.5 w-10 rounded-full bg-line-strong group-hover:bg-primary transition-colors" />
                  </div>

                  {/* …and the conversation about it, directly underneath. */}
                  <div className="flex-1 min-h-0">
                    <SiteChat
                      messages={chat}
                      draft={draft}
                      onDraftChange={setDraft}
                      onSend={runEdit}
                      busy={editing || uploadingClip !== null}
                      transcript={editTranscript}
                      hint={
                        isAdmin
                          ? "Edits run free for admins. Enter to send, Shift+Enter for a new line."
                          : lastEditCost !== null
                          ? `Last change cost ${lastEditCost} credits. Edits are billed by usage: small tweaks cost little, big redesigns cost more.`
                          : "Edits are billed by usage: small tweaks cost little, big redesigns cost more. Enter to send, Shift+Enter for a new line."
                      }
                    />
                  </div>
                </div>
              </>
            ) : readyClips.length === 0 ? (
              // Guard: need footage first
              <div className="flex-1 flex flex-col items-center justify-center p-10 text-center gap-5">
                <p className="text-6xl" aria-hidden>
                  🎬
                </p>
                <p className="text-2xl font-bold">Add a video first</p>
                <p className="text-muted max-w-sm">
                  Claude builds the whole site around your footage. Upload your own video or
                  generate one with AI to get started.
                </p>
                <button onClick={() => goStep(2)} className="btn-primary !py-3 !px-6">
                  ← Back to the videos
                </button>
              </div>
            ) : (
              // Ready to build
              <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="mx-auto w-full max-w-2xl px-6 py-10">
                  <p className="mono-label !text-primary">STEP 3 · BUILD THE WEBSITE</p>
                  <h1 className="mt-2 text-3xl font-bold tracking-tight">Build your website</h1>
                  <p className="mt-2 text-muted">
                    Claude writes the whole site around your footage and streams it live. When
                    it&apos;s done you&apos;ll see the real site here and can chat about changes
                    underneath it.
                  </p>

                  <div className="mt-8 rounded-lg border border-line p-4">
                    <p className="mono-label mb-2">GOING IN ({readyClips.length})</p>
                    <ul className="space-y-1.5">
                      {readyClips.map((c, i) => (
                        <li key={c.id} className="flex items-center gap-2 text-sm">
                          <span className="mono-label !text-primary shrink-0">
                            {i === 0 ? "HERO" : `CLIP ${i + 1}`}
                          </span>
                          <span className="truncate flex-1">{c.label}</span>
                          <span className="text-xs text-faint shrink-0">
                            {c.mode === "scrub" ? "scrolls" : "loops"}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {clips.length > readyClips.length && (
                      <p className="mt-2 text-xs text-faint">
                        {clips.length - readyClips.length} clip
                        {clips.length - readyClips.length === 1 ? " is" : "s are"} not ready and
                        won&apos;t be included.
                      </p>
                    )}
                  </div>

                  <div className="mt-6 rounded-lg border border-line">
                    <button
                      type="button"
                      onClick={() => setShowBuildAdvanced((v) => !v)}
                      className="w-full flex items-center justify-between px-3 py-2.5 text-left"
                    >
                      <span className="mono-label">ADVANCED · {MODELS[model].label}</span>
                      <span className="text-faint text-xs">{showBuildAdvanced ? "▲" : "▾"}</span>
                    </button>
                    {showBuildAdvanced && (
                      <div className="px-3 pb-3 space-y-4">
                        <div>
                          <label className="mono-label block mb-1.5">WHO WRITES YOUR SITE?</label>
                          <Select
                            value={model}
                            onChange={setModel}
                            disabled={freeBuild}
                            ariaLabel="Who writes your site"
                            groups={[
                              {
                                options: (Object.keys(MODELS) as ModelId[]).map((id) => ({
                                  value: id,
                                  label: MODELS[id].label,
                                  description: MODELS[id].blurb,
                                  meta: `up to ${estimateBuildCredits(id).hold} cr`,
                                })),
                              },
                            ]}
                          />
                          <p className="mt-1.5 text-xs text-faint">
                            {freeBuild
                              ? `Your free build is written by ${MODELS[FREE_TIER.siteModel].label}. Choosing who writes your site is part of a plan.`
                              : "Better models design better sites and cost more credits. Opus is the sweet spot."}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => runClaude()}
                    disabled={building || uploadingClip !== null || readyClips.length === 0 || !siteBrief.trim()}
                    className="btn-primary w-full !py-4 mt-6"
                  >
                    Build my website ·{" "}
                    {isAdmin || freeBuild ? "Free" : `up to ${claudeCost} credits`}
                  </button>
                  <p className="mt-2 text-xs text-faint text-center">
                    Streams live, usually 1–3 minutes.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <DeployPanel
        open={deployOpen}
        onClose={() => setDeployOpen(false)}
        projectId={project.id}
        projectName={name}
        plan={plan}
        liveUrl={liveUrl}
        supabaseRef={project.supabase_project_ref}
        onLive={setLiveUrl}
      />
    </div>
  );
}
