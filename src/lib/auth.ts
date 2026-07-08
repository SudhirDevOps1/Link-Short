import { NextRequest } from "next/server";

/**
 * Optional API key auth for /api/* mutating and listing endpoints.
 * If API_KEY env is not set, endpoints are open (local/dev friendly).
 */
export function requireApiKey(request: NextRequest): Response | null {
  const expected = process.env.API_KEY;
  if (!expected) return null;

  const header =
    request.headers.get("x-api-key") ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!header || header !== expected) {
    return Response.json(
      { success: false, error: "Unauthorized. Provide a valid API key." },
      { status: 401 }
    );
  }

  return null;
}

/**
 * Simple in-memory rate limiter (per isolate / process).
 * Good enough for single-instance previews; production would use Redis/KV.
 */
const hits = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  limit = 100,
  windowMs = 60_000
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  entry.count += 1;
  return { allowed: true, remaining: limit - entry.count };
}

export function clientIp(request: NextRequest): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function applyRateLimit(
  request: NextRequest,
  opts: { bucket?: string; limit?: number; windowMs?: number } = {}
): Response | null {
  const ip = clientIp(request);
  const bucket = opts.bucket || "api";
  const result = rateLimit(`${bucket}:${ip}`, opts.limit ?? 100, opts.windowMs ?? 60_000);
  if (!result.allowed) {
    return Response.json(
      { success: false, error: "Rate limit exceeded. Try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((opts.windowMs ?? 60_000) / 1000)),
          "X-RateLimit-Remaining": "0",
        },
      }
    );
  }
  return null;
}
