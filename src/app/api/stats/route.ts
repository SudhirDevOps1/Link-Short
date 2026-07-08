import { NextRequest } from "next/server";
import { applyRateLimit } from "@/lib/auth";
import { getOverallStats } from "@/lib/links";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const rl = applyRateLimit(request);
    if (rl) return rl;
    const denied = await requireAdmin();
    if (denied) return denied;

    const stats = await getOverallStats();
    return Response.json({ success: true, ...stats });
  } catch (error) {
    console.error("GET /api/stats", error);
    return Response.json(
      { success: false, error: "Failed to load stats" },
      { status: 500 }
    );
  }
}
