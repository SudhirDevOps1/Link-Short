import Link from "next/link";
import { redirect } from "next/navigation";
import LoginForm from "@/components/LoginForm";
import { ensureAdminUser } from "@/lib/bootstrap";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  await ensureAdminUser();
  const user = await getCurrentUser();
  if (user) {
    redirect("/admin");
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200"
          >
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-sky-500 font-bold text-slate-950">
              S
            </span>
            <span className="font-semibold text-white">Shortly</span>
          </Link>
        </div>
        <LoginForm />
        <p className="mt-4 text-center text-xs text-slate-500">
          Not the owner? <Link href="/" className="text-sky-400 hover:underline">Go to the public shortener →</Link>
        </p>
      </div>
    </main>
  );
}
