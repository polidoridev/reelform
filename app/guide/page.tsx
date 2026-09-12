import Link from "next/link";
import { LegalShell, LegalSection } from "@/components/LegalShell";
import { pageMeta } from "@/lib/seo";
import { MODELS, estimateBuildCredits, videoCost, type ModelId } from "@/lib/pricing";
import { DEFAULT_VIDEO_MODEL } from "@/lib/higgsfield";
import { CONTACT_EMAIL } from "@/lib/contact";

export const metadata = pageMeta({
  title: "Guide",
  description:
    "How to get a good result out of Reelform: write a brief, upload your footage or generate a shot, choose loop or scrub, and ship the finished site.",
  path: "/guide",
});

export default function GuidePage() {
  return (
    <LegalShell label="GETTING STARTED" title="How to get a good result">
      <p className="text-lg text-muted leading-relaxed">
        Start with a clear brief and footage that shows what makes your business yours.
        Bring a clip you already have or generate one, then build and refine your site.
      </p>

      <LegalSection heading="1. Write a brief Claude can build from">
        <p>
          The brief is the only thing Claude knows about your business. Vague briefs produce
          generic sites, so name the specifics: who the visitor is, what you want them to do, and
          the one thing that makes you different.
        </p>
        <p>
          <strong className="text-ink">Weak:</strong> &ldquo;A website for my coffee shop.&rdquo;
        </p>
        <p>
          <strong className="text-ink">Strong:</strong> &ldquo;Single-origin roastery in Trieste,
          open since 2019. Visitors are locals looking for a weekend sit-down and wholesale buyers
          looking for a supplier. Main action: book a tasting. Tone: warm, unfussy, a bit
          industrial. Sections: hero, our roast, tasting bookings, wholesale enquiry,
          visit us.&rdquo;
        </p>
        <p>
          You don&apos;t need to get it perfect. Anything you miss you can add later by chat, and
          the site rebuilds around it.
        </p>
      </LegalSection>

      <LegalSection heading="2. Bring your footage or generate a shot">
        <p>
          Choose <strong className="text-ink">Use my footage</strong> when creating a production
          or adding a clip in the studio. MP4, MOV and WebM files up to 50 MB and 60 seconds are
          supported. Uploading costs no video credits, and you can replace the clip later.
          Pick a short, steady shot with a clear subject; the same footage can loop or scrub
          with the visitor&apos;s scroll.
        </p>
        <p>
          If you generate with AI, video models are good at atmosphere and camera movement, and weak at legible text, hands,
          logos and precise brand detail. Describe the <em>scene and the camera</em>, not a
          graphic design.
        </p>
        <p>
          A shot prompt that works usually names four things: the subject, the camera move, the
          lighting, and the mood. For example, &ldquo;slow dolly push across a marble counter,
          steam rising from a freshly pulled espresso, low golden window light, calm and
          unhurried.&rdquo;
        </p>
        <p>
          Reelform recommends an available video model from your prompt and preferred quality,
          length and shape. As you edit the prompt, the recommendation updates with a reason,
          the supported output settings and the credit price. Review these before generating.
          Your free hero uses its included 5-second, 720p preset; a plan unlocks prompt-based
          model matching.
        </p>
        <p>
          Not sure where to start? The studio&apos;s <strong className="text-ink">Suggest a shot</strong>{" "}
          button writes one from your brief at no cost, and the shot-style chips give you a
          tested starting point to edit.
        </p>
        <p>
          Nothing reaches your site without your approval. Reshoot as many times as you like. A
          render that fails is refunded automatically.
        </p>
      </LegalSection>

      <LegalSection heading="3. Choose loop or scrub: they suit different things">
        <p>
          <strong className="text-ink">Ambient loop</strong> plays the footage continuously behind
          your hero. It suits mood, brand and atmosphere: hospitality, fashion, music, anything
          where the feeling matters more than the detail.
        </p>
        <p>
          <strong className="text-ink">Scroll scrub</strong> ties playback to the scroll position,
          so the visitor drives the footage forward frame by frame. It suits reveals and
          progressions: property walkthroughs, product rotations, before-and-after, anything with a
          beginning and an end.
        </p>
        <p>
          Each clip in a production carries its own mode, so a single site can loop the hero and
          scrub a section further down.
        </p>
      </LegalSection>

      <LegalSection heading="4. Iterate by chat, then ship">
        <p>
          Once the first build lands, the chat under the preview edits the live site. Be specific
          and concrete. &ldquo;Make the hero headline bigger and drop the subheading to one
          line&rdquo; lands better than &ldquo;make it pop&rdquo;. Each edit is billed on real
          token usage, so small changes cost very little.
        </p>
        <p>
          When you&apos;re happy, download the zip: an <code>index.html</code> plus every video it
          uses, with the paths already rewritten. Host it on any static host; there&apos;s no
          runtime dependency on us. You can also publish it to the{" "}
          <Link href="/showcase" className="text-primary underline">
            public showcase
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection heading="What things cost">
        <p>
          Every action shows its price before you confirm it. New accounts start with{" "}
          one free website: a hero video and a full site build, no card needed.
          {" "}Uploading your own footage is free; building and editing the website follow the usual plan and credit rules.
          Video prices vary with the recommended model and its output settings; the examples below
          show two WAN 2.5 shots.
        </p>
        <ul className="mt-4 space-y-2">
          <li className="flex justify-between border-b border-line pb-2">
            <span>Video example · WAN 2.5 · 720p · 5s</span>
            <span className="font-mono text-primary">
              {videoCost(DEFAULT_VIDEO_MODEL, "720p", 5)} cr
            </span>
          </li>
          <li className="flex justify-between border-b border-line pb-2">
            <span>Video example · WAN 2.5 · 1080p · 5s</span>
            <span className="font-mono text-primary">
              {videoCost(DEFAULT_VIDEO_MODEL, "1080p", 5)} cr
            </span>
          </li>
          {Object.entries(MODELS).map(([id, m]) => (
            <li key={id} className="flex justify-between border-b border-line pb-2 last:border-0">
              <span>
                Site build · {m.label}{" "}
                <span className="text-faint">· {m.blurb}</span>
              </span>
              <span className="font-mono text-primary">
                up to {estimateBuildCredits(id as ModelId).hold} cr
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4">
          Full breakdown on the{" "}
          <Link href="/pricing" className="text-primary underline">
            pricing page
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection heading="Still stuck?">
        <p>
          The{" "}
          <Link href="/faq" className="text-primary underline">
            FAQ
          </Link>{" "}
          covers billing, refunds and account questions. For anything else, email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary underline font-medium">
            {CONTACT_EMAIL}
          </a>. A real person reads it.
        </p>
      </LegalSection>
    </LegalShell>
  );
}
