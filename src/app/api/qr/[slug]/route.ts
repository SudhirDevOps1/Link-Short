import { NextRequest } from "next/server";
import { applyRateLimit } from "@/lib/auth";
import { getLinkBySlug } from "@/lib/links";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/**
 * QR code endpoint. Public so it can be embedded in shared pages,
 * but rate-limited. Only reveals whether the slug exists.
 */
export async function GET(request: NextRequest, context: Ctx) {
  try {
    const rl = applyRateLimit(request, {
      bucket: "qr",
      limit: 60,
      windowMs: 60_000,
    });
    if (rl) return rl;

    const { slug } = await context.params;
    const link = await getLinkBySlug(slug, true);
    if (!link) {
      return Response.json(
        { success: false, error: "Link not found" },
        { status: 404 }
      );
    }

    const origin =
      process.env.NEXT_PUBLIC_APP_URL ||
      request.nextUrl.origin ||
      "http://localhost:3000";
    const shortUrl = `${origin.replace(/\/$/, "")}/${link.slug}`;
    const size = request.nextUrl.searchParams.get("size") || "300x300";
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${encodeURIComponent(
      size
    )}&data=${encodeURIComponent(shortUrl)}`;

    if (request.nextUrl.searchParams.get("raw") === "1") {
      const img = await fetch(qrUrl);
      if (!img.ok) {
        return Response.json(
          { success: false, error: "QR provider error" },
          { status: 502 }
        );
      }
      const buffer = await img.arrayBuffer();
      return new Response(buffer, {
        headers: {
          "Content-Type": img.headers.get("Content-Type") || "image/png",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    return Response.json({
      success: true,
      slug: link.slug,
      short_url: shortUrl,
      qr_url: qrUrl,
      size,
    });
  } catch (error) {
    console.error("GET /api/qr/:slug", error);
    return Response.json(
      { success: false, error: "Failed to generate QR" },
      { status: 500 }
    );
  }
}
