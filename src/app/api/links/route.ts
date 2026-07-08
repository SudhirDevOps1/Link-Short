import { NextRequest } from "next/server";
import { applyRateLimit, clientIp } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { AppError, createLink, listLinks, serializeLink, type LinkStatus } from "@/lib/links";
import { ensureSameOrigin, getCurrentUser, requireAdmin } from "@/lib/session";
import { hashIp } from "@/lib/utils";

export const dynamic = "force-dynamic";

function originFrom(request: NextRequest) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    request.nextUrl.origin ||
    "http://localhost:3000"
  );
}

const VALID_STATUSES: (LinkStatus | "all")[] = ["active", "paused", "deleted", "all"];

/** Admin-only list */
export async function GET(request: NextRequest) {
  try {
    const rl = applyRateLimit(request);
    if (rl) return rl;
    const denied = await requireAdmin();
    if (denied) return denied;

    const { searchParams } = request.nextUrl;
    const page = Number(searchParams.get("page") || "1");
    const limit = Number(searchParams.get("limit") || "20");
    const search = searchParams.get("search") || undefined;
    const statusParam = searchParams.get("status");
    const status =
      statusParam && VALID_STATUSES.includes(statusParam as LinkStatus | "all")
        ? (statusParam as LinkStatus | "all")
        : undefined;

    const result = await listLinks({ page, limit, search, status });
    const origin = originFrom(request);

    return Response.json({
      success: true,
      data: result.data.map((l) => serializeLink(l, origin)),
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("GET /api/links", error);
    return Response.json(
      { success: false, error: "Failed to list links" },
      { status: 500 }
    );
  }
}

/** Admin-only create (full-featured: expiry, password, redirect type) */
export async function POST(request: NextRequest) {
  try {
    const rl = applyRateLimit(request);
    if (rl) return rl;
    const csrf = ensureSameOrigin(request);
    if (csrf) return csrf;
    const denied = await requireAdmin();
    if (denied) return denied;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const created = await createLink({
      url: body.url,
      slug: body.slug,
      title: body.title,
      expiresAt: body.expires_at ?? body.expiresAt,
      password: body.password,
      redirectType: body.redirect_type ?? body.redirectType,
      reuseExisting: body.reuse_existing ?? body.reuseExisting,
    });

    const user = await getCurrentUser();
    await logAudit({
      actorType: "admin",
      actorId: user?.id,
      action: "link.create",
      targetType: "link",
      targetId: created.id,
      metadata: { slug: created.slug, url: created.url },
      ipHash: hashIp(clientIp(request)),
    });

    return Response.json(
      { success: true, data: serializeLink(created, originFrom(request)) },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    console.error("POST /api/links", error);
    return Response.json(
      { success: false, error: "Failed to create link" },
      { status: 500 }
    );
  }
}
