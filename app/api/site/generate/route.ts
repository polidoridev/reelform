import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { spendCredits, grantCredits } from "@/lib/credits";
import { isAdminUser } from "@/lib/admin";
import { generateSite, buildInitialBrief, buildEditBrief } from "@/lib/claude";
import {
  FREE_TIER,
  estimateBuildCredits,
  meteredCredits,
  EDIT_MIN_CREDITS,
  resolveModel,
  type ModelId,
} from "@/lib/pricing";
import { listVideos, readyVideos } from "@/lib/videos";
import { authorizeSiteBuild, releaseFree } from "@/lib/entitlements";

// Streams the generated HTML as plain text. If something goes wrong after
// the stream has started, an error sentinel line is appended for the client.
export const maxDuration = 300;

// Kept in sync with components/Studio.tsx (route files may only export handlers).
const ERROR_SENTINEL = "\n<<<REELFORM_ERROR>>>";

interface Body {
  projectId: string;
  mode: "create" | "edit";
  model: ModelId;
  // create
  name?: string;
  industry?: string;
  siteBrief?: string;
  // edit
  instruction?: string;
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // Bounds provider spend per account, credits cap total spend, not rate.
  const limited = await enforceRateLimit(user.id, "site_generate");
  if (limited) return limited;

  const body = (await request.json()) as Body;
  // Retired ids resolve to their successor rather than erroring: a stale
  // client or an old project row should not fail a build.
  const model = resolveModel(body.model);

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, industry, site_brief, site_html")
    .eq("id", body.projectId)
    .single();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const videos = readyVideos(await listVideos(supabase, project.id));
  if (videos.length === 0) {
    return NextResponse.json({ error: "Upload or generate a video first" }, { status: 400 });
  }

  let brief: string;
  let userMessage: string;
  if (body.mode === "edit") {
    if (!body.instruction?.trim() || !project.site_html) {
      return NextResponse.json({ error: "Nothing to edit" }, { status: 400 });
    }
    userMessage = body.instruction.trim();
    brief = buildEditBrief({
      instruction: userMessage,
      currentHtml: project.site_html,
      videos,
    });
  } else {
    if (!body.siteBrief?.trim()) {
      return NextResponse.json({ error: "Describe the website first" }, { status: 400 });
    }
    userMessage = body.siteBrief.trim();
    brief = buildInitialBrief({
      name: body.name?.trim() || project.name,
      industry: body.industry?.trim() || "General",
      siteBrief: userMessage,
      videos,
    });
  }

  // The free build covers one *create*; edits are subscribers-only.
  const isAdmin = isAdminUser(user.id);
  let freeBuild = false;
  let hold = 0;
  // The model and output ceiling actually used. A free build is pinned to the
  // cheap end regardless of what the client asked for: the picker is a paid
  // feature, and an unpinned free build could run Opus to the full cap.
  const quote = estimateBuildCredits(model);
  let runModel: ModelId = model;
  let outputBudget = quote.outputBudget;

  if (!isAdmin) {
    const grant = await authorizeSiteBuild(supabase, user.id, body.mode === "edit" ? "edit" : "create");
    if (!grant.ok) {
      return NextResponse.json({ error: grant.reason, message: grant.message }, { status: 402 });
    }
    freeBuild = grant.billing === "free";
    if (freeBuild) {
      runModel = FREE_TIER.siteModel;
      outputBudget = FREE_TIER.siteOutputBudget;
    } else {
      hold = quote.hold;
      const ok = await spendCredits(user.id, hold, "site_generation", body.projectId);
      if (!ok) {
        return NextResponse.json({ error: "insufficient_credits", cost: hold }, { status: 402 });
      }
    }
  }

  // A build that produced nothing usable shouldn't burn the one free site.
  const refundFree = async () => {
    if (freeBuild) await releaseFree(user.id, "site");
  };

  // Full undo, for the hard-failure path where nothing was produced at all.
  const refund = async () => {
    await refundFree();
    if (!freeBuild && !isAdmin && hold > 0) {
      await grantCredits(user.id, hold, "refund", body.projectId);
    }
  };

  const admin = createSupabaseAdmin();
  // Persist brief metadata up front so the project reflects the latest inputs.
  await admin
    .from("projects")
    .update({
      name: body.name?.trim() || project.name,
      industry: body.industry?.trim() || project.industry,
      site_brief: body.mode === "create" ? userMessage : project.site_brief,
      model,
      updated_at: new Date().toISOString(),
    })
    .eq("id", body.projectId);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await generateSite({
          model: runModel,
          brief,
          outputBudget,
          onText: (delta) => controller.enqueue(encoder.encode(delta)),
        });

        // Give back everything the build did not spend. The hold is priced at
        // the output ceiling, so this only ever refunds.
        const settle = async () => {
          if (isAdmin || freeBuild || hold <= 0) return;
          const actual = Math.max(EDIT_MIN_CREDITS, meteredCredits(runModel, result.usage));
          if (actual < hold) {
            await grantCredits(user.id, hold - actual, "refund", body.projectId).catch(() => {});
          }
          return actual;
        };

        if (result.refused || !result.html.trim()) {
          // A refusal still burned tokens at the provider, so it settles to the
          // real usage rather than refunding in full, otherwise a loop of
          // deliberately-refused briefs is free provider spend on our account.
          await settle();
          await refundFree();
          controller.enqueue(
            encoder.encode(`${ERROR_SENTINEL}The model declined this request. You were only charged for what it used, so try rephrasing.`)
          );
          controller.close();
          return;
        }

        await settle();

        await admin
          .from("projects")
          .update({ site_html: result.html, updated_at: new Date().toISOString() })
          .eq("id", body.projectId);

        await admin.from("messages").insert([
          {
            project_id: body.projectId,
            user_id: user.id,
            role: "user",
            target: "claude",
            content: userMessage,
          },
          {
            project_id: body.projectId,
            user_id: user.id,
            role: "assistant",
            target: "claude",
            content: body.mode === "edit" ? "Updated the site." : "Built the first version of the site.",
          },
        ]);

        controller.close();
      } catch (err) {
        await refund().catch(() => {});
        const message = err instanceof Error ? err.message : "Generation failed";
        controller.enqueue(encoder.encode(`${ERROR_SENTINEL}${message} You have not been charged.`));
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
