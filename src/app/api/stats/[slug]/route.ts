import { NextRequest } from "next/server";
import { applyRateLimit } from "@/lib/auth";
import { AppError, getSlugStats } from "@/lib/links";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

export async function GET(request: NextRequest, context: Ctx) {
  try {
    const rl = applyRateLimit(request);
    if (rl) return rl;
    const denied = await requireAdmin();
    if (denied) return denied;

    const { slug } = await context.params;
    if (!slug) {
      return Response.json(
        { success: false, error: "Slug is required" },
        { status: 400 }
      );
    }
    const stats = await getSlugStats(slug);
    return Response.json({ success: true, ...stats });
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    console.error("GET /api/stats/:slug", error);
    return Response.json(
      { success: false, error: "Failed to load slug stats" },
      { status: 500 }
    );
  }
}
