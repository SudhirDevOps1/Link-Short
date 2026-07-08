import { NextRequest } from "next/server";
import { clearSessionCookie, ensureSameOrigin } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const csrf = ensureSameOrigin(request);
  if (csrf) return csrf;
  await clearSessionCookie();
  return Response.json({ success: true });
}
