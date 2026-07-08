import { desc } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { toIso } from "@/lib/utils";

export type ActorType = "admin" | "public" | "system";

export async function logAudit(entry: {
  actorType: ActorType;
  actorId?: number | null;
  action: string;
  targetType?: string | null;
  targetId?: string | number | null;
  metadata?: Record<string, unknown> | null;
  ipHash?: string | null;
}) {
  try {
    await db.insert(auditLogs).values({
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId !== undefined && entry.targetId !== null ? String(entry.targetId) : null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      ipHash: entry.ipHash ?? null,
    });
  } catch (err) {
    // Auditing must never break the primary request flow.
    console.error("[shortly] Failed to write audit log", err);
  }
}

export async function listAuditLogs(options: { page?: number; limit?: number }) {
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(100, Math.max(1, options.limit || 25));
  const offset = (page - 1) * limit;

  const rows = await db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({
    id: r.id,
    actor_type: r.actorType,
    actor_id: r.actorId,
    action: r.action,
    target_type: r.targetType,
    target_id: r.targetId,
    metadata: r.metadata ? safeParse(r.metadata) : null,
    created_at: toIso(r.createdAt),
  }));
}

function safeParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
