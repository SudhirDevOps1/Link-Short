import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ success: true, user: null });
  }
  return Response.json({
    success: true,
    user: { id: user.id, username: user.username, role: user.role },
  });
}
