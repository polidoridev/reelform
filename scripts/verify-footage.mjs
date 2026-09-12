// Integration check against a running local app and its configured Supabase.
// Uses disposable confirmed accounts and synthetic footage; never calls AI or
// email endpoints. Every owned test row, storage object and session is removed.
// Usage: node scripts/verify-footage.mjs [--browser | --browser-only]
// Optional: FOOTAGE_TEST_APP, PLAYWRIGHT_CHANNEL, FOOTAGE_TEST_SCREENSHOT.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import ffmpeg from "ffmpeg-static";

nextEnv.loadEnvConfig(process.cwd());
const app = process.env.FOOTAGE_TEST_APP || "http://localhost:3000";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(app).hostname), "Use a local app URL for this verification.");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(url && anonKey && serviceKey, "Supabase environment variables are required.");
const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }) },
};
const admin = createClient(url, serviceKey, clientOptions);
const storageClient = createClient(url, anonKey, clientOptions);
const directory = mkdtempSync(join(tmpdir(), "reelform-footage-"));
const accounts = [];
const projects = [];
const storageObjects = new Map();
let browser;

function checked(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

function rememberObject(bucket, path) {
  if (!storageObjects.has(bucket)) storageObjects.set(bucket, new Set());
  storageObjects.get(bucket).add(path);
}

function rememberPublicUrl(publicUrl) {
  const match = new URL(publicUrl).pathname.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
  assert(match, "Final video must use permanent public storage.");
  rememberObject(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
}

async function account() {
  const password = `Footage-check-${randomUUID()}`;
  const email = `footage-check+${randomUUID()}@reelform.test`;
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
  // Keep these disposable accounts out of any scheduled product email run.
  checked(await admin.from("profiles").update({ marketing_opt_in: false, email_bounced_at: new Date().toISOString(), is_private: true }).eq("id", user.id), "Silence test email");
  checked(await auth.auth.signInWithPassword({ email, password }), "Sign in test account");
  return entry;
}

async function api(account, path, method = "POST", body, expected = 200) {
  const cookie = account ? [...account.cookies.values()].map((c) => `${c.name}=${c.value}`).join("; ") : "";
  const response = await fetch(`${app}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(150_000),
  });
  const data = response.headers.get("content-type")?.includes("application/zip")
    ? Buffer.from(await response.arrayBuffer())
    : await response.json();
  assert([expected].flat().includes(response.status), `${method} ${path}: expected ${expected}, got ${response.status}: ${Buffer.isBuffer(data) ? "zip" : JSON.stringify(data)}`);
  return data;
}

function fixture(extension, duration = 1) {
  const path = join(directory, `fixture-${duration}.${extension}`);
  const codec = extension === "webm" ? ["-c:v", "libvpx-vp9", "-deadline", "realtime"] : ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=12", "-t", String(duration), "-an", ...codec, path], { timeout: 30_000 });
  return { path, bytes: readFileSync(path), filename: `own-footage.${extension}`, contentType: extension === "mov" ? "video/quicktime" : `video/${extension}` };
}

async function stage(account, videoId, file) {
  const signed = await api(account, "/api/video/upload", "POST", { videoId, filename: file.filename, contentType: file.contentType, size: file.bytes.length });
  assert(signed.bucket && signed.path && signed.token, "Signed upload is incomplete.");
  rememberObject(signed.bucket, signed.path);
  checked(await storageClient.storage.from(signed.bucket).uploadToSignedUrl(signed.path, signed.token, file.bytes, { contentType: signed.contentType }), "Direct signed upload");
  return { videoId, path: signed.path, filename: file.filename };
}

async function upload(account, videoId, file) {
  const body = await stage(account, videoId, file);
  const { video } = await api(account, "/api/video/upload", "PATCH", body);
  assert.equal(video.status, "succeeded");
  assert.equal(video.task_id, null);
  assert.equal(video.prompt, null, "Uploaded footage must not retain an old generated-shot prompt.");
  assert.equal(video.settings.source, "upload");
  assert.equal(video.settings.cost, 0);
  assert.match(video.url, /\.mp4$/);
  rememberPublicUrl(video.url);
  const downloaded = await fetch(video.url, { signal: AbortSignal.timeout(30_000) });
  assert(downloaded.ok, "Uploaded video must be publicly playable.");
  const normalized = join(directory, `${video.id}.mp4`);
  writeFileSync(normalized, Buffer.from(await downloaded.arrayBuffer()));
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", normalized, "-f", "null", "-"], { timeout: 30_000 });
  return video;
}

function unzip(bytes) {
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const size = bytes.readUInt32LE(offset + 18);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString();
    const start = offset + 30 + nameSize + extraSize;
    const value = bytes.subarray(start, start + size);
    assert([0, 8].includes(method), "Unsupported ZIP compression.");
    entries.set(name, method === 0 ? value : inflateRawSync(value));
    offset = start + size;
  }
  return entries;
}

async function collectObjects(bucket, prefix) {
  const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) {
    if (/not found|does not exist/i.test(error.message)) return;
    throw new Error(`Storage inventory (${bucket}): ${error.message}`);
  }
  for (const object of data || []) {
    const path = `${prefix}/${object.name}`;
    if (object.id) rememberObject(bucket, path);
    else await collectObjects(bucket, path);
  }
}

async function browserContext(account) {
  const { chromium } = await import("playwright");
  browser ||= await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([...account.cookies.values()].filter((c) => c.value).map((c) => ({ name: c.name, value: c.value, url: app, httpOnly: !!c.options?.httpOnly, sameSite: "Lax" })));
  return context;
}

async function verifyBrowser(account, projectId, videoUrl) {
  const context = await browserContext(account);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A test regression must never start a paid generation or send a message.
  await page.route(/\/api\/(video\/(generate|request)|site\/(generate|edit|suggest-shot)|email\/)/, (route) => route.abort());
  await page.goto(`${app}/studio/${projectId}`, { waitUntil: "networkidle" });
  assert(new URL(page.url()).pathname === `/studio/${projectId}`, "Studio must remain authenticated.");
  await page.getByRole("button", { name: /Videos$/ }).click();
  await page.locator(`video[src="${videoUrl}"]`).first().waitFor({ timeout: 30_000 });
  await page.waitForFunction((src) => [...document.querySelectorAll("video")].some((v) => v.src === src && v.readyState >= 1 && v.videoWidth > 0), videoUrl);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Videos$/ }).click();
  await page.locator(`video[src="${videoUrl}"]`).first().waitFor();
  await page.locator(`video[src="${videoUrl}"]`).first().evaluate(async (video) => {
    video.muted = true;
    await video.play();
    video.pause();
    video.currentTime = Math.min(0.25, video.duration / 2);
  });
  await page.waitForFunction((src) => [...document.querySelectorAll("video")].some((v) => v.src === src && v.readyState >= 2 && !v.seeking && v.currentTime > 0 && v.videoWidth > 0), videoUrl);
  const pixels = await page.locator(`video[src="${videoUrl}"]`).first().evaluate((video) => ({ width: video.videoWidth, height: video.videoHeight, time: video.currentTime, state: video.readyState }));
  assert(pixels.width > 0 && pixels.height > 0 && pixels.time > 0 && pixels.state >= 2, "Uploaded footage must decode and seek after reload.");
  await page.getByRole("heading", { name: "Add your footage" }).scrollIntoViewIfNeeded();
  assert.equal(await page.locator("[data-nextjs-dialog], .vite-error-overlay").count(), 0);
  assert.deepEqual(errors, [], "Studio has JavaScript errors.");
  if (process.env.FOOTAGE_TEST_SCREENSHOT) await page.screenshot({ path: process.env.FOOTAGE_TEST_SCREENSHOT, fullPage: true });
  console.log("PASS browser: authenticated studio, decoded footage and persistence after reload");
}

async function verifyCreateFlow() {
  const owner = await account();
  const context = await browserContext(owner);
  const page = await context.newPage();
  const errors = [];
  const requests = { projects: 0, prepare: 0, finalize: 0, site: 0, ai: 0 };
  let createdProjectId;
  let createdVideoUrl;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/projects" && request.method() === "POST") requests.projects++;
    if (path === "/api/video/upload" && request.method() === "POST") requests.prepare++;
    if (path === "/api/video/upload" && request.method() === "PATCH") requests.finalize++;
  });
  await page.route(/\/api\/(video\/(generate|request)|site\/(edit|suggest-shot)|email\/)/, (route) => {
    requests.ai++;
    return route.abort();
  });
  await page.route("**/api/site/generate", async (route) => {
    requests.site++;
    const body = route.request().postDataJSON();
    createdProjectId ||= body.projectId;
    if (!projects.includes(createdProjectId)) projects.push(createdProjectId);
    assert.equal(body.projectId, createdProjectId, "Retry must reuse the same project.");
    const clip = checked(await admin.from("project_videos").select("url,status,settings").eq("project_id", createdProjectId).eq("position", 0).single(), "Read create-flow hero");
    assert.equal(clip.status, "succeeded");
    assert.equal(clip.settings.source, "upload");
    createdVideoUrl = clip.url;
    rememberPublicUrl(clip.url);
    if (requests.site === 1) {
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Verification: retry the site build." }) });
    } else {
      const html = `<!doctype html><html><body><h1>Your uploaded footage</h1><video src="${clip.url}" muted playsinline controls></video></body></html>`;
      checked(await admin.from("projects").update({ site_html: html, site_brief: body.siteBrief }).eq("id", createdProjectId), "Save simulated site response");
      await route.fulfill({ status: 200, contentType: "text/plain", body: html });
    }
  });
  await page.goto(`${app}/create`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Scrub website/ }).click();
  assert(await page.getByRole("radio", { name: "Use my footage" }).isChecked(), "Own footage should be selected initially.");
  await page.getByRole("textbox", { name: "Describe your website" }).fill("A neighborhood coffee roastery. Show our own footage and invite visitors to book a tasting.");
  assert(await page.getByRole("button", { name: "Build my website" }).isDisabled(), "Build needs a selected clip.");
  await page.locator('input[type="file"]').setInputFiles({ name: "invalid.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await page.getByRole("alert").filter({ hasText: "Choose an MP4, MOV, or WebM video." }).waitFor();
  assert(await page.getByRole("button", { name: "Build my website" }).isDisabled());
  const file = fixture("mp4");
  await page.locator('input[type="file"]').setInputFiles(file.path);
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Build my website") && !button.disabled));
  await page.setViewportSize({ width: 375, height: 812 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Create flow must not overflow a 375px mobile viewport.");
  if (process.env.FOOTAGE_TEST_SCREENSHOT) await page.screenshot({ path: process.env.FOOTAGE_TEST_SCREENSHOT.replace(/\.png$/, "-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (process.env.FOOTAGE_TEST_SCREENSHOT) await page.screenshot({ path: process.env.FOOTAGE_TEST_SCREENSHOT.replace(/\.png$/, "-create.png"), fullPage: true });
  await page.getByRole("button", { name: "Build my website" }).click();
  await page.getByRole("alert").filter({ hasText: "Verification: retry the site build." }).waitFor({ timeout: 150_000 });
  assert.deepEqual(requests, { projects: 1, prepare: 1, finalize: 1, site: 1, ai: 0 });
  await page.getByRole("button", { name: "Build my website" }).click();
  await page.waitForURL(`**/studio/${createdProjectId}`, { timeout: 60_000 });
  assert.deepEqual(requests, { projects: 1, prepare: 1, finalize: 1, site: 2, ai: 0 }, "Retry must not recreate a project, reupload footage, or generate an AI shot.");
  assert.deepEqual(errors, [], "Create flow has JavaScript errors.");
  console.log("PASS browser: actual create/upload flow, invalid file feedback, failed-build retry reuses footage, studio navigation; no AI video calls");
  await verifyBrowser(owner, createdProjectId, createdVideoUrl);
}

async function main() {
  await api(null, "/api/video/upload", "POST", {}, 401);
  const owner = await account();
  const stranger = await account();
  const before = checked(await admin.from("profiles").select("credits, subscription_credits, free_video_used, free_site_used").eq("id", owner.id).single(), "Read initial balance");
  const project = await api(owner, "/api/projects", "POST", { name: "Disposable footage verification", videoMode: "scrub" });
  projects.push(project.id);
  assert(project.heroVideoId, "Create flow must return a hero slot.");
  const mp4 = fixture("mp4", 0.25);
  const body = { videoId: project.heroVideoId, filename: mp4.filename, contentType: mp4.contentType, size: mp4.bytes.length };
  await api(stranger, "/api/video/upload", "POST", body, 404);
  await api(owner, "/api/video/upload", "POST", { ...body, size: 50 * 1024 * 1024 + 1 }, [400, 413]);
  await api(owner, "/api/video/upload", "POST", { ...body, filename: "clip.svg", contentType: "image/svg+xml" }, [400, 415]);
  for (const status of ["queued", "running"]) {
    checked(await admin.from("project_videos").update({ status }).eq("id", project.heroVideoId), "Set active status");
    await api(owner, "/api/video/upload", "POST", body, 409);
  }
  checked(await admin.from("project_videos").update({ status: "none" }).eq("id", project.heroVideoId), "Reset active status");
  console.log("PASS authorization and file metadata validation");

  // Some browsers provide no MIME for a valid extension; use the server's type.
  const hero = await upload(owner, project.heroVideoId, { ...mp4, contentType: "" });
  assert.equal(hero.mode, "scrub");
  const mirror = checked(await admin.from("projects").select("video_url,video_status,video_mode,video_settings").eq("id", project.id).single(), "Read project mirror");
  assert.equal(mirror.video_url, hero.url);
  assert.equal(mirror.video_status, "succeeded");
  assert.equal(mirror.video_mode, "scrub");
  const clips = [hero];
  for (const extension of ["mov", "webm"]) {
    const { video } = await api(owner, "/api/videos", "POST", { projectId: project.id });
    clips.push(await upload(owner, video.id, fixture(extension)));
  }
  const { video: boundarySlot } = await api(owner, "/api/videos", "POST", { projectId: project.id });
  const boundary = await upload(owner, boundarySlot.id, fixture("mp4", 60));
  assert.equal(boundary.settings.duration, 60);
  clips.push(boundary);
  console.log("PASS MP4, MOV and WebM upload, empty MIME, subsecond/exact60s duration, decoding and hero mirror");

  const superseded = await stage(owner, hero.id, mp4);
  const current = await stage(owner, hero.id, mp4);
  await api(owner, "/api/video/upload", "PATCH", superseded, 409);
  await api(owner, "/api/video/upload", "DELETE", superseded, 409);
  await api(owner, "/api/video/upload", "DELETE", { ...current, path: `${stranger.id}/arbitrary.mp4` }, 409);
  checked(await admin.from("project_videos").update({ status: "running" }).eq("id", hero.id), "Set active finalization status");
  await api(owner, "/api/video/upload", "PATCH", current, 409);
  checked(await admin.from("project_videos").update({ status: "succeeded" }).eq("id", hero.id), "Restore ready status");
  await api(owner, "/api/video/upload", "DELETE", current);
  await api(owner, "/api/video/upload", "PATCH", current, 409);
  console.log("PASS superseded/cancelled upload isolation, arbitrary-path rejection and active finalization guard");

  const corrupt = await stage(owner, hero.id, { ...mp4, bytes: Buffer.from("This is not a video") });
  await api(stranger, "/api/video/upload", "PATCH", corrupt, 404);
  await api(owner, "/api/video/upload", "PATCH", corrupt, [400, 415, 422]);
  const long = await stage(owner, hero.id, fixture("mp4", 61));
  await api(owner, "/api/video/upload", "PATCH", long, [400, 413, 422]);
  const persisted = checked(await admin.from("project_videos").select("url,status").eq("id", hero.id).single(), "Read preserved video");
  assert.equal(persisted.url, hero.url);
  assert.equal(persisted.status, "succeeded");
  console.log("PASS finalization authorization, corrupt/overlong media rejection and original footage preservation");

  // Supply known HTML to isolate export from paid site generation.
  const html = `<!doctype html><html><body>${clips.map((clip) => `<video src="${clip.url}" muted playsinline controls></video>`).join("")}</body></html>`;
  checked(await admin.from("projects").update({ site_html: html }).eq("id", project.id), "Set export fixture");
  const archive = unzip(await api(owner, "/api/site/export", "POST", { projectId: project.id }));
  const bundledHtml = archive.get("index.html")?.toString();
  assert(bundledHtml, "Export needs index.html.");
  for (let i = 0; i < clips.length; i++) {
    const name = i === 0 ? "video.mp4" : `video-${i + 1}.mp4`;
    assert(archive.get(name)?.length > 0, `Export is missing ${name}.`);
    assert(bundledHtml.includes(`src="${name}"`), "Export must reference local video files.");
    assert(!bundledHtml.includes(clips[i].url), "Export must not retain storage URLs.");
  }
  const after = checked(await admin.from("profiles").select("credits, subscription_credits, free_video_used, free_site_used").eq("id", owner.id).single(), "Read final balance");
  assert.deepEqual(after, before, "Own footage must not spend credits or free generation allowances.");
  const ledger = checked(await admin.from("credit_ledger").select("id").eq("user_id", owner.id), "Read ledger");
  assert.equal(ledger.length, 0, "Uploads must not create paid generation ledger entries.");
  console.log("PASS self-contained ZIP export, unchanged credits and free allowances");
  if (process.argv.includes("--browser")) {
    await verifyBrowser(owner, project.id, hero.url);
    await verifyCreateFlow();
  }
}

try {
  if (process.argv.includes("--browser-only")) await verifyCreateFlow();
  else await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  const failures = [];
  await browser?.close().catch((error) => failures.push(error.message));
  // The UI can fail before its new project reaches the simulated site request.
  // Discover every project owned by these test accounts before storage cleanup.
  for (const account of accounts) {
    const result = await admin.from("projects").select("id").eq("user_id", account.id);
    if (result.error) failures.push(`Project inventory: ${result.error.message}`);
    for (const project of result.data || []) {
      if (!projects.includes(project.id)) projects.push(project.id);
    }
  }
  // Also catch output saved just before an interrupted finalization response.
  for (const id of projects) {
    await collectObjects("videos", id).catch((error) => failures.push(error.message));
  }
  for (const account of accounts) {
    await collectObjects("video-uploads", account.id).catch((error) => failures.push(error.message));
  }
  for (const [bucket, paths] of storageObjects) {
    const result = await admin.storage.from(bucket).remove([...paths]);
    if (result.error) failures.push(`Storage cleanup (${bucket}): ${result.error.message}`);
  }
  // Deleting auth users cascades profiles, projects, clips, ledger and limits.
  for (const account of accounts) {
    await account.auth.auth.signOut().catch(() => {});
    const result = await admin.auth.admin.deleteUser(account.id);
    if (result.error) failures.push(`Account cleanup (${account.id}): ${result.error.message}`);
  }
  rmSync(directory, { recursive: true, force: true });
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("CLEANUP complete: disposable accounts, project data and recorded storage objects removed");
  }
}
