# Reelform

Video-first website builder. Users describe their business, upload their own footage or direct a cinematic video with **Higgsfield**, then send it to **Claude**, which builds a complete single-file website around the footage — playing as an ambient loop or scrubbing frame-by-frame with scroll. They can replace clips and keep editing until the site is ready.

**Stack:** Next.js (App Router) · Supabase (auth + Postgres + RLS) · Stripe (subscriptions + credit top-ups) · Anthropic API (streaming, user-selectable model) · Higgsfield (hosted video models) · Vercel (hosting)

---

## How the product works

1. **Brief** — user names the project, picks an industry, describes the website.
2. **Add footage** — user uploads an MP4, MOV or WebM clip (up to 50 MB and 60 seconds), or writes a shot prompt and generates with AI. Reelform recommends an available video model from the prompt and preferred quality, length and shape, with an explanation and credit quote before rendering. The free hero keeps its included preset. Uploads are converted to a browser-ready MP4 and use no video credits. In the studio, users can add more clips or replace existing footage before building.
3. **Build** — user picks playback mode (**ambient loop** or **scroll scrub**) and a Claude model (Haiku → Opus), then hits *Send to Claude*. The site streams in live and renders in a sandboxed iframe.
4. **Iterate** — chat box sends edit instructions to Claude (full current HTML is passed as context each time). Reshooting the video and telling Claude "swap in the new video" also works — the latest video URL is always injected server-side.
5. **Ship** — download the site as a zip (HTML plus every video, URLs rewritten to local files), or — on **Pro and Studio** — publish it live in one click to the user's *own* Vercel and Supabase accounts.

AI generations are metered in credits with atomic spend/refund in Postgres. Failed generations are automatically refunded. Uploading footage does not spend credits or consume the free AI video allowance; site generation still follows the usual plan and credit rules.

---

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open the **SQL editor** and run `supabase/schema.sql` (tables, RLS, credit RPCs, rate-limit function, signup-bonus trigger). It is idempotent, so re-running it is safe.
   - `schema.sql` is the full current state for a **fresh** project. If you already have a database, apply the files in `supabase/migrations/` in filename order instead — they are the incremental path.
3. Copy from **Project Settings → API** into `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
4. **Auth → URL Configuration**: set Site URL to your app URL, add `https://your-app/api/auth/callback` to redirect URLs.
   Every auth email (confirm signup, reset password, change email) links to `{{ .SiteURL }}/api/auth/callback`, so the Site URL must be the real production origin (`https://www.reelform.io`), and `http://localhost:3000/api/auth/callback` needs to be on the redirect list for local work.
5. **Email templates** live in `supabase/templates/` and are wired up in `supabase/config.toml`. Push them to the hosted project with `supabase login` (as the project owner), `supabase link --project-ref <ref>`, then `supabase config push`. Or paste each file into **Auth → Emails** in the dashboard, with the subjects from `config.toml`. The templates use `{{ .TokenHash }}` links, which `/api/auth/callback` verifies server-side, so a link opened on another device or browser still works.
6. **SMTP**: the built-in sender is capped at a few emails per hour. Before launch, set a custom SMTP provider under **Auth → SMTP settings** so signups and password resets are not throttled.
7. Optional: under **Auth → Sign In / Up**, disable "Confirm email" for frictionless local testing (keep it on in production).

### 2. Anthropic

