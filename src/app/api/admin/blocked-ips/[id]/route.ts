import { NextRequest } from "next/server";
import { applyRateLimit, clientIp } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { unblockIpById } from "@/lib/blockedIps";
import { ensureSameOrigin, getCurrentUser, requireAdmin } from "@/lib/session";
import { hashIp } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(request: NextRequest, context: Ctx) {
  const rl = applyRateLimit(request);
  if (rl) return rl;
  const csrf = ensureSameOrigin(request);
  if (csrf) return csrf;
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await context.params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return Response.json({ success: false, error: "Invalid id" }, { status: 400 });
  }

  await unblockIpById(numId);

  const user = await getCurrentUser();
  await logAudit({
    actorType: "admin",
    actorId: user?.id,
    action: "ip.unblock",
    targetType: "blocked_ip",
    targetId: numId,
    ipHash: hashIp(clientIp(request)),
  });

  return Response.json({ success: true });
}
