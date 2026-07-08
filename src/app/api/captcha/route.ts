import { NextRequest } from "next/server";
import { applyRateLimit } from "@/lib/auth";
import { createCaptcha } from "@/lib/crypto";

export const dynamic = "force-dynamic";

/**
 * Issues a short-lived, stateless math CAPTCHA challenge for the public
 * shortening form. No server-side storage required — the answer is
 * embedded (never revealed) inside a signed token.
 */
export async function GET(request: NextRequest) {
  const rl = applyRateLimit(request, {
    bucket: "captcha",
    limit: 30,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const challenge = createCaptcha();
  return Response.json({ success: true, ...challenge });
}
