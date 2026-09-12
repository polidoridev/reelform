import Link from "next/link";
import { CONTACT_EMAIL } from "@/lib/contact";
import { BrandMark } from "@/components/BrandMark";

// Re-exported for the pages that have always imported it from here.
export { CONTACT_EMAIL };

const COLUMNS: { label: string; links: { href: string; text: string }[] }[] = [
  {
    label: "PRODUCT",
    links: [
      { href: "/showcase", text: "Showcase" },
      { href: "/pricing", text: "Pricing" },
      { href: "/create", text: "Start building" },
      { href: "/dashboard", text: "Dashboard" },
      { href: "/account", text: "Account" },
    ],
  },
  {
    label: "LEGAL",
    links: [
      { href: "/terms", text: "Terms of Service" },
      { href: "/privacy", text: "Privacy Policy" },
      { href: "/refunds", text: "Refund Policy" },
    ],
  },
  {
    label: "SUPPORT",
    links: [
      { href: "/guide", text: "Getting started" },
      { href: "/faq", text: "FAQ" },
      { href: "/changelog", text: "Changelog" },
      { href: "/contact", text: "Contact us" },
      { href: `mailto:${CONTACT_EMAIL}`, text: CONTACT_EMAIL },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="bg-ink text-white px-6 md:px-10 py-12">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col md:flex-row gap-10 md:gap-16">
          <div className="md:flex-1">
            <Link href="/" className="flex items-center gap-3">
              <BrandMark />
              <span className="font-semibold tracking-tight text-lg">
                Reel<span className="text-primary-soft">form</span>
              </span>
            </Link>
            <p className="mt-3 text-sm text-white/60 max-w-xs leading-relaxed">
              AI video-first websites. Upload your footage or generate a video, then let Claude
              build the site around it.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.label}>
              <p className="mono-label !text-white/50">{col.label}</p>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.text}>
                    {link.href.startsWith("mailto:") ? (
                      <a
                        href={link.href}
                        className="text-sm text-white/70 hover:text-white transition-colors"
                      >
                        {link.text}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-sm text-white/70 hover:text-white transition-colors"
                      >
                        {link.text}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 pt-6 border-t border-white/10 flex flex-wrap items-center justify-between gap-4">
          <p className="mono-label !text-white/60 !normal-case">
            © {new Date().getFullYear()} Reelform · Polidori.dev
          </p>
          <p className="mono-label !text-white/60">CUT · PRINT · SHIP</p>
        </div>
      </div>
    </footer>
  );
}
