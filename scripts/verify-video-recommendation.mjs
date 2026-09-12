// Browser integration check against a running local app. Uses disposable
// confirmed accounts, and intercepts every paid AI/email endpoint. Availability
// is deterministic; no video, site, or shot-planning provider calls are made.
// Usage: node scripts/verify-video-recommendation.mjs
// Optional: RECOMMENDATION_TEST_APP, PLAYWRIGHT_CHANNEL, RECOMMENDATION_SCREENSHOT.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { chromium } from "playwright";

nextEnv.loadEnvConfig(process.cwd());
const app = process.env.RECOMMENDATION_TEST_APP || "http://localhost:3000";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(app).hostname), "Use a local app URL.");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(url && anonKey && serviceKey, "Supabase environment variables are required.");
const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }) },
};
const admin = createClient(url, serviceKey, clientOptions);
const accounts = [];
const models = ["seedance-lite", "ltx-2", "hailuo-02", "hailuo-2.3", "seedance-pro-fast", "kling-2.5-turbo-pro", "hailuo-02-pro", "hailuo-2.3-pro", "wan-2.5", "sora-2", "kling-2.1-master", "sora-2-pro"];
const allAvailable = Object.fromEntries(models.map((id) => [id, true]));
const noneAvailable = Object.fromEntries(models.map((id) => [id, false]));
const prompts = {
  stylized: "An anime character explores a watercolor forest, illustrated flowers and expressive faces in a hand-drawn fantasy world.",
  motion: "A professional athlete sprinting and jumping over obstacles, camera tracking the running action with realistic motion and physical momentum.",
};
let browser;

function checked(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function account(paid = true) {
  const password = `Recommendation-check-${randomUUID()}`;
  const email = `recommendation-check+${randomUUID()}@reelform.test`;
  const { user } = checked(await admin.auth.admin.createUser({ email, password, email_confirm: true }), "Create test account");
  const cookies = new Map();
  const auth = createServerClient(url, anonKey, {
    global: clientOptions.global,
    cookies: {
      getAll: () => [...cookies.values()],
      setAll: (values) => values.forEach((cookie) => cookies.set(cookie.name, cookie)),
    },
  });
  const entry = { id: user.id, auth, cookies };
  accounts.push(entry);
  checked(await admin.from("profiles").update({
    marketing_opt_in: false, email_bounced_at: new Date().toISOString(), is_private: true,
    ...(paid ? { plan: "starter", plan_status: "active", credits: 2000 } : {}),
  }).eq("id", user.id), "Prepare test profile");
  checked(await auth.auth.signInWithPassword({ email, password }), "Sign in test account");
  entry.before = checked(await admin.from("profiles").select("credits, subscription_credits, free_video_used, free_site_used").eq("id", user.id).single(), "Read initial allowances");
  return entry;
}

async function session(owner, available = allAvailable) {
  browser ||= await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addCookies([...owner.cookies.values()].filter((c) => c.value).map((c) => ({ name: c.name, value: c.value, url: app, httpOnly: !!c.options?.httpOnly, sameSite: "Lax" })));
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const state = { page, context, available, errors: [], generation: [], otherAI: [], accessChecks: 0 };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route(/\/api\/(video\/(generate|request)|site\/(generate|edit|suggest-shot)|email\/)/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/video/generate" || path === "/api/video/request") state.generation.push(route.request().postDataJSON());
    else state.otherAI.push(path);
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Verification intercepted generation; no credits spent." }) });
  });
  await page.route("**/api/video/models", (route) => {
    state.accessChecks++;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ available: state.available }) });
  });
  await page.route("**/api/video/health", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "live" }) }));
  return state;
}

async function createScreen(owner, available = allAvailable) {
  const state = await session(owner, available);
  await state.page.goto(`${app}/create`, { waitUntil: "networkidle" });
  await state.page.getByRole("button", { name: /Scrub website/ }).click();
  await state.page.getByRole("radio", { name: "Generate with AI" }).check();
  return state;
}

async function studioFixture(owner) {
  const project = checked(await admin.from("projects").insert({ user_id: owner.id, name: "Disposable recommendation verification", site_brief: "A studio for distinctive cinematic websites.", video_mode: "loop" }).select("id").single(), "Create studio fixture");
  const video = checked(await admin.from("project_videos").insert({ project_id: project.id, user_id: owner.id, position: 0, label: "Hero video", mode: "loop", status: "none", settings: { model: "wan-2.5", resolution: "720p", duration: 5, ratio: "16:9" } }).select("id").single(), "Create video fixture");
  return { project, video };
}

async function noBrowserErrors(state) {
  assert.deepEqual(state.errors, [], "Browser JavaScript errors.");
  assert.equal(await state.page.locator("[data-nextjs-dialog], .vite-error-overlay").count(), 0, "Framework error overlay.");
}

const recommendationCard = (page) => page.getByRole("status").filter({ hasText: /(?:RECOMMENDED|INCLUDED) VIDEO MODEL/ }).first();

