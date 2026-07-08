import { NextRequest } from "next/server";
import { applyRateLimit, clientIp } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { isIpBlocked } from "@/lib/blockedIps";
import { verifyCaptcha } from "@/lib/crypto";
import { AppError, createLink, serializeLink } from "@/lib/links";
import { checkUrlSafety, checkWindowLimit, isHoneypotTriggered } from "@/lib/security";
import { hashIp } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Public URL-shortening endpoint.
 * Anyone (external clients, no-auth) can create a short link here,
 * but the response only exposes safe/public fields, and the request
 * passes through several anti-spam / anti-abuse layers:
 *  1. Short-window rate limit (20 req/min/IP)
 *  2. Daily creation cap (40 links/day/IP)
 *  3. IP blocklist check
 *  4. Honeypot field (bots fill hidden fields)
 *  5. Math CAPTCHA (stateless, signed token)
 *  6. Destination URL safety checks (no private IPs, no self-redirect loops)
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  const ipHash = hashIp(ip);

  const rl = applyRateLimit(request, {
    bucket: "shorten",
    limit: 20,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const daily = checkWindowLimit(`shorten-daily:${ip}`, 40, 24 * 60 * 60_000);
  if (!daily.allowed) {
    return Response.json(
      {
        success: false,
        error: "Daily link creation limit reached for your network. Try again tomorrow.",
      },
      { status: 429 }
    );
  }

  if (await isIpBlocked(ipHash)) {
    return Response.json(
      { success: false, error: "Your network has been blocked due to abuse." },
      { status: 403 }
    );
  }

  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    // Honeypot: a hidden field ("company") that only bots fill in.
    if (isHoneypotTriggered(body.company)) {
      await logAudit({
        actorType: "system",
        action: "shorten.honeypot_blocked",
        ipHash,
      });
      // Respond with a generic error (don't reveal detection mechanism).
      return Response.json(
        { success: false, error: "Request could not be processed" },
        { status: 400 }
      );
    }

    // CAPTCHA verification (stateless, signed token minted by /api/captcha)
    if (!verifyCaptcha(body.captcha_token, body.captcha_answer)) {
      return Response.json(
        { success: false, error: "Captcha verification failed. Please try again." },
        { status: 400 }
      );
    }

    if (typeof body.url !== "string") {
      return Response.json(
        { success: false, error: "A valid URL is required" },
        { status: 400 }
      );
    }

    const origin =
      process.env.NEXT_PUBLIC_APP_URL ||
      request.nextUrl.origin ||
      "http://localhost:3000";

    const safety = checkUrlSafety(body.url.trim(), origin);
    if (!safety.ok) {
      return Response.json({ success: false, error: safety.reason }, { status: 400 });
    }

    const created = await createLink({
      url: body.url,
      slug: typeof body.slug === "string" ? body.slug : undefined,
      title: null,
      expiresAt: null,
      password: null,
      redirectType: 302,
      reuseExisting: true,
      createdByIpHash: ipHash,
    });

    await logAudit({
      actorType: "public",
      action: "link.create",
      targetType: "link",
      targetId: created.id,
      metadata: { slug: created.slug },
      ipHash,
    });

    const full = serializeLink(created, origin);
    // Only expose public fields (never leak status, has_password, etc.)
    return Response.json(
      {
        success: true,
        data: {
          slug: full.slug,
          short_url: full.short_url,
          url: full.url,
          created_at: full.created_at,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    console.error("POST /api/shorten", error);
    return Response.json(
      { success: false, error: "Failed to create link" },
      { status: 500 }
    );
  }
}