Create an API key at [platform.claude.com](https://platform.claude.com) → `ANTHROPIC_API_KEY`.

### 3. Higgsfield (video generation)

1. Create an account at [platform.higgsfield.ai](https://platform.higgsfield.ai) and generate an API key. Credentials come as a **key id + key secret** pair.
2. Set `HIGGSFIELD_API_KEY` and `HIGGSFIELD_API_SECRET` (or paste the combined `id:secret` string into `HIGGSFIELD_API_KEY` alone).
3. The create flow and studio automatically recommend a video model using `lib/video-recommendation.ts`. Local routing rules match the user's prompt and preferred quality, length and shape against the catalog in `lib/higgsfield.ts`; price breaks equally suitable matches. The UI explains the recommendation and shows its supported output settings and credit cost before rendering. This matching makes no LLM or paid generation calls. The free hero remains pinned to `FREE_TIER.video`; subscribers get prompt-based matching. `HIGGSFIELD_MODEL` remains a fallback for direct calls to the low-level provider helper, not an override for these recommendations.
4. Catalog capabilities come from the published OpenAPI spec. Requested lengths snap to supported takes, and models without resolution or framing controls are labelled as automatic/native. Per-model rates in `VIDEO_MODEL_USD_PER_SECOND` in `lib/pricing.ts` drive the quoted credit cost. Both generation routes recompute the recommendation before charging; if the model, settings or price changed, they return `409` and require the user to review the refreshed quote.

**Model availability is per account.** `GET /api/video/models` probes the catalog and shares its cache with generation routes through `lib/video-model-access.ts`. Recommendations only consider positively confirmed access; missing, failed or unavailable checks cannot silently select a fallback. The probe is a POST with an empty body (`{}`): a permitted model answers a validation error for missing `prompt`, an unavailable one answers `404 model_not_found`, and neither generates anything. **Never probe with a body the API might consider valid** — a request that validates starts a paid render, and at least one endpoint (`hailuo-2.3/pro`) silently ignores fields it doesn't recognise instead of rejecting them.

`GET /api/video/health` answers the same question about the provider as a whole (`live`/`offline`), which is what the status dot in the studio and create flow reads.

Higgsfield's own DoP tiers are image-to-video (they require an input frame), so they aren't wired into the prompt-only studio flow. To move to a different provider entirely, swap the two functions in `lib/higgsfield.ts` — the rest of the app only depends on `createVideoTask` / `getVideoTask`.

### 4. Stripe

1. In the Stripe dashboard create **6 Prices** and paste their ids into `.env.local`:

   | Product | Type | Amount | Env var |
   |---|---|---|---|
   | Starter plan | Recurring monthly | $19 | `STRIPE_PRICE_STARTER` |
   | Pro plan | Recurring monthly | $49 | `STRIPE_PRICE_PRO` |
   | Studio plan | Recurring monthly | $129 | `STRIPE_PRICE_STUDIO` |
   | 900 credits | One-time | $10 | `STRIPE_PRICE_TOPUP_SMALL` |
   | 2,400 credits | One-time | $25 | `STRIPE_PRICE_TOPUP_MEDIUM` |
   | 6,200 credits | One-time | $60 | `STRIPE_PRICE_TOPUP_LARGE` |

2. Set `STRIPE_SECRET_KEY`.
3. Webhook: add an endpoint pointing at `https://your-app/api/stripe/webhook` listening to `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted` → copy the signing secret to `STRIPE_WEBHOOK_SECRET`.
   - Locally: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
4. Enable the **customer portal** (Settings → Billing → Customer portal) so users can cancel/manage plans.

### 5. Email (Resend)

Product email goes out through [Resend](https://resend.com): a welcome message once the account is confirmed, receipts for top-ups and plan starts/renewals, a notice when a plan is canceled, and, for accounts that opted in, a short tips drip. The auth emails (confirm, reset password) still go through Supabase, see step 1.

1. Verify your sending domain under **Domains** and add the DNS records it gives you.
2. Create an API key → `RESEND_API_KEY`. Set `EMAIL_FROM` to a sender on that domain.
3. `openssl rand -base64 48` → `EMAIL_UNSUBSCRIBE_SECRET`, and set `NEXT_PUBLIC_POSTAL_ADDRESS` to the business mailing address. Marketing email stays off until both exist.
4. **Webhooks** → add `https://your-app/api/email/webhook` for `email.bounced`, `email.complained`, `contact.created`, `contact.updated` → `RESEND_WEBHOOK_SECRET`. Bounces and complaints stop further email to that address; contact events keep the opt-in flag in sync with anything done in Resend's UI.
5. Optional: create an **Audience** → `RESEND_AUDIENCE_ID`. Every opt-in and opt-out is mirrored there, so one-off newsletters can be written and sent from **Broadcasts** without touching code. Put `{{{RESEND_UNSUBSCRIBE_URL}}}` in every broadcast; those unsubscribes flow back through the webhook above.
6. The drip runs daily from `vercel.json` → `/api/cron/email-drip`. Vercel provisions `CRON_SECRET`; locally, set one and `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/email-drip`.
7. To send the Supabase auth emails through Resend as well: **Auth → SMTP settings**, host `smtp.resend.com`, port `465`, user `resend`, password = the API key, sender = your `EMAIL_FROM` address.

**Consent and the law.** The app is built to CASL (Canada's anti-spam law) and Quebec's Law 25:

- Marketing email needs express opt-in. The signup checkbox is unchecked and separate from the terms; Google signups carry the same checkbox through the callback.
- Every consent is recorded with its date and source (`marketing_consent_at`, `marketing_consent_source`) and quoted back in the footer of each marketing email.
- Every marketing email carries the sender's legal name, mailing address, contact email, a working unsubscribe link, and `List-Unsubscribe` headers (one-click). Unsubscribing takes effect immediately and never requires signing in.
- Account email (receipts, plan changes, welcome) is sent regardless of consent, as CASL allows for transactional messages, but still stops for a bounced or complained address.
- `email_log` keeps one row per message sent (who, what, when) as the audit trail, and is deleted with the account.

The copy lives in `lib/email/templates.ts`; the frame that wraps it in `lib/email/layout.ts`. Adding a drip step is one entry in `DRIP` at the bottom of the templates file.

### 6. Run locally

```bash
cp .env.example .env.local   # fill in everything above
npm install
npm run dev
```

`.env.example` documents every variable the app reads, and which ones are required.
Missing required vars are reported at server start by `instrumentation.ts` — loudly in
production (it refuses to boot), as a warning in development.

To verify footage uploads against a running local app, run `node scripts/verify-footage.mjs`.
Add `--browser` to also exercise the create flow with a simulated failed site build and retry,
and check that the authenticated studio plays the footage and keeps it after a reload.
The check uses the configured Supabase admin credentials to create confirmed
disposable accounts, uploads tiny synthetic MP4/MOV/WebM clips, checks invalid-file rejection,
credit preservation and ZIP export, then cleans up its accounts and storage objects. It does
not call AI generation or email endpoints. Set `FOOTAGE_TEST_APP` for a different localhost
port or `PLAYWRIGHT_CHANNEL` to use an installed browser such as `msedge`.

### 6. Deploy integrations (currently disabled — Pro/Studio "Publish live")

Lets customers push a finished site into **their own** Vercel and Supabase accounts.
Nothing is hosted by us, so a shipped site outlives the customer's subscription.
Skip this and the studio still offers the zip download.

> **Switched off at the source.** `DEPLOY_ENABLED` in `lib/pricing.ts` is `false`,
> so the plan perks, the pricing section, the studio's *Publish live* button and the
> account tab are all hidden — nothing advertises or offers a feature that would
> dead-end at `?error=not_configured`. Complete the steps below **and** flip that flag
> to `true` to bring it back everywhere at once.

1. Set `INTEGRATION_SECRET` (32+ random chars, `openssl rand -base64 48`). It encrypts
   the stored OAuth tokens; rotating it just forces everyone to reconnect.
2. Create a **Vercel integration** (Dashboard → Integrations → Console) with redirect
   URL `{NEXT_PUBLIC_APP_URL}/api/integrations/vercel/callback` and read/write scopes on
   Deployments, Projects and Environment Variables. Fill in `VERCEL_CLIENT_ID`,
   `VERCEL_CLIENT_SECRET` and `VERCEL_INTEGRATION_SLUG`.
3. Create a **Supabase OAuth app** (Dashboard → Organization → OAuth Apps) with redirect
   URL `{NEXT_PUBLIC_APP_URL}/api/integrations/supabase/callback`. Fill in
   `SUPABASE_OAUTH_CLIENT_ID` and `SUPABASE_OAUTH_CLIENT_SECRET`.
4. Run `supabase/migrations/20260819_deployments.sql` (or the whole `schema.sql`).

Customers connect their accounts at **Account → Deploy integrations**, then hit
*Publish live* in the studio.

### 7. Deploy Reelform itself to Vercel

1. Push this repo to GitHub, import it in Vercel.
2. Add every variable from `.env.local` to Vercel project env vars; set `NEXT_PUBLIC_APP_URL` to the production URL.
3. Point the Stripe webhook and the Supabase auth redirect URLs at the production domain.
4. Site generation streams for up to 5 minutes (`maxDuration = 300` in `app/api/site/generate/route.ts`) — this requires a Vercel plan that allows it (Pro), or lower the value and prefer faster models on Hobby.

---

## Pricing model (and why it's profitable)

**1 credit ≈ $0.01 retail.** Action prices are set at roughly **2× the underlying provider cost**, so gross margin is ~50%+ before Stripe fees, and subscriptions improve it further because unused credits expire monthly (top-ups don't — that's the fairness lever).

| Action | Credits | Retail | Approx. provider cost |
|---|---|---|---|
| Video 720p · 5s | 100 | ~$1.00 | ~$0.50 |
| Video 1080p · 5s | 150 | ~$1.50 | ~$0.75 |
| Site build — Haiku 4.5 | 10 | ~$0.10 | ~$0.03–0.05 |
| Site build — Sonnet 4.6 | 35 | ~$0.35 | ~$0.10–0.20 |
| Site build — Opus 4.8 | 120 | ~$1.20 | ~$0.40–0.70 |

Plans: Starter $19 → 2,000 cr · Pro $49 → 6,000 cr · Studio $129 → 18,000 cr. New accounts get **one complete website free** — one hero video and one site build — instead of a credit float. Regenerating, editing or starting a second project needs a plan, which is the upgrade moment.

**Tune it in one place:** all numbers live in `lib/pricing.ts`. Watch your real Anthropic/Higgsfield invoices for the first weeks and adjust credit costs there; the ledger table (`credit_ledger`) gives you per-action usage analytics for free.

Protections already built in:
- Atomic spend via a Postgres function — no double-spend race conditions.
- Automatic refunds when a provider call fails or the model declines, guarded so a
  concurrent poll can't pay the same refund twice.
- Credits can only be changed by `security definer` RPCs called with the service-role key — clients can't touch balances.
- Per-user hourly rate limits on every endpoint that costs money at a provider
  (`lib/rate-limit.ts`). Credits cap *total* spend but not *rate*, and admin ids skip
  credits entirely — this is what stops a script from running up the Anthropic and
  Higgsfield bills. Limits are stored in Postgres, not memory, because the app runs
  serverless. Tune them in `lib/rate-limit.ts`.

---

## Architecture notes

- `lib/claude.ts` — streaming site generation. The system prompt enforces single-file HTML output, distinctive (non-generic) design, and contains the exact loop / scroll-scrub video integration patterns. Edits always pass the full current HTML and return a full document.
- `app/api/site/generate/route.ts` — spends credits, streams plain text to the client, persists the finished HTML, refunds on failure using an in-band error sentinel.
- `app/api/video/*` — creates the Higgsfield request and polls it; refunds on provider failure. `/api/video/upload` issues an owner-scoped signed Storage upload and validates/converts the uploaded bytes before attaching the permanent MP4 to a clip.
- `app/api/stripe/webhook/route.ts` — top-ups on `checkout.session.completed`, plan set + monthly credit grant on `invoice.paid` (covers first payment and renewals), status sync on subscription update/delete.
- `proxy.ts` — session refresh + auth gate for `/dashboard`, `/studio`, `/account` (Next 16 renamed `middleware` to `proxy`).
- `lib/site-bundle.ts` — the single definition of "what the site is": HTML + videos with URLs rewritten. The zip download, the Vercel deployment and the Supabase Storage upload all build from it, so a site can't behave one way downloaded and another way deployed.
- `lib/deploy.ts` — orchestrates a publish: provision the customer's Supabase project (a `site_submissions` table, insert-only for `anon`), inject its keys into the bundle so the site's forms work, then upload the bundle to their Vercel account. Enforces the plan gate and the live-site cap.
- `lib/vercel.ts` / `lib/supabase-mgmt.ts` — REST clients for the two provider APIs; `lib/integrations.ts` + `lib/crypto.ts` store the OAuth tokens sealed with AES-256-GCM in a table that has RLS on and **no policies**, so only the service-role client can read them.
- RLS everywhere; the service-role client is only used server-side for credit accounting, webhook fulfillment and deploys.

## Roadmap ideas

- Custom domains on deployed sites (Vercel domains API), and a submissions inbox in the dashboard.
- Multiple videos per site (per-section footage).
- Team workspaces; per-project shareable preview links.
- Image generation for non-hero assets.
