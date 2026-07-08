import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { verifyPassword } from "@/lib/crypto";
import { applyRateLimit, clientIp } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { ensureAdminUser } from "@/lib/bootstrap";
import { setSessionCookie } from "@/lib/session";
import { hashIp } from "@/lib/utils";

export const dynamic = "force-dynamic";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000; // 15 minutes

export async function POST(request: NextRequest) {
  // Aggressive rate limit on login: 10 attempts / 5 min / IP (independent
  // of the per-account lockout below).
  const limited = applyRateLimit(request, {
    bucket: "login",
    limit: 10,
    windowMs: 5 * 60_000,
  });
  if (limited) return limited;

  await ensureAdminUser();

  const ipHash = hashIp(clientIp(request));
  const body = await request.json().catch(() => null);
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!username || !password) {
    return Response.json(
      { success: false, error: "Username and password required" },
      { status: 400 }
    );
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    return Response.json(
      {
        success: false,
        error: `Account temporarily locked due to failed login attempts. Try again in ${minutes} minute(s).`,
      },
      { status: 423 }
    );
  }

  // Constant-time-ish: always run verify against a dummy hash if user missing
  // (avoids leaking user existence via timing).
  const stored =
    user?.passwordHash ||
    `scrypt$16384$8$1$${"0".repeat(32)}$${"0".repeat(128)}`;
  const ok = verifyPassword(password, stored);

  if (!user || !ok) {
    if (user) {
      const attempts = user.failedAttempts + 1;
      const lockedUntil =
        attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : null;
      await db
        .update(users)
        .set({
          failedAttempts: lockedUntil ? 0 : attempts,
          lockedUntil,
        })
        .where(eq(users.id, user.id));

      if (lockedUntil) {
        await logAudit({
          actorType: "system",
          action: "auth.account_locked",
          targetType: "user",
          targetId: user.id,
          ipHash,
        });
      }
    }
    await logAudit({
      actorType: "system",
      action: "auth.login_failed",
      metadata: { username },
      ipHash,
    });
    return Response.json(
      { success: false, error: "Invalid credentials" },
      { status: 401 }
    );
  }

  await db
    .update(users)
    .set({ lastLoginAt: new Date(), failedAttempts: 0, lockedUntil: null })
    .where(eq(users.id, user.id));

  await setSessionCookie({ id: user.id, tokenVersion: user.tokenVersion });

  await logAudit({
    actorType: "admin",
    actorId: user.id,
    action: "auth.login_success",
    ipHash,
  });

  return Response.json({
    success: true,
    user: { id: user.id, username: user.username, role: user.role },
  });
}
