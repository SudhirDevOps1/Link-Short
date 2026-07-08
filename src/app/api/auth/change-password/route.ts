import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { ensureSameOrigin, getCurrentUser, setSessionCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const csrf = ensureSameOrigin(request);
  if (csrf) return csrf;

  const me = await getCurrentUser();
  if (!me) {
    return Response.json(
      { success: false, error: "Authentication required" },
      { status: 401 }
    );
  }

  const body = await request.json().catch(() => null);
  const current = typeof body?.current_password === "string" ? body.current_password : "";
  const next = typeof body?.new_password === "string" ? body.new_password : "";

  if (!current || !next) {
    return Response.json(
      { success: false, error: "Current and new password required" },
      { status: 400 }
    );
  }
  if (next.length < 8) {
    return Response.json(
      { success: false, error: "New password must be at least 8 characters" },
      { status: 400 }
    );
  }
  if (!verifyPassword(current, me.passwordHash)) {
    return Response.json(
      { success: false, error: "Current password is incorrect" },
      { status: 401 }
    );
  }

  const newHash = hashPassword(next);
  const newTv = me.tokenVersion + 1;

  await db
    .update(users)
    .set({ passwordHash: newHash, tokenVersion: newTv })
    .where(eq(users.id, me.id));

  await setSessionCookie({ id: me.id, tokenVersion: newTv });

  return Response.json({ success: true });
}
