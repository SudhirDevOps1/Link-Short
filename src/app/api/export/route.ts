import { NextRequest } from "next/server";
import { applyRateLimit } from "@/lib/auth";
import { listLinks } from "@/lib/links";
import { requireAdmin } from "@/lib/session";
import { csvEscape } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Admin-only CSV export of all links (including paused/deleted) */
export async function GET(request: NextRequest) {
  try {
    const rl = applyRateLimit(request);
    if (rl) return rl;
    const denied = await requireAdmin();
    if (denied) return denied;

    const origin =
      process.env.NEXT_PUBLIC_APP_URL ||
      request.nextUrl.origin ||
      "http://localhost:3000";

    const all = [];
    let page = 1;
    for (;;) {
      const batch = await listLinks({ page, limit: 100, status: "all" });
      all.push(...batch.data);
      if (page >= batch.pagination.totalPages || page > 50) break;
      page += 1;
    }

    const header = [
      "id",
      "slug",
      "short_url",
      "url",
      "title",
      "clicks",
      "created_at",
      "last_clicked",
      "status",
      "expires_at",
    ];

    const lines = [header.join(",")];
    for (const link of all) {
      lines.push(
        [
          link.id,
          link.slug,
          `${origin.replace(/\/$/, "")}/${link.slug}`,
          link.url,
          link.title,
          link.clicks,
          link.createdAt?.toISOString?.() || "",
          link.lastClicked?.toISOString?.() || "",
          link.status,
          link.expiresAt?.toISOString?.() || "",
        ]
          .map(csvEscape)
          .join(",")
      );
    }

    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="links-export.csv"`,
      },
    });
  } catch (error) {
    console.error("GET /api/export", error);
    return Response.json(
      { success: false, error: "Failed to export" },
      { status: 500 }
    );
  }
}
