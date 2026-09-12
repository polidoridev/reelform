import { LegalShell, LegalSection } from "@/components/LegalShell";
import { ROLLOVER_MONTHS } from "@/lib/pricing";
import { pageMeta } from "@/lib/seo";
import { CONTACT_EMAIL } from "@/components/SiteFooter";

export const metadata = pageMeta({
  title: "FAQ",
  description:
    "How Reelform works: what you get, how credits and refunds work, what happens if you don't like the video, and how to keep editing your site with Claude.",
  path: "/faq",
});

export default function FaqPage() {
  return (
    <LegalShell label="HELP DESK" title="Frequently asked questions">
      <LegalSection heading="What is Reelform?">
        <p>
          Reelform builds video-first websites. You describe your business, upload your own footage
          or generate a video with AI, and Claude builds a complete single-page site around the footage.
          It all takes a few minutes, and you iterate through chat.
        </p>
      </LegalSection>

      <LegalSection heading="Can I use my own footage?">
        <p>
          Yes. Choose Use my footage when starting a production or adding a clip in the studio.
          Upload an MP4, MOV or WebM file up to 50 MB and 60 seconds. You can use it as an ambient
          loop or a scroll-controlled video, add more clips, and replace footage later.
          Uploads use no video credits and do not consume your free AI video allowance.
          Website builds and edits still follow your plan and credit limits.
        </p>
      </LegalSection>

      <LegalSection heading="How do credits work?">
        <p>
          AI generation runs on credits. A video render costs a fixed amount shown before you
          confirm; a site build reserves a ceiling and charges only what it actually uses, so the
          number you see is the most it can cost. One credit is roughly $0.01 of value. Every new
          account starts with one complete website free: a hero video and a full site build. The
          free pair runs on a fixed preset, a 5-second 720p shot and a fast build, choosing the
          model, resolution and shot length is what a plan unlocks.
        </p>
        <p>
          Subscription credits refill monthly and roll over for up to {ROLLOVER_MONTHS} months, so
          a quiet month costs you nothing; top-up credits never expire, and plan credits are always
          spent first. You can see every
          credit movement under{" "}
          <a href="/account/credits" className="text-primary underline">
            Account → Credits &amp; activity
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection heading="What happens if a generation fails?">
        <p>
          Credits for failed video renders or site builds are refunded to your balance
          automatically. The refund appears in your credit activity within a minute or two.
        </p>
      </LegalSection>

      <LegalSection heading="What's the difference between plans and top-ups?">
        <p>
          Plans are monthly subscriptions with the best credit rate, and they are ideal if you build regularly.
          Top-ups are a subscriber add-on for the months you outrun your plan: one-time purchases
          at a slightly higher rate, and those credits never expire. You need an active plan to
          buy one.
        </p>
      </LegalSection>

      <LegalSection heading="Where do I find my invoices?">
        <p>
          Every payment (subscriptions and top-ups) has a downloadable PDF invoice under{" "}
          <a href="/account/billing" className="text-primary underline">
            Account → Billing &amp; invoices
          </a>
          , along with your full payment history and total spend.
        </p>
      </LegalSection>

      <LegalSection heading="How do I cancel or change my plan?">
        <p>
          Open the Stripe billing portal from{" "}
          <a href="/account/billing" className="text-primary underline">
            Account → Billing &amp; invoices
          </a>{" "}
          → &ldquo;Manage subscription&rdquo;. Changes take effect at the end of the current billing
          period; credits already granted stay on your account.
        </p>
      </LegalSection>

      <LegalSection heading="Can I get a refund?">
        <p>
          Failed generations are always refunded in credits automatically. For money refunds, see
          our{" "}
          <a href="/refunds" className="text-primary underline">
            Refund Policy
          </a>. Unused top-ups and accidental charges are typically refundable within 14 days.
        </p>
      </LegalSection>

      <LegalSection heading="Do I own the videos and sites I create?">
        <p>
          Yes. You own the sites and videos generated for your account and can export, host, and
          use them commercially. See the{" "}
          <a href="/terms" className="text-primary underline">
            Terms of Service
          </a>{" "}
          for details.
        </p>
      </LegalSection>

      <LegalSection heading="How do I delete my account?">
        <p>
          Go to{" "}
          <a href="/account/security" className="text-primary underline">
            Account → Security
          </a>{" "}
          → Danger zone. Deletion removes your profile, productions, videos, and remaining credits,
          and cancels any active subscription. It cannot be undone.
        </p>
      </LegalSection>

      <LegalSection heading="Still stuck?">
        <p>
          Email us at{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary underline font-medium">
            {CONTACT_EMAIL}
          </a>{" "}
          or visit the{" "}
          <a href="/contact" className="text-primary underline">
            contact page
          </a>
          . We typically respond within 2 business days.
        </p>
      </LegalSection>
    </LegalShell>
  );
}
