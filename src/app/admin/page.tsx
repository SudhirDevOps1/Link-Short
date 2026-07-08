import { redirect } from "next/navigation";
import Dashboard from "@/components/Dashboard";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <Dashboard username={user.username} />;
}
