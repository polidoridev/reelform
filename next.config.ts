import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// React's development build uses eval() for debugging features (reconstructing
// callstacks across environments). It never does so in production, so
// 'unsafe-eval' is granted to `next dev` only, shipping it would hand any
// injected string a way to execute.
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

// Applied to every app route.
//
// This does NOT cover /showcase/[id], which serves user-generated HTML and
// sets its own, much stricter `sandbox` CSP in the route handler.
const CSP = [
  "default-src 'self'",
  // 'unsafe-inline' is required, not lazy: Next streams its RSC payload through
  // an inline `self.__next_f.push(...)` script, so without it hydration data
  // never arrives and every page ships dead. Removing it means generating a
  // per-request nonce in proxy.ts and threading it through, worth doing, but
  // it is a change with real breakage risk, not a one-line tightening.
  scriptSrc,
  // Generated sites embed footage from Supabase Storage; the reference reel
  // ships from /public; blob: covers locally-generated preview objects.
  "media-src 'self' https: blob: data:",
  "img-src 'self' https: data: blob:",
  // Tailwind emits inline styles and next/font injects a <style> block.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  // Supabase (REST, auth, realtime) and Vercel Analytics.
  "connect-src 'self' https: wss:",
  // The studio preview renders into a sandboxed frame.
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Nothing here should ever be framed by a third party, clickjacking the
  // billing and publish controls would be the payoff.
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  // Two years, preloadable. Browsers only honour it over HTTPS.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Belt-and-braces alongside frame-ancestors for anything predating CSP2.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The app asks for none of these, so deny them outright.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "on" },
];

const nextConfig: NextConfig = {
  // Keep the binary's real package directory when resolving ffmpeg at runtime.
  serverExternalPackages: ["ffmpeg-static"],
  // The video status route spawns the ffmpeg-static binary (all-intra re-encode
  // for smooth scrubbing). Next's file tracing only sees the require() string,
  // not the platform binary it points to, so include it explicitly or it won't
  // be bundled into the serverless function on Vercel.
  outputFileTracingIncludes: {
    "/api/video/status": ["./node_modules/ffmpeg-static/ffmpeg*"],
    "/api/video/upload": ["./node_modules/ffmpeg-static/ffmpeg*"],
  },

  // Don't advertise the framework version.
  poweredByHeader: false,

  async headers() {
    return [
      {
        // Everything except the published-site route, which is intentionally
        // served as an isolated sandboxed document with its own CSP.
        source: "/((?!showcase/).*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
