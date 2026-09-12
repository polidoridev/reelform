"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { DEFAULT_VIDEO_MODEL } from "@/lib/higgsfield";
import { ShotControls, type ShotSettings } from "@/components/ShotControls";
import { DEFAULT_MODEL } from "@/lib/pricing";
import { trackEvent } from "@/lib/analytics";
import ProviderStatus from "@/components/ProviderStatus";
import FootageUpload from "@/components/FootageUpload";
import { uploadFootage } from "@/lib/upload-footage";
import { useVideoRecommendation } from "@/lib/use-video-recommendation";

type Mode = "scrub" | "loop";
type Stage = "format" | "brief" | "building";

const FORMATS: { id: Mode; title: string; tagline: string; desc: string }[] = [
  {
    id: "scrub",
    title: "Scrub website",
    tagline: "Scrolling plays the video",
    desc:
      "Your scroll wheel becomes the play button. Scroll down and the footage advances frame by frame; scroll up and it rewinds. The video never plays on its own; the visitor drives it, so the page feels like something they're operating rather than watching. Best for reveals, product shots and anything where the motion is the story.",
  },
  {
    id: "loop",
    title: "Looping video",
    tagline: "Plays by itself, on repeat",
    desc:
      "The footage runs continuously behind your hero section like a moving background, muted and seamless. Nothing for the visitor to do. Best for mood, atmosphere and brand sites where the video sets a tone rather than carrying information.",
  },
];

// Rough wall-clock for the whole run, used only to pace the progress copy.
const AI_STEPS = ["Setting up your project", "Writing the shot", "Rendering the video", "Building the site"];
const UPLOAD_STEPS = ["Setting up your project", "Uploading your footage", "Preparing smooth playback", "Building the site"];

function nameFrom(brief: string): string {
  const words = brief.trim().split(/\s+/).slice(0, 5).join(" ");
  return words.length > 2 ? words.slice(0, 60) : "My website";
}

