import Link from "next/link";
import { PLANS } from "@/lib/pricing";
import { SiteFooter } from "@/components/SiteFooter";
import { LandingNav } from "@/components/LandingNav";
import { HeroScrub } from "@/components/HeroScrub";
import { Reveal } from "@/components/Reveal";
import { ReferenceReel } from "@/components/ReferenceReel";
import { ScrubPreview } from "@/components/ScrubPreview";
import { AmbientVideo } from "@/components/AmbientVideo";
import { faqJsonLd, JsonLd } from "@/lib/seo";

const FAQS = [
  {
    q: "What exactly do I get?",
    a: "A complete, responsive single-file website built around your own footage or an AI-generated video, with copy written for your business. Preview it live, keep iterating with Claude, then download a zip with the HTML page and all your clips, ready to host anywhere.",
  },
  {
    q: "Can I upload my own footage?",
    a: "Yes. Upload MP4, MOV or WebM clips up to 50 MB and 60 seconds when creating a website or adding videos in the studio. Use them as ambient loops or scroll-controlled videos. Uploads cost no video credits; website builds and edits follow your usual plan and credit limits.",
  },
  {
    q: "What if I don't like the video?",
    a: "You see the footage before building. Replace it with another clip of your own, or generate a new take with AI, then build once you're happy. Failed AI generations are automatically refunded.",
  },
  {
    q: "How do credits work?",
    a: "Uploading your footage uses no video credits. AI video generation and Claude builds show their credit price before you click. Subscriptions refill monthly; subscribers can buy top-up credits, which never expire. New accounts get one complete website free (a hero video and a full build), then pick a plan to keep iterating.",
  },
  {
    q: "Can I change the site after it's built?",
    a: "Yes. Keep prompting Claude for edits (“darker palette, add testimonials”), or upload replacement footage and tell Claude to swap it in. You can also generate a new video with AI. Site changes stream into the live preview.",
  },
];

// Each step is illustrated by real generated footage rather than a colour field.
const FEATURES = [
  {
    badge: "STEP 01",
    title: "Start with your footage",
    body: "Upload your own MP4, MOV or WebM clips, or describe a shot and generate it with AI. Preview your footage in the studio, then choose how it plays.",
    video: "/ReferenceVids/hf_20260616_211244_e8668434-14ae-41be-8a46-92a921c7736c.mp4",
    tag: "VIDEO",
  },
  {
    badge: "STEP 02",
    title: "Send it to Claude",
    body: "Pick your model, from fast Haiku drafts to Opus 4.8 flagship builds. Claude writes a complete, responsive site around your footage, streamed live into the preview.",
    video: "/ReferenceVids/hf_20260615_235620_4bf5ef7e-46f2-48c2-bb68-db1bf39f38ef.mp4",
    tag: "CLAUDE",
  },
  {
    badge: "STEP 03",
    title: "Loop it or scrub it",
    body: "Choose ambient loop playback, or cinematic scroll-scrubbing where the video plays forward as visitors scroll. Then download a zip (the HTML page plus your hero video) and host it anywhere.",
    video: "/ReferenceVids/hf_20260618_011147_3cf1fbd4-6e55-40ca-9ca0-a7a96ef16a19.mp4",
    tag: "SHIP",
  },
];

const CAPABILITIES = [
  { title: "Frontier video models", body: "Kling, Hailuo, Sora, Seedance and more.", badge: "Video" },
  { title: "Opus · Sonnet · Haiku", body: "Three Claude models, your call.", badge: "Build" },
  { title: "Loop & scroll-scrub", body: "Two premium playback modes.", badge: "Motion" },
  { title: "Zip export", body: "HTML + your video, host anywhere.", badge: "Own it" },
];

