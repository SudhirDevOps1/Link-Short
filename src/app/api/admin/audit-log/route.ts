import { NextRequest } from "next/server";
import { applyRateLimit } from "@/lib/auth";
import { listAuditLogs } from "@/lib/audit";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Admin-only: recent security/audit trail (logins, link mutations, IP blocks). */
export async function GET(request: NextRequest) {
  const rl = applyRateLimit(request);
  if (rl) return rl;
  const denied = await requireAdmin();
  if (denied) return denied;

  const page = Number(request.nextUrl.searchParams.get("page") || "1");
  const limit = Number(request.nextUrl.searchParams.get("limit") || "25");

  const data = await listAuditLogs({ page, limit });
  return Response.json({ success: true, data });
}