export function CreateFlow({
  isFirstBuild,
  isAdmin = false,
  pinnedShot = false,
}: {
  isFirstBuild: boolean;
  isAdmin?: boolean;
  /** The free hero shot runs on a fixed preset; see ShotControls. */
  pinnedShot?: boolean;
}) {
  const router = useRouter();
  const [freeShotAvailable, setFreeShotAvailable] = useState(pinnedShot);
  const [stage, setStage] = useState<Stage>("format");
  const [mode, setMode] = useState<Mode>("scrub");
  const [brief, setBrief] = useState("");
  const [source, setSource] = useState<"upload" | "ai">("upload");
  const [footage, setFootage] = useState<File | null>(null);
  const [project, setProject] = useState<{ id: string; heroVideoId: string } | null>(null);
  const readySource = useRef<File | string | null>(null);
  const pendingAI = useRef<string | null>(null);
  const [shot, setShot] = useState<ShotSettings>({
    model: DEFAULT_VIDEO_MODEL,
    resolution: "720p",
    duration: 5,
    ratio: "16:9",
  });

  const videoRecommendation = useVideoRecommendation(brief, shot, freeShotAvailable, source === "ai");

  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState(false);

  const fail = useCallback((message: string, needsPlan = false) => {
    setError(message);
    setUpgrade(needsPlan);
    setStage("brief");
  }, []);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!brief.trim() || (source === "upload" && !footage) || (source === "ai" && !videoRecommendation.recommendation)) return;
    setError(null);
    setUpgrade(false);
    setStage("building");
    setStep(0);

    try {
      // Retain the project after a failed upload/build, so a free account can
      // retry in place instead of being asked to create a second project.
      let currentProject = project;
      if (!currentProject) {
        const projectRes = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: nameFrom(brief), videoMode: mode }),
        });
        const created = await projectRes.json();
        if (!projectRes.ok || !created.id || !created.heroVideoId) {
          return fail(created.message ?? created.error ?? "Could not start the project.", projectRes.status === 402);
        }
        currentProject = { id: created.id, heroVideoId: created.heroVideoId };
        setProject(currentProject);
        trackEvent("project_created", { videoMode: mode, via: "create_flow", videoSource: source });
      } else {
        const modeRes = await fetch("/api/videos", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId: currentProject.heroVideoId, mode }),
        });
        if (!modeRes.ok) return fail("Could not update the playback mode. Please try again.");
      }

      const recommended = videoRecommendation.recommendation;
      const sourceKey = source === "upload" ? footage : JSON.stringify({ brief, shot });
      if (source === "upload" && footage) {
        if (readySource.current !== footage) {
          setStep(1);
          await uploadFootage(currentProject.heroVideoId, footage, (progress) => {
            setStep(progress === 100 ? 2 : 1);
          });
          readySource.current = footage;
          pendingAI.current = null;
        }
      } else if (readySource.current !== sourceKey) {
        if (!pendingAI.current) {
          setStep(1);
          const shotRes = await fetch("/api/site/suggest-shot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: nameFrom(brief), siteBrief: brief, role: "Hero video" }),
          });
          const suggestion = await shotRes.json();
          const prompt: string = suggestion.prompt?.trim() || brief.trim();

          setStep(2);
          const videoRes = await fetch("/api/video/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              videoId: currentProject.heroVideoId, prompt,
              ...recommended,
              recommendationPrompt: brief,
              recommendationSettings: { resolution: shot.resolution, duration: shot.duration, ratio: shot.ratio },
            }),
          });
          const video = await videoRes.json();
          if (!videoRes.ok) {
            if (videoRes.status === 409 || videoRes.status === 503) videoRecommendation.refresh();
            return fail(video.message ?? video.error ?? "Could not start the video.", videoRes.status === 402);
          }
          if (video.settings?.free) setFreeShotAvailable(false);
          readySource.current = null;
          pendingAI.current = sourceKey as string;
        }

        setStep(2);
        const deadline = Date.now() + 10 * 60 * 1000;
        let status = "queued";
        while (status !== "succeeded") {
          if (Date.now() > deadline) {
            return fail("The video is taking unusually long. It's still rendering; open your project to check its progress.");
          }
          await new Promise((resolve) => setTimeout(resolve, 10000));
          const res = await fetch(`/api/video/status?videoId=${currentProject.heroVideoId}`);
          const data = await res.json();
          if (!res.ok) return fail(data.error ?? "Could not check the video. Please try again.");
          status = data.status;
          if (status === "failed") {
            pendingAI.current = null;
            if (pinnedShot) setFreeShotAvailable(true);
            return fail(data.error ?? "The video failed to render. Nothing was charged, so try again.");
          }
        }
        readySource.current = pendingAI.current;
        pendingAI.current = null;
        if (readySource.current !== sourceKey) {
          return fail("Your previous video is ready. Open your saved project to use it, or try again to generate your revised shot.");
        }
      }

      // 4. Hand the footage to Claude and let it build the page.
      setStep(3);
      const siteRes = await fetch("/api/site/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: currentProject.id,
          mode: "create",
          model: DEFAULT_MODEL,
          name: nameFrom(brief),
          siteBrief: brief,
        }),
      });
      if (!siteRes.ok) {
        const data = await siteRes.json().catch(() => ({}));
        return fail(
          data.message ?? data.error ?? "Could not build the site.",
          siteRes.status === 402
        );
      }
      // The build streams; we only need it to finish before showing the studio.
      const reader = siteRes.body?.getReader();
      if (!reader) return fail("The site build did not start. Please try again.");
      const decoder = new TextDecoder();
      let result = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      result += decoder.decode();
      const sentinel = "\n<<<REELFORM_ERROR>>>";
      if (result.includes(sentinel)) return fail(result.split(sentinel)[1].trim());
      if (!result.trim()) return fail("The site build returned an empty page. Please try again.");

      trackEvent("site_build_completed", { via: "create_flow", videoMode: mode });
      router.push(`/studio/${currentProject.id}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : "Connection interrupted. Your project is saved; please try again.");
    }
  }

  // ── Stage 1: how the video behaves ────────────────────────────────
  if (stage === "format") {
    return (
      <div>
        <p className="mono-label">STEP 1 OF 2</p>
        <h1 className="mt-2 text-4xl md:text-5xl font-medium tracking-tight">
          How should your video play?
        </h1>
        <p className="mt-3 text-muted leading-relaxed max-w-2xl">
          This shapes the whole page, so it&apos;s the one thing worth deciding first. You can
          change it later in the studio.
        </p>

        <div className="mt-8 grid md:grid-cols-2 gap-4">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setMode(f.id);
                setStage("brief");
              }}
              className="card text-left p-6 transition-colors hover:border-primary hover:bg-primary-soft/20 focus-visible:border-primary"
            >
              <p className="mono-label">{f.tagline}</p>
              <p className="mt-2 text-xl font-semibold">{f.title}</p>
              <p className="mt-3 text-sm text-muted leading-relaxed">{f.desc}</p>
              <span className="mt-5 inline-block text-sm font-medium text-primary">
                Choose this →
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Stage 3: the run ──────────────────────────────────────────────
  if (stage === "building") {
    return (
      <div className="max-w-xl">
        <p className="mono-label">{source === "upload" ? "USING YOUR FOOTAGE" : "NOW SHOOTING"}</p>
        <h1 className="mt-2 text-4xl font-medium tracking-tight">Building your website</h1>
        <p className="mt-3 text-muted leading-relaxed">
          {source === "upload" ? "We’ll prepare your footage, then Claude will build the website around it. Keep this tab open." : "This takes a couple of minutes, most of it waiting on the video. Keep this tab open."}
        </p>
        <ol className="mt-8 space-y-3">
          {(source === "upload" ? UPLOAD_STEPS : AI_STEPS).map((label, i) => (
            <li key={label} className="flex items-center gap-3 text-sm">
              <span
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-xs ${
                  i < step
                    ? "bg-primary text-white"
                    : i === step
                      ? "bg-primary-soft text-primary-deep"
                      : "bg-bg-raise text-faint"
                }`}
                aria-hidden
              >
                {i < step ? "✓" : i + 1}
              </span>
              <span className={i <= step ? "text-ink" : "text-faint"}>{label}</span>
              {i === step && <span className="rec-dot ml-1" aria-hidden />}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  // ── Stage 2: the brief, plus the shot controls ────────────────────
  return (
    <form onSubmit={run}>
      <button
        type="button"
        onClick={() => setStage("format")}
        className="mono-label hover:!text-ink transition-colors"
      >
        ← {mode === "scrub" ? "Scrub website" : "Looping video"}
      </button>
      <h1 className="mt-3 text-4xl md:text-5xl font-medium tracking-tight">
        Describe your website
      </h1>
      <p className="mt-3 text-muted leading-relaxed max-w-2xl">
        Say what the business is and how it should feel. Choose your own footage or generate a
        video, and Claude will build the website around it.
      </p>

      <fieldset className="mt-8">
        <legend className="mono-label">YOUR VIDEO</legend>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {(["upload", "ai"] as const).map((option) => (
            <label key={option} className={`card cursor-pointer p-4 text-sm ${source === option ? "border-primary bg-primary-soft/20" : ""}`}>
              <span className="flex items-center gap-2 font-medium">
                <input type="radio" name="video-source" value={option} checked={source === option} onChange={() => setSource(option)} className="accent-primary" />
                {option === "upload" ? "Use my footage" : "Generate with AI"}
              </span>
              <span className="mt-2 block text-xs leading-relaxed text-muted">{option === "upload" ? "Bring a clip you already have." : "Describe the shot and let AI create it."}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {source === "upload" && <div className="mt-4"><FootageUpload file={footage} onSelect={setFootage} /></div>}

      <div className="mt-6 card p-2">
        <textarea
          className="w-full resize-none bg-transparent px-4 py-3 text-base leading-relaxed outline-none placeholder:text-faint"
          rows={5}
          aria-label="Describe your website"
          autoFocus
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="A specialty coffee roastery in Lisbon. Warm, unhurried, a bit industrial. Needs a menu, our story, and a way to book a tasting."
        />
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line px-4 py-3">
          <p className="text-xs text-faint">
            {isFirstBuild
              ? "Your first website is free, no card needed."
              : "Building another site uses your plan's credits."}
          </p>
          <button type="submit" disabled={!brief.trim() || (source === "upload" && !footage) || (source === "ai" && !videoRecommendation.recommendation)} className="btn-primary shrink-0">
            Build my website
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 card border-danger/40 bg-danger/5 p-4 text-sm">
          <p role="alert" className="text-danger">{error}</p>
          {project && <Link href={`/studio/${project.id}`} className="mt-3 block text-primary underline">Open your saved project →</Link>}
          {upgrade && (
            <Link href="/pricing" className="mt-3 inline-block btn-primary !py-2 !px-4 text-sm">
              See plans →
            </Link>
          )}
        </div>
      )}

      {source === "ai" && <>
      {/* Shot controls, deliberately below the brief: sensible defaults mean
          most people never touch them. The price of the shot they describe is
          right here, so nobody has to guess before pressing generate. */}
      <div className="mt-8 flex items-center justify-between gap-4">
        <p className="mono-label">RECOMMENDED FOR YOUR PROMPT</p>
        <ProviderStatus />
      </div>
      <ShotControls
        className="mt-3"
        value={shot}
        onChange={(patch) => setShot((s) => ({ ...s, ...patch }))}
        recommendation={videoRecommendation.recommendation}
        recommendationLoading={videoRecommendation.loading}
        recommendationError={videoRecommendation.error}
        onRetry={videoRecommendation.refresh}
        pinned={freeShotAvailable}
        costLabel={(credits) => isAdmin || freeShotAvailable ? "Free" : `${credits} credits`}
      />
      </>}
    </form>
  );
}
