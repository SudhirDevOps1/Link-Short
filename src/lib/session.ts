import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, type User } from "@/db/schema";
import { signSession, verifySession } from "@/lib/crypto";

export const SESSION_COOKIE = "shortly_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

function isProd() {
  return process.env.NODE_ENV === "production";
}

export async function setSessionCookie(user: Pick<User, "id" | "tokenVersion">) {
  const token = signSession(
    { uid: user.id, tv: user.tokenVersion },
    SESSION_TTL_SECONDS
  );
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function getCurrentUser(): Promise<User | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const payload = verifySession(token);
  if (!payload) return null;
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, payload.uid))
    .limit(1);
  if (!user) return null;
  if (user.tokenVersion !== payload.tv) return null;
  return user;
}

export async function requireAdmin(): Promise<Response | null> {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json(
      { success: false, error: "Authentication required" },
      { status: 401 }
    );
  }
  if (user.role !== "admin") {
    return Response.json(
      { success: false, error: "Admin access required" },
      { status: 403 }
    );
  }
  return null;
}

/**
 * CSRF defense-in-depth for cookie-authenticated state-changing requests.
 * Rejects when Origin/Referer does not match the request host.
 * Safe for same-origin fetch from our own dashboard.
 */
export function ensureSameOrigin(request: NextRequest): Response | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  const sourceHost = (() => {
    try {
      if (origin) return new URL(origin).host;
      if (referer) return new URL(referer).host;
    } catch {
      return null;
    }
    return null;
  })();

  // If cookie is present, require matching origin
  const hasCookie = request.headers.get("cookie")?.includes(`${SESSION_COOKIE}=`);
  if (!hasCookie) return null;

  if (!sourceHost || sourceHost !== host) {
    return Response.json(
      { success: false, error: "Cross-origin request blocked" },
      { status: 403 }
    );
  }
  return null;
}
