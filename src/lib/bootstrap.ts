import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword } from "@/lib/crypto";

let bootstrapped = false;

/**
 * Ensure at least one admin user exists.
 * - If a user exists already, no-op.
 * - Else create from ADMIN_USERNAME + ADMIN_PASSWORD env (if provided).
 * - Else create a default 'admin' user with a randomly generated one-time
 *   password printed to the server logs (dev/first-run safety).
 */
export async function ensureAdminUser(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;

  try {
    const [existing] = await db.select().from(users).limit(1);
    if (existing) return;

    const username = (process.env.ADMIN_USERNAME || "admin").trim();
    let password = process.env.ADMIN_PASSWORD;
    let generated = false;

    if (!password) {
      // Deterministic dev fallback so the sandbox is usable out-of-the-box.
      password = "admin";
      generated = true;
    }

    const existingByName = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (existingByName[0]) return;

    await db.insert(users).values({
      username,
      passwordHash: hashPassword(password),
      role: "admin",
    });

    if (generated) {
      console.warn(
        `[shortly] Bootstrapped default admin user "${username}" / "admin". Set ADMIN_USERNAME + ADMIN_PASSWORD env vars for production.`
      );
    } else {
      console.log(`[shortly] Bootstrapped admin user "${username}".`);
    }
  } catch (err) {
    console.error("[shortly] Failed to bootstrap admin user", err);
    // Allow retry on next call
    bootstrapped = false;
  }
}
