import { NextRequest } from "next/server";
import { applyRateLimit, clientIp } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { blockIpHash, listBlockedIps } from "@/lib/blockedIps";
import { ensureSameOrigin, getCurrentUser, requireAdmin } from "@/lib/session";
import { hashIp } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Admin-only: list currently blocked IPs (shown as hashes, never raw). */
export async function GET(request: NextRequest) {
  const rl = applyRateLimit(request);
  if (rl) return rl;
  const denied = await requireAdmin();
  if (denied) return denied;

  const rows = await listBlockedIps();
  return Response.json({
    success: true,
    data: rows.map((r) => ({
      id: r.id,
      ip_hash: r.ipHash,
      reason: r.reason,
      created_at: r.createdAt?.toISOString?.() || null,
    })),
  });
}

/**
 * Admin-only: block an IP address (submitted in plaintext by the admin,
 * e.g. copied from an audit log entry's source) or a raw hash directly.
 * We only ever persist the hashed form.
 */
export async function POST(request: NextRequest) {
  const rl = applyRateLimit(request);
  if (rl) return rl;
  const csrf = ensureSameOrigin(request);
  if (csrf) return csrf;
  const denied = await requireAdmin();
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  const ip = typeof body?.ip === "string" ? body.ip.trim() : "";
  const reason = typeof body?.reason === "string" ? body.reason : null;

  if (!ip) {
    return Response.json(
      { success: false, error: "IP address is required" },
      { status: 400 }
    );
  }

  const ipHash = hashIp(ip);
  if (!ipHash) {
    return Response.json({ success: false, error: "Invalid IP" }, { status: 400 });
  }

  const row = await blockIpHash(ipHash, reason);

  const user = await getCurrentUser();
  await logAudit({
    actorType: "admin",
    actorId: user?.id,
    action: "ip.block",
    targetType: "blocked_ip",
    targetId: row.id,
    metadata: { reason },
    ipHash: hashIp(clientIp(request)),
  });

  return Response.json(
    {
      success: true,
      data: {
        id: row.id,
        ip_hash: row.ipHash,
        reason: row.reason,
        created_at: row.createdAt?.toISOString?.() || null,
      },
    },
    { status: 201 }
  );
}
