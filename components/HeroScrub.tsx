"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  createScrollScrubber,
  canScrub,
  loadScrubSource,
  playSafely,
  prefersStill,
  primeForSeeking,
  scrubSource,
  LOOP_SRC,
  SCRUB_POSTER,
} from "@/lib/video";

// Full-screen hero whose background video scrubs frame-by-frame with scroll.
// The overlaid text fades and rises away past a threshold, then the pinned
// stage releases and the rest of the page flows underneath.
//
// Phones scrub too, on a smaller all-intra encode: the thing that used to make
// scrubbing stutter there was seeking into a half-downloaded file, not the
// hardware. So the clip is fetched whole before a single seek is issued, and
// the poster covers the element until it lands (see loadScrubSource).
export function HeroScrub() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const cueRef = useRef<HTMLDivElement>(null);
  // Undecided until the effect measures the device: rendering no source on the
  // server keeps us from shipping a scrub encode to someone on Save-Data.
  const [scrubbing, setScrubbing] = useState<boolean | null>(null);
  // The clip is in memory and seeking is instant. Until then the poster shows,
  // so nobody scrolls through the laggy first second of a streaming seek.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const wrap = wrapRef.current;
    const video = videoRef.current;
    const text = textRef.current;
    if (!wrap || !video || !text) return;

    // Scroll-driven scrubbing and the parallax text exit are both motion the
    // visitor didn't ask for. Under prefers-reduced-motion we hold a single
    // representative frame and fade the copy without moving, scaling or
    // blurring it. The hero still reads, it just stops animating.
    const stillOnly = prefersStill();
    const scrub = !stillOnly && canScrub();
    setScrubbing(scrub);

    // The element has a frame to show: cross-fade it in over the poster. In
    // scrub mode this can only fire after the buffered clip is attached, which
    // is exactly when scrubbing becomes instant. It also waits on the seek
    // priming below, so the reveal never catches the prime's play/pause mid
    // "play" and shows a stray frame of motion.
    let loadedData = false;
    let primed = !scrub;
    const revealIfReady = () => {
      if (loadedData && primed) setReady(true);
    };
    const onLoaded = () => {
      loadedData = true;
      revealIfReady();
    };
    video.addEventListener("loadeddata", onLoaded, { once: true });

    let cancelled = false;

    if (scrub) {
      loadScrubSource(scrubSource()).then((src) => {
        if (cancelled) return;
        video.src = src;
        video.load();
        primeForSeeking(video).then(() => {
          if (cancelled) return;
          primed = true;
          revealIfReady();
        });
      });
    } else if (!stillOnly) {
      // Save-Data / 2G: a small ordinary loop rather than a scrub encode.
      video.src = LOOP_SRC;
      video.load();
      video.loop = true;
      playSafely(video);
    }
    // Under prefers-reduced-motion no video loads at all. The poster behind the
    // element is the hero, which is both the honest reading of the preference
    // and megabytes we don't spend to show a still frame.

    const stop = createScrollScrubber({
      wrap,
      video,
      scrub,
      onProgress: (progress) => {
        // Text leaves between 40% and 72% of the hero scroll.
        const exit = Math.min(Math.max((progress - 0.4) / 0.32, 0), 1);
        text.style.opacity = String(1 - exit);
        if (!stillOnly) {
          text.style.transform = `translateY(${-exit * 48}px) scale(${1 - exit * 0.04})`;
          text.style.filter = `blur(${exit * 5}px)`;
        }
        text.style.pointerEvents = exit > 0.6 ? "none" : "auto";

        if (cueRef.current) {
          cueRef.current.style.opacity = String(1 - Math.min(progress / 0.08, 1));
        }
      },
    });

    return () => {
      cancelled = true;
      video.removeEventListener("loadeddata", onLoaded);
      stop();
    };
  }, []);

  return (
    <section
      ref={wrapRef}
      className={`relative ${
        scrubbing === false ? "h-[150svh]" : "h-[200vh] md:h-[240vh]"
      }`}
    >
      {/* The poster sits on the stage, not just on the <video>, so the clip can
          cross-fade in over it once it's buffered instead of popping. */}
      <div
        className="sticky top-0 h-[100svh] w-full overflow-hidden bg-ink bg-cover bg-center"
        style={{ backgroundImage: `url(${SCRUB_POSTER})` }}
      >
        <video
          ref={videoRef}
          poster={SCRUB_POSTER}
          muted
          playsInline
          preload="none"
          disablePictureInPicture
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
            ready ? "opacity-100" : "opacity-0"
          }`}
        />
        {/* Sunset-tinted legibility scrim + vignette */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(115% 80% at 50% 38%, rgba(42,26,19,0.18), rgba(42,26,19,0.62) 100%), linear-gradient(180deg, rgba(221,79,38,0.28) 0%, rgba(42,26,19,0.30) 55%, rgba(42,26,19,0.55) 100%)",
          }}
        />

        {/* Hero copy: fades/rises away on scroll */}
        <div
          ref={textRef}
          className="relative z-10 flex h-full flex-col items-center justify-center px-6 text-center"
        >
          {/* On a short phone screen the whole block is taller than the
              viewport, and this eyebrow is the line the hero can spare. */}
          <span className="hidden [@media(min-height:620px)]:inline-flex items-center gap-2 rounded-full border border-white/40 bg-white/15 px-4 py-1.5 text-[0.7rem] sm:text-xs font-semibold tracking-wide text-white backdrop-blur-sm">
            <span className="rec-dot" aria-hidden /> AI VIDEO-FIRST WEBSITES
          </span>
          <h1 className="mt-0 [@media(min-height:620px)]:mt-7 max-w-4xl text-white font-bold tracking-tight text-[2.25rem] min-[380px]:text-[2.75rem] sm:text-6xl md:text-8xl leading-[0.98] [text-shadow:0_2px_30px_rgba(0,0,0,0.35)]">
            Websites that
            <br />
            move people.
          </h1>
          <p className="mx-auto mt-4 sm:mt-7 max-w-xl text-[0.95rem] min-[380px]:text-base sm:text-lg md:text-xl text-white/90 leading-relaxed [text-shadow:0_1px_12px_rgba(0,0,0,0.4)]">
            Upload your own footage or generate a cinematic video with AI. Claude builds your
            whole site around it: looping, or playing frame by frame as visitors scroll.
          </p>
          <div className="mt-6 sm:mt-9 flex w-full max-w-sm sm:max-w-none flex-col sm:flex-row flex-wrap items-stretch sm:items-center justify-center gap-3">
            <Link
              href="/create"
              className="rounded-full bg-white px-7 py-3.5 text-center text-base font-semibold text-ink shadow-[0_8px_24px_rgba(0,0,0,0.28)] hover:bg-white/90 transition-colors"
            >
              Start building · first site free
            </Link>
            <Link
              href="/pricing"
              className="rounded-full border border-white/60 px-7 py-3.5 text-center text-base font-semibold text-white hover:bg-white/10 transition-colors"
            >
              See pricing
            </Link>
          </div>
        </div>

        {/* Scroll cue */}
        <div
          ref={cueRef}
          className="scroll-cue absolute inset-x-0 bottom-7 z-10 hidden [@media(min-height:620px)]:flex flex-col items-center gap-2 text-white/80"
        >
          <span className="text-[0.7rem] font-bold uppercase tracking-[0.2em]">Scroll</span>
          <span aria-hidden className="text-lg leading-none">
            ↓
          </span>
        </div>
      </div>
    </section>
  );
}
