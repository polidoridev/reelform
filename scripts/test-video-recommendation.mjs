// Pure routing and provider-free API verification. No accounts, credits, or
// renders are created. Usage: node scripts/test-video-recommendation.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import ts from "typescript";

function load(file, mocks = {}, cache = new Map()) {
  const filename = resolve(file);
  if (cache.has(filename)) return cache.get(filename);
  const compiledModule = { exports: {} };
  cache.set(filename, compiledModule.exports);
  const js = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const require = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id.startsWith(".")) return load(resolve(dirname(filename), `${id}.ts`), mocks, cache);
    throw new Error(`Unmocked dependency: ${id}`);
  };
  new Function("require", "module", "exports", js)(require, compiledModule, compiledModule.exports);
  return compiledModule.exports;
}

const provider = load("lib/higgsfield.ts");
const pricing = load("lib/pricing.ts");
const routing = load("lib/video-recommendation.ts");
const { recommendVideoModel, matchesVideoRecommendation } = routing;
const available = Object.fromEntries(provider.VIDEO_MODELS.map((model) => [model.id, true]));
const settings = { resolution: "720p", duration: 5, ratio: "16:9" };
const quote = (prompt, overrides = {}) => recommendVideoModel({ prompt, settings, available, ...overrides });

assert.equal(quote("An expressive cartoon in a fantasy forest").model, "hailuo-2.3");
assert.equal(quote("A cinematic tracking shot of an athlete").model, "kling-2.5-turbo-pro");
assert.equal(quote("First enter the garden, then sit down; finally lift the cup").model, "sora-2");
assert.equal(quote("A low cost draft of the room").model, "seedance-lite");
assert.equal(quote("I need a quick render of the landscape").model, "seedance-pro-fast");
assert.equal(quote("A macro close-up of a handmade ceramic product").model, "seedance-lite");
assert.equal(quote("A field of flowers").model, "seedance-lite");
assert.equal(quote("A sequence of actions", { settings: { ...settings, duration: 12, resolution: "1080p" } }).model, "sora-2-pro");
assert.equal(quote("A cinematic orbit", { settings: { ...settings, ratio: "21:9" } }).ratio, "21:9");
assert.equal(quote("Stylized illustration", { available: {} }), null);
assert.equal(quote("Stylized illustration", { available: { "hailuo-2.3": false } }), null);
assert.equal(quote("Stylized illustration", { available: { "hailuo-2.3": "true" } }), null);
const fallback = quote("An expressive cartoon", { available: { "seedance-pro-fast": true } });
assert.equal(fallback.model, "seedance-pro-fast");
assert.match(fallback.reason, /unavailable/);
const free = quote("A cinematic sequence", { pinned: true, settings: { resolution: "1080p", duration: 12, ratio: "9:16" } });
assert.deepEqual({ model: free.model, resolution: free.resolution, duration: free.duration }, pricing.FREE_TIER.video);
assert.equal(free.ratio, "9:16");
assert.equal(free.cost, 0);
assert.equal(quote("anything", { pinned: true, available: { "wan-2.5": true } }), null);
for (const prompt of ["A cartoon", "Cinematic orbit", "First open, then close", "Quick render", "", "A product shot"]) {
  for (const resolution of ["480p", "720p", "1080p"]) {
    for (const duration of [4, 5, 6, 8, 10, 12]) {
      for (const ratio of ["16:9", "9:16", "1:1", "21:9"]) {
        const rec = quote(prompt, { settings: { resolution, duration, ratio } });
        const actual = provider.resolveShot(rec.model, { resolution, duration, ratio });
        assert.equal(rec.duration, actual.duration);
        assert.equal(rec.resolution, actual.resolution ?? "720p");
        assert.equal(rec.ratio, actual.ratio ?? "16:9");
        assert.equal(rec.cost, pricing.videoCost(rec.model, rec.resolution, rec.duration));
        assert.equal(matchesVideoRecommendation(rec, rec), true);
        assert.equal(matchesVideoRecommendation({ ...rec, cost: rec.cost + 1 }, rec), false);
      }
    }
  }
}

