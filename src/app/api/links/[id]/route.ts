import { NextRequest } from "next/server";
import { applyRateLimit, clientIp } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  AppError,
  deleteLink,
  getLinkById,
  serializeLink,
  updateLink,
  type LinkStatus,
} from "@/lib/links";
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

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Ctx) {
  try {
    const rl = applyRateLimit(request);
    if (rl) return rl;
    const denied = await requireAdmin();
    if (denied) return denied;

    const { id } = await context.params;
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) {
      return Response.json({ success: false, error: "Invalid id" }, { status: 400 });
    }

    const link = await getLinkById(numId);
    if (!link) {
      return Response.json(
        { success: false, error: "Link not found" },
        { status: 404 }
      );
    }
    return Response.json({
      success: true,
      data: serializeLink(link, originFrom(request)),
    });
  } catch (error) {
    console.error("GET /api/links/:id", error);
    return Response.json(
      { success: false, error: "Failed to fetch link" },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest, context: Ctx) {
  try {
    const rl = applyRateLimit(request);
    if (rl) return rl;
    const csrf = ensureSameOrigin(request);
    if (csrf) return csrf;
    const denied = await requireAdmin();
    if (denied) return denied;

    const { id } = await context.params;
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) {
      return Response.json({ success: false, error: "Invalid id" }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const before = await getLinkById(numId);
    const status: LinkStatus | undefined =
      body.status === "active" || body.status === "paused" || body.status === "deleted"
        ? body.status
        : undefined;

    const updated = await updateLink(numId, {
      url: body.url,
      slug: body.slug,
      title: body.title,
      status,
      expiresAt: body.expires_at ?? body.expiresAt,
      password: body.password,
      redirectType: body.redirect_type ?? body.redirectType,
    });

    const user = await getCurrentUser();
    const action =
      status && before && status !== before.status
        ? status === "paused"
          ? "link.pause"
          : status === "active"
            ? "link.resume"
            : "link.delete"
        : "link.update";

    await logAudit({
      actorType: "admin",
      actorId: user?.id,
      action,
      targetType: "link",
      targetId: numId,
      metadata: { slug: updated.slug },
      ipHash: hashIp(clientIp(request)),
    });

    return Response.json({
      success: true,
      data: serializeLink(updated, originFrom(request)),
    });
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    console.error("PUT /api/links/:id", error);
    return Response.json(
      { success: false, error: "Failed to update link" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest, context: Ctx) {
  try {
    const rl = applyRateLimit(request);
    if (rl) return rl;
    const csrf = ensureSameOrigin(request);
    if (csrf) return csrf;
    const denied = await requireAdmin();
    if (denied) return denied;

    const { id } = await context.params;
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) {
      return Response.json({ success: false, error: "Invalid id" }, { status: 400 });
    }

    const hard = request.nextUrl.searchParams.get("hard") === "true";
    const existing = await getLinkById(numId);
    const result = await deleteLink(numId, hard);

    const user = await getCurrentUser();
    await logAudit({
      actorType: "admin",
      actorId: user?.id,
      action: hard ? "link.delete.hard" : "link.delete",
      targetType: "link",
      targetId: numId,
      metadata: { slug: existing?.slug },
      ipHash: hashIp(clientIp(request)),
    });

    return Response.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    console.error("DELETE /api/links/:id", error);
    return Response.json(
      { success: false, error: "Failed to delete link" },
      { status: 500 }
    );
  }
}
