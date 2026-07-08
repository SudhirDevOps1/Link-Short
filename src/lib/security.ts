import { isIP } from "net";

/** Max accepted destination URL length (guards against abuse / storage bloat) */
export const MAX_URL_LENGTH = 2048;

/** File extensions we refuse to shorten (common malware delivery vectors) */
const DISALLOWED_EXTENSIONS = [
  ".exe",
  ".scr",
  ".bat",
  ".cmd",
  ".msi",
  ".apk",
  ".jar",
];

/** RFC1918 / loopback / link-local ranges we refuse to redirect users into. */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 0) return true; // "this" network
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "::1" || // loopback
    h.startsWith("fe80:") || // link-local
    h.startsWith("fc") ||
    h.startsWith("fd") // unique local fc00::/7
  );
}

export type UrlCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Validates a destination URL against basic abuse-prevention rules:
 * - length cap
 * - http/https only (enforced upstream too)
 * - blocks localhost / private / link-local IP targets (SSRF-adjacent hygiene)
 * - blocks obviously dangerous file extensions
 * - blocks linking back to our own short-link domain (prevents redirect loops)
 */
export function checkUrlSafety(rawUrl: string, appOrigin?: string): UrlCheckResult {
  if (rawUrl.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `URL exceeds maximum length of ${MAX_URL_LENGTH} characters` };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Malformed URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Only http:// and https:// URLs are allowed" };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "Links to localhost are not allowed" };
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && isPrivateIPv4(hostname)) {
    return { ok: false, reason: "Links to private/internal IP addresses are not allowed" };
  }
  if (ipVersion === 6 && isPrivateIPv6(hostname)) {
    return { ok: false, reason: "Links to private/internal IP addresses are not allowed" };
  }

  if (appOrigin) {
    try {
      const appHost = new URL(appOrigin).hostname;
      if (appHost && hostname === appHost) {
        return { ok: false, reason: "Cannot shorten a link that points back to this service" };
      }
    } catch {
      /* ignore malformed app origin */
    }
  }

  const lowerPath = parsed.pathname.toLowerCase();
  if (DISALLOWED_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))) {
    return { ok: false, reason: "Links to executable files are not allowed" };
  }

  return { ok: true };
}

/** Honeypot field check — bots fill hidden fields, humans never see them. */
export function isHoneypotTriggered(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Simple in-memory sliding-window limiter reused for per-IP daily caps
 * (e.g. max short links created per IP per day) independent of the
 * short-window API rate limiter.
 */
const windows = new Map<string, { count: number; resetAt: number }>();

export function checkWindowLimit(
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = windows.get(key);
  if (!entry || entry.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }
  if (entry.count >= limit) {
    return { allowed: false, remaining: 0 };
  }
  entry.count += 1;
  return { allowed: true, remaining: limit - entry.count };
}
