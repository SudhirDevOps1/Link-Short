import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { blockedIps } from "@/db/schema";

/** Check if a (hashed) IP is currently blocked. */
export async function isIpBlocked(ipHash: string | null | undefined): Promise<boolean> {
  if (!ipHash) return false;
  const [row] = await db
    .select({ id: blockedIps.id })
    .from(blockedIps)
    .where(eq(blockedIps.ipHash, ipHash))
    .limit(1);
  return Boolean(row);
}

export async function listBlockedIps() {
  return db.select().from(blockedIps).orderBy(desc(blockedIps.createdAt));
}

export async function blockIpHash(ipHash: string, reason?: string | null) {
  const [row] = await db
    .insert(blockedIps)
    .values({ ipHash, reason: reason?.trim() || null })
    .onConflictDoUpdate({
      target: blockedIps.ipHash,
      set: { reason: reason?.trim() || null },
    })
    .returning();
  return row;
}

export async function unblockIpById(id: number) {
  await db.delete(blockedIps).where(eq(blockedIps.id, id));
}
