import { createHash, randomBytes } from "crypto";

const SLUG_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Generate a URL-safe random slug */
export function generateSlug(length = 6): string {
  const bytes = randomBytes(length);
  let slug = "";
  for (let i = 0; i < length; i++) {
    slug += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return slug;
}

/** Validate absolute http(s) URL */
export function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Validate custom slug: 2-64 chars, alnum + dash/underscore */
export function isValidSlug(slug: string): boolean {
  return /^[a-zA-Z0-9_-]{2,64}$/.test(slug);
}

/** Reserved path segments that cannot be used as slugs */
export const RESERVED_SLUGS = new Set([
  "api",
  "admin",
  "dashboard",
  "health",
  "static",
  "favicon.ico",
  "robots.txt",
  "_next",
  "assets",
]);

/** Privacy-friendly IP hash (no raw IPs stored) */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/** Build absolute short URL for a slug */
export function buildShortUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/$/, "")}/${slug}`;
}

/** Format date for API responses */
export function toIso(date: Date | null | undefined): string | null {
  if (!date) return null;
  return date.toISOString();
}

/** Escape CSV cell */
export function csvEscape(
  value: string | number | boolean | null | undefined
): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Last N calendar days as YYYY-MM-DD (UTC) */
export function lastNDates(n: number): string[] {
  const dates: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)
    );
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}
