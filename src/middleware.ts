import { NextRequest, NextResponse } from "next/server";

/**
 * Reserved top-level paths that must NOT be treated as short slugs.
 * Keep in sync with src/lib/utils.ts::RESERVED_SLUGS.
 */
const RESERVED = new Set([
  "api",
  "admin",
  "login",
  "logout",
  "dashboard",
  "health",
  "static",
  "assets",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  "_next",
]);

/**
 * Rewrite bare short slugs (e.g. /abc123) to the redirect handler at /r/abc123.
 * Leaves app routes, API, static assets, and reserved paths alone.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname === "/" ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/r/") ||
    pathname.startsWith("/_next")
  ) {
    return NextResponse.next();
  }

  const segment = pathname.slice(1);
  if (!segment || segment.includes("/")) {
    return NextResponse.next();
  }

  if (RESERVED.has(segment.toLowerCase())) {
    return NextResponse.next();
  }

  if (!/^[a-zA-Z0-9_-]{2,64}$/.test(segment)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = `/r/${segment}`;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\..*).*)"],
};