export default function Home() {
  return (
    <div className="flex flex-col min-h-screen">
      <LandingNav />

      <main id="main" className="flex-1">
        {/* Same Q&A the FAQ section renders below. Keep them in sync or the
            rich result will disagree with the page. */}
        <JsonLd data={faqJsonLd(FAQS)} />
        {/* ── Hero: scroll-scrubbed video ──────────────────────────── */}
        <HeroScrub />

        {/* ── Product mockup: scrubs as you scroll ─────────────────── */}
        <ScrubPreview />

        {/* ── Everything you need ───────────────────────────────────── */}
        <section className="px-6 py-24 md:py-32 max-w-6xl mx-auto">
          <Reveal>
            <h2 className="text-center text-4xl md:text-6xl font-bold tracking-tight leading-[1.05]">
              Everything you need,
              <br />
              <span className="text-faint">in three steps.</span>
            </h2>
          </Reveal>

          <div className="mt-14 grid md:grid-cols-3 gap-5">
            {FEATURES.map((f, i) => (
              <Reveal key={f.title} delay={i * 90}>
                <div className="h-full rounded-3xl border border-line bg-bg-raise p-3 hover:shadow-[var(--shadow-lift)] transition-shadow">
                  <div
                    className="relative aspect-[16/10] rounded-2xl overflow-hidden bg-ink"
                    aria-hidden
                  >
                    <AmbientVideo
                      src={f.video}
                      overlay="linear-gradient(160deg, rgba(36,20,16,0.35) 0%, rgba(36,20,16,0.05) 45%, rgba(36,20,16,0.35) 100%)"
                    />
                    <span className="absolute top-3 left-3 rounded-full bg-white/15 border border-white/25 px-3 py-1 text-[0.65rem] font-bold tracking-widest text-white backdrop-blur-sm">
                      {f.tag}
                    </span>
                  </div>
                  <div className="p-4">
                    <p className="mono-label !text-primary">{f.badge}</p>
                    <h3 className="mt-2 text-2xl font-semibold tracking-tight">{f.title}</h3>
                    <p className="mt-2 text-muted leading-relaxed">{f.body}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>

          {/* Capability chips */}
          <div className="mt-5 grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {CAPABILITIES.map((c, i) => (
              <Reveal key={c.title} delay={i * 70}>
                <div className="h-full rounded-2xl border border-line bg-bg p-6">
                  <div className="flex items-start justify-between gap-3">
                    <h4 className="text-lg font-semibold tracking-tight">{c.title}</h4>
                    <span className="shrink-0 rounded-full bg-primary-soft/60 px-2.5 py-1 text-[0.65rem] font-bold tracking-wider text-primary-deep">
                      {c.badge}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-muted leading-relaxed">{c.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ── Studio feature band: sunset + grid floor ─────────────── */}
        <section className="px-4 md:px-6 max-w-6xl mx-auto">
          <Reveal>
            <div className="sky-band grid-floor rounded-[2.5rem] md:rounded-[3rem] overflow-hidden px-6 py-20 md:py-28 text-center">
              <AmbientVideo
                src="/ReferenceVids/hf_20260615_225317_b48e0bba-4995-4516-84a6-50ebb3d972a8.mp4"
                overlay="linear-gradient(180deg, rgba(216,69,31,0.66) 0%, rgba(176,50,22,0.58) 45%, rgba(42,26,19,0.68) 100%)"
              />
              <div className="relative">
                <p className="text-xs font-bold tracking-[0.2em] text-white/70">THE STUDIO</p>
                <h2 className="mt-4 text-white font-bold tracking-tight text-4xl md:text-6xl leading-[1.02]">
                  One screen. Three steps.
                  <br />
                  Camera to live site.
                </h2>
                <p className="mx-auto mt-5 max-w-xl text-lg text-white/90 leading-relaxed">
                  Brief, video, build: each step takes over the whole screen. Upload your footage
                  or generate a video, preview the finished site, and download it in a click.
                </p>
                <div className="mt-8 flex justify-center">
                  <Link
                    href="/create"
                    className="group inline-flex items-center gap-3 rounded-full bg-white px-6 py-3 text-base font-semibold text-ink shadow-[0_8px_24px_rgba(0,0,0,0.18)] hover:bg-white/90 transition-colors"
                  >
                    Start building
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white transition-transform group-hover:translate-x-0.5">
                      →
                    </span>
                  </Link>
                </div>

                <div className="mx-auto mt-12 grid max-w-3xl grid-cols-2 gap-3 md:grid-cols-4">
                  {[
                    ["~2 min", "idea to first cut"],
                    ["3 models", "Haiku to Opus"],
                    ["1 site", "free on signup"],
                    ["1 file", "host anywhere"],
                  ].map(([stat, label]) => (
                    <div
                      key={label}
                      className="rounded-2xl border border-white/25 bg-white/12 px-4 py-5 backdrop-blur-sm"
                    >
                      <p className="text-2xl md:text-3xl font-bold text-white">{stat}</p>
                      <p className="mt-1 text-[0.7rem] font-bold uppercase tracking-wider text-white/70">
                        {label}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        {/* ── Showcase reel ─────────────────────────────────────────── */}
        <div className="mt-24 md:mt-32">
          <ReferenceReel
            eyebrow="MADE WITH REELFORM"
            title="Footage our users put on their sites"
            action={
              <Link
                href="/showcase"
                className="inline-flex items-center gap-2 rounded-full bg-white/10 border border-white/25 px-5 py-2.5 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
              >
                See finished sites in the showcase →
              </Link>
            }
          />
        </div>

        {/* ── FAQ ───────────────────────────────────────────────────── */}
        <section className="px-6 py-24 md:py-32 max-w-3xl mx-auto w-full">
          <Reveal>
            <h2 className="text-center text-4xl md:text-6xl font-bold tracking-tight leading-[1.05]">
              Frequently asked
              <br />
              <span className="text-faint">questions.</span>
            </h2>
          </Reveal>
          <div className="mt-12 space-y-3">
            {FAQS.map((f, i) => (
              <Reveal key={f.q} delay={i * 60}>
                <details className="group rounded-2xl border border-line bg-bg-raise open:bg-bg open:shadow-[var(--shadow-lift)] transition-colors">
                  <summary className="flex items-center justify-between cursor-pointer list-none px-6 py-5 text-lg font-semibold">
                    {f.q}
                    <span
                      className="ml-4 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line-strong text-faint transition-transform group-open:rotate-45"
                      aria-hidden
                    >
                      +
                    </span>
                  </summary>
                  <p className="px-6 pb-6 -mt-1 text-muted leading-relaxed">{f.a}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ── Final CTA: big rounded sunset card ───────────────────── */}
        <section className="px-4 md:px-6 pb-24 max-w-6xl mx-auto">
          <Reveal>
            <div className="sky-band grid-floor rounded-[2.5rem] md:rounded-[3rem] overflow-hidden px-8 py-20 md:px-16 md:py-24">
              <AmbientVideo
                src="/ReferenceVids/hf_20260616_205611_e9059dab-3079-4920-81fe-cbaf7062dd6a.mp4"
                overlay="linear-gradient(110deg, rgba(216,69,31,0.82) 0%, rgba(196,58,26,0.62) 55%, rgba(42,26,19,0.55) 100%)"
              />
              <div className="relative max-w-xl">
                <p className="text-xs font-bold tracking-[0.2em] text-white/70">
                  FAIR, CREDIT-BASED PRICING
                </p>
                <h2 className="mt-4 text-white font-bold tracking-tight text-4xl md:text-6xl leading-[1.02]">
                  Where ideas become sites that move.
                </h2>
                <p className="mt-5 text-lg text-white/90 leading-relaxed">
                  Plans from ${PLANS[0].priceUsd}/mo, subscribers top up anytime, unused credits never expire.
                  Your first website is free: one hero video and a full build, no card needed.
                </p>
                <div className="mt-8 flex flex-wrap gap-3">
                  <Link
                    href="/create"
                    className="rounded-full bg-white px-7 py-3.5 text-base font-semibold text-ink shadow-[0_8px_24px_rgba(0,0,0,0.18)] hover:bg-white/90 transition-colors"
                  >
                    Start building
                  </Link>
                  <Link
                    href="/pricing"
                    className="rounded-full border border-white/60 px-7 py-3.5 text-base font-semibold text-white hover:bg-white/10 transition-colors"
                  >
                    View plans
                  </Link>
                </div>
              </div>
            </div>
          </Reveal>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