async function noModelPicker(page) {
  assert.equal(await page.locator("#shot-model").count(), 0, "Old manual video-model selector must be removed.");
  assert.equal(await page.getByRole("combobox", { name: /model/i }).count(), 0, "Video model must be recommended, not manually selected.");
}

async function paidCreate(owner) {
  const state = await createScreen(owner);
  const { page } = state;
  const brief = page.getByRole("textbox", { name: "Describe your website" });
  await brief.fill(prompts.stylized);
  const quality = page.getByRole("combobox", { name: "QUALITY", exact: true });
  if (!(await quality.innerText()).includes("720p")) {
    await quality.click();
    await page.getByRole("option", { name: /720p/ }).click();
  }
  const card = recommendationCard(page);
  await card.getByText("Hailuo 2.3", { exact: true }).waitFor();
  await brief.fill(prompts.motion);
  await card.getByText(/^Kling /).waitFor();
  const motionModel = await card.locator("p.font-medium, p.text-sm.font-medium").first().innerText();
  assert.match(motionModel, /^Kling /, "Changing the prompt must choose a model for the new motion intent.");
  assert.match(await card.innerText(), /automatic|native/i, "Native output must not be falsely labeled as a guaranteed resolution.");
  await noModelPicker(page);
  assert.equal(state.generation.length + state.otherAI.length, 0, "Typing a prompt must not call paid generation or planning.");
  await quality.click();
  await page.getByRole("option", { name: /1080p/ }).click();
  await card.getByText(/1080p/).waitFor();
  const highQualityText = await card.innerText();
  assert(!highQualityText.includes(motionModel), "An explicit unsupported quality preference must choose a supported model.");
  await quality.click();
  await page.getByRole("option", { name: /720p/ }).click();
  await card.getByText(motionModel, { exact: true }).waitFor();
  const displayedCost = Number((await card.innerText()).match(/(\d+) credits/)?.[1]);
  assert(displayedCost > 0, "Paid recommendation must show credits before generation.");
  await page.setViewportSize({ width: 375, height: 812 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Recommendation must fit a 375px viewport.");
  if (process.env.RECOMMENDATION_SCREENSHOT) await page.screenshot({ path: process.env.RECOMMENDATION_SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });

  // Simulate the server rejecting a quote after its chosen model goes offline.
  // The browser must refresh the card and require another click, never retry a
  // differently priced render automatically.
  state.available = { ...noneAvailable, "wan-2.5": true };
  await page.getByRole("button", { name: "Build my website", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Verification intercepted generation" }).waitFor();
  await card.getByText("WAN 2.5", { exact: true }).waitFor();
  assert.equal(state.generation.length, 1, "A stale quote must not automatically resubmit the new model.");
  assert.equal(state.generation[0].cost, displayedCost, "Generation must send the displayed credit quote.");
  assert.equal(state.generation[0].recommendationPrompt, prompts.motion);
  assert.equal(state.generation[0].recommendationSettings.resolution, "720p");
  assert(state.accessChecks >= 2, "Stale-quote failure must refresh availability.");
  await noBrowserErrors(state);
  console.log("PASS create: prompt changes update model, explicit quality respected, price quoted, stale quote refresh requires new click, mobile layout");
  await state.context.close();
}

async function unavailableCreate(owner) {
  const state = await createScreen(owner, noneAvailable);
  const { page } = state;
  await page.getByRole("textbox", { name: "Describe your website" }).fill(prompts.motion);
  await recommendationCard(page).getByText("No video models are available right now. Try again shortly.").waitFor();
  assert(await page.getByRole("button", { name: "Build my website", exact: true }).isDisabled(), "Generation must be disabled when no models are available.");
  state.available = { ...noneAvailable, "wan-2.5": true };
  await recommendationCard(page).getByRole("button", { name: "Try again" }).click();
  await recommendationCard(page).getByText("WAN 2.5", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Build my website", exact: true }).isEnabled(), "Availability retry should recover.");
  assert.match(await recommendationCard(page).innerText(), /unavailable|available match/i, "Fallback recommendation should explain availability.");
  assert.equal(state.generation.length + state.otherAI.length, 0);
  await noBrowserErrors(state);
  console.log("PASS unavailable: safe empty state, disabled generate, retry and available fallback");
  await state.context.close();
}

async function freeCreate(owner) {
  const state = await createScreen(owner);
  const { page } = state;
  await page.getByRole("textbox", { name: "Describe your website" }).fill(prompts.stylized);
  const card = recommendationCard(page);
  await card.getByText("Seedance 1 Lite", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Describe your website" }).fill(prompts.motion);
  assert.match(await card.innerText(), /INCLUDED VIDEO MODEL/);
  assert.match(await card.innerText(), /Included in your free shot/);
  assert.match(await card.innerText(), /720p.*5s/s);
  assert(await page.getByRole("combobox", { name: "QUALITY", exact: true }).isDisabled());
  assert(await page.getByRole("slider", { name: "LENGTH", exact: true }).isDisabled());
  await noModelPicker(page);
  await noBrowserErrors(state);
  await state.context.close();

  const unavailable = await createScreen(owner, { ...allAvailable, "seedance-lite": false });
  await unavailable.page.getByRole("textbox", { name: "Describe your website" }).fill(prompts.motion);
  await recommendationCard(unavailable.page).getByText("The model included in your free shot is temporarily unavailable. Try again shortly.").waitFor();
  assert(await unavailable.page.getByRole("button", { name: "Build my website", exact: true }).isDisabled(), "Free shot must never silently switch to a paid model.");
  assert.equal(unavailable.generation.length + unavailable.otherAI.length, 0);
  await noBrowserErrors(unavailable);
  console.log("PASS free shot: included preset/price retained across prompts, no paid fallback if unavailable");
  await unavailable.context.close();
}

async function studio(owner) {
  const fixture = await studioFixture(owner);
  const state = await session(owner);
  const { page } = state;
  await page.goto(`${app}/studio/${fixture.project.id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Videos$/ }).click();
  await page.getByRole("button", { name: "Generate with AI", exact: true }).click();
  const prompt = page.getByRole("textbox", { name: "Describe the video shot" });
  await prompt.fill(prompts.stylized);
  await recommendationCard(page).getByText("Hailuo 2.3", { exact: true }).waitFor();
  await prompt.fill(prompts.motion);
  await recommendationCard(page).getByText(/^Kling /).waitFor();
  await noModelPicker(page);
  const quote = Number((await recommendationCard(page).innerText()).match(/(\d+) credits/)?.[1]);
  await page.getByRole("button", { name: /^Generate video ·/ }).click();
  await page.getByText("Verification intercepted generation; no credits spent.", { exact: true }).waitFor();
  assert.equal(state.generation.length, 1);
  assert.equal(state.generation[0].videoId, fixture.video.id);
  assert.equal(state.generation[0].prompt, prompts.motion);
  assert.equal(state.generation[0].cost, quote, "Studio generation must submit the displayed quote.");
  assert.equal(state.generation[0].recommendationSettings.resolution, "720p");
  await noBrowserErrors(state);
  console.log("PASS studio: shot prompt drives visible recommendation and generation submits matching model/settings/price");

  // A completed local fixture exposes the plain-language extra-video composer.
  checked(await admin.from("project_videos").update({ status: "succeeded", url: `${app}/ReferenceVids/hero-scrub-mobile.mp4` }).eq("id", fixture.video.id), "Mark local fixture ready");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Videos$/ }).click();
  const composer = page.getByPlaceholder("e.g. now a slow close-up of the beans being roasted");
  const extraCard = page.getByRole("status").filter({ hasText: /^Recommended:/ });
  await composer.fill(prompts.stylized);
  await extraCard.getByText(/Recommended: Hailuo 2.3/).waitFor();
  await composer.fill(prompts.motion);
  await extraCard.getByText(/Recommended: Kling /).waitFor();
  const extraQuote = Number((await extraCard.innerText()).match(/(\d+) credits/)?.[1]);
  assert.equal(await composer.getAttribute("maxlength"), "2000", "Chat and server must rank the same bounded prompt.");
  await composer.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Send" && !button.disabled));
  assert.equal(state.generation.length, 2, "Extra-video request should only submit once.");
  assert.equal(state.generation[1].request, prompts.motion);
  assert.equal(state.generation[1].cost, extraQuote);
  assert.equal(await composer.inputValue(), prompts.motion, "Stale quote failure must preserve the request for review and retry.");
  await noBrowserErrors(state);
  console.log("PASS extra video: chat prompt changes model, Enter sends displayed quote, failure preserves request without automatic retry");
  await state.context.close();
}

async function verify() {
  const paid = await account();
  await paidCreate(paid);
  await unavailableCreate(paid);
  await studio(paid);
  const free = await account(false);
  await freeCreate(free);
}

try {
  await verify();
  for (const owner of accounts) {
    const after = checked(await admin.from("profiles").select("credits, subscription_credits, free_video_used, free_site_used").eq("id", owner.id).single(), "Read final allowances");
    assert.deepEqual(after, owner.before, "Recommendation browsing must not spend credits or free allowances.");
    const ledger = checked(await admin.from("credit_ledger").select("id").eq("user_id", owner.id), "Read test ledger");
    assert.equal(ledger.length, 0, "Recommendation browsing must not add ledger entries.");
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  const failures = [];
  await browser?.close().catch((error) => failures.push(error.message));
  for (const owner of accounts) {
    await owner.auth.auth.signOut().catch(() => {});
    const result = await admin.auth.admin.deleteUser(owner.id);
    if (result.error) failures.push(`Account cleanup (${owner.id}): ${result.error.message}`);
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("CLEANUP complete: disposable accounts, sessions and project data removed");
  }
}
