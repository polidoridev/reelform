import { NextResponse } from "next/server";
import { getVideoModelAccess } from "@/lib/video-model-access";

// GET /api/video/models: which catalog models this Higgsfield account may call.
//
// Higgsfield gates model access per account, and there is no endpoint that
// lists what we're entitled to, so this probes each model (see
// checkModelAccess, the probe cannot start a render). The answer changes about
// as often as a billing plan does, hence the long cache. Recommendations and
// generation share this cache so unavailable models are excluded in both.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { available: await getVideoModelAccess() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
