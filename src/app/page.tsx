import Link from "next/link";
import PublicShortener from "@/components/PublicShortener";
import { getCurrentUser } from "@/lib/session";
import { ensureAdminUser } from "@/lib/bootstrap";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await ensureAdminUser();
  const user = await getCurrentUser();

  return (
    <main className="relative min-h-screen">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_40%_at_50%_0%,rgba(56,189,248,0.15),transparent)]"
      />
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-sky-500 font-bold text-slate-950">
            S
          </div>
          <span className="text-lg font-semibold text-white">Shortly</span>
        </div>
        <nav className="flex items-center gap-2 text-sm">
          {user ? (
            <Link
              href="/admin"
              className="rounded-lg bg-sky-500 px-3 py-1.5 font-semibold text-slate-950 hover:bg-sky-400"
            >
              Open dashboard
            </Link>
          ) : (
            <Link
              href="/login"
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800"
            >
              Admin login
            </Link>
          )}
        </nav>
      </header>

      <section className="mx-auto flex max-w-6xl flex-col items-center px-6 pb-20 pt-8 text-center sm:pt-16">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-300">
          Privacy-friendly · Free forever
        </div>
        <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          Turn long URLs into <span className="text-sky-400">short links</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-slate-400">
          Anyone can create short links here. Analytics, editing, and rename
          controls live in the private admin dashboard.
        </p>

        <div className="mt-10 flex w-full justify-center">
          <PublicShortener />
        </div>
      </section>

      <footer className="mx-auto max-w-6xl border-t border-slate-800/60 px-6 py-6 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} Shortly · Owner-managed URL shortener
      </footer>
    </main>
  );
}