// Confirm safe access probes never carry a prompt and never fail open.
const originalFetch = globalThis.fetch;
try {
  for (const status of [400, 422, 401, 403, 404, 429, 500]) {
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(init.body, "{}");
      return new Response("", { status });
    };
    const access = await provider.checkModelAccess();
    assert.equal(calls, provider.VIDEO_MODELS.length);
    assert(Object.values(access).every((value) => value === (status === 400 || status === 422)));
  }
  globalThis.fetch = async () => { throw new Error("network unavailable"); };
  assert(Object.values(await provider.checkModelAccess()).every((value) => value === false));
} finally {
  globalThis.fetch = originalFetch;
}

function harness(route, options = {}) {
  const events = [];
  const profile = options.free ? { plan: "free", plan_status: null, free_video_used: Boolean(options.freeUsed) } : { plan: "starter", plan_status: "active" };
  const clip = { id: "video", project_id: "project", position: 0, status: "none", settings: {}, updated_at: "now" };
  let saved;
  function builder(table, admin = false) {
    const b = {
      select: () => b,
      eq: () => b,
      update: (data) => { saved = data; events.push({ type: "save", data }); return b; },
      insert: (data) => { if (table === "project_videos") saved = data; events.push({ type: "insert", table, data }); return b; },
      single: async () => ({ data: table === "profiles" ? profile : table === "projects"
        ? { id: "project", name: "Test", industry: "Art", site_brief: "A portfolio" }
        : admin ? { ...clip, ...saved } : clip }),
      maybeSingle: async () => ({ data: { id: "video" } }),
    };
    return b;
  }
  const mocks = {
    "next/server": { NextResponse: { json: (data, init) => Response.json(data, init) } },
    "@/lib/supabase/server": { createSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user" } } }) }, from: (table) => builder(table) }) },
    "@/lib/supabase/admin": { createSupabaseAdmin: () => ({ from: (table) => builder(table, true) }) },
    "@/lib/rate-limit": { enforceRateLimit: async () => null },
    "@/lib/admin": { isAdminUser: () => Boolean(options.admin) },
    "@/lib/entitlements": {
      isSubscribed: (p) => p.plan === "starter",
      authorizeVideo: async () => { events.push({ type: "authorize" }); return options.denied ? { ok: false, reason: "subscription_required", message: "Subscribe" } : { ok: true, billing: options.free ? "free" : "credits" }; },
      releaseFree: async () => { events.push({ type: "releaseFree" }); },
    },
    "@/lib/credits": {
      spendCredits: async (_user, cost) => { events.push({ type: "spend", cost }); return !options.insufficient; },
      grantCredits: async (_user, cost) => { events.push({ type: "refund", cost }); },
    },
    "@/lib/higgsfield": { createVideoTask: async (params) => { events.push({ type: "render", params }); if (options.providerFailure) throw new Error("Provider down"); return { taskId: "task" }; } },
    "@/lib/video-recommendation": routing,
    "@/lib/video-model-access": { getVideoModelAccess: async () => options.available ?? available },
    "@/lib/videos": {
      syncPrimaryVideo: async () => {},
      listVideos: async () => [{ ...clip, status: "succeeded", prompt: "A hero", label: "Hero", mode: "loop" }],
      MAX_VIDEOS_PER_PROJECT: 6, VIDEO_COLUMNS: "id",
    },
    "@/lib/claude": { planClip: async () => { events.push({ type: "plan" }); return options.planFailure ? null : { prompt: "The planned render prompt", label: "Second shot", mode: "loop", reply: "Planned" }; } },
  };
  const { POST } = load(`app/api/video/${route}/route.ts`, mocks);
  return {
    events,
    async submit(body) {
      const response = await POST(new Request(`http://localhost/api/video/${route}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
      return { status: response.status, data: await response.json() };
    },
  };
}

for (const route of ["generate", "request"]) {
  const prompt = "First open the door, then approach the desk";
  const rec = quote(prompt);
  const body = { videoId: "video", projectId: "project", prompt: "The planned render prompt", recommendationPrompt: prompt, request: prompt, recommendationSettings: settings, ...rec };
  for (const patch of [{ model: "wan-2.5" }, { cost: 0 }, { duration: 12 }, { ratio: "9:16" }, { resolution: "1080p" }]) {
    const test = harness(route);
    const result = await test.submit({ ...body, ...patch });
    assert.equal(result.status, 409, `${route} must reject changed quotes`);
    assert.equal(result.data.error, "recommendation_changed");
    assert.equal(test.events.length, 0, "Stale quotes cannot authorize, charge, plan or render");
  }
  const unavailable = harness(route, { available: {} });
  assert.equal((await unavailable.submit(body)).status, 503);
  assert.equal(unavailable.events.length, 0);
  const changedAccess = harness(route, { available: { "seedance-lite": true } });
  assert.equal((await changedAccess.submit(body)).status, 409);
  assert.equal(changedAccess.events.length, 0);
  const success = harness(route);
  const result = await success.submit(body);
  assert.equal(result.status, 200);
  assert.equal(result.data.cost, rec.cost);
  assert.deepEqual(result.data.recommendation, rec);
  const render = success.events.find((event) => event.type === "render");
  assert.deepEqual(render.params, { prompt: "The planned render prompt", model: rec.model, resolution: rec.resolution, duration: rec.duration, ratio: rec.ratio });
  assert.equal(success.events.find((event) => event.type === "spend").cost, rec.cost);
  assert(success.events.findIndex((event) => event.type === "spend") < success.events.findIndex((event) => event.type === "render"));
  const failed = harness(route, { providerFailure: true });
  assert.equal((await failed.submit(body)).status, 502);
  assert.equal(failed.events.find((event) => event.type === "refund").cost, rec.cost);
  const denied = harness(route, { denied: true });
  assert.equal((await denied.submit(body)).status, 402);
  assert.deepEqual(denied.events.map((event) => event.type), ["authorize"]);
  const usedFree = harness(route, { free: true, freeUsed: true, denied: true });
  assert.equal((await usedFree.submit(body)).status, 402, "Used free allowances must reach the subscription gate, not loop on quote refresh");
  assert.deepEqual(usedFree.events.map((event) => event.type), ["authorize"]);
  const insufficient = harness(route, { insufficient: true });
  assert.equal((await insufficient.submit(body)).status, 402);
  assert.deepEqual(insufficient.events.map((event) => event.type), ["authorize", "spend"]);
  const admin = harness(route, { admin: true });
  assert.equal((await admin.submit(body)).data.cost, 0);
  assert(!admin.events.some((event) => event.type === "spend" || event.type === "authorize"));
  const wrongFree = harness(route, { free: true });
  assert.equal((await wrongFree.submit(body)).status, 409);
  assert.equal(wrongFree.events.length, 0);
  const freeQuote = quote(prompt, { pinned: true });
  const freeTest = harness(route, { free: true });
  assert.equal((await freeTest.submit({ ...body, ...freeQuote })).data.cost, 0);
  assert(!freeTest.events.some((event) => event.type === "spend"));
  assert.equal(freeTest.events.find((event) => event.type === "render").params.model, pricing.FREE_TIER.video.model);
  const failedFree = harness(route, { free: true, providerFailure: true });
  assert.equal((await failedFree.submit({ ...body, ...freeQuote })).status, 502);
  assert(failedFree.events.some((event) => event.type === "releaseFree"));
  const unavailableFree = harness(route, { free: true, available: { "wan-2.5": true } });
  assert.equal((await unavailableFree.submit({ ...body, ...freeQuote })).status, 503);
  assert.equal(unavailableFree.events.length, 0);
}
console.log("Video recommendations verified: prompt matching, formats/pricing, safe access probes, quote protection, explicit provider selection, free/admin allowances, and refunds.");
