import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ensureAdminUser } from "@/lib/bootstrap";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await ensureAdminUser();
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return <>{children}</>;
}
