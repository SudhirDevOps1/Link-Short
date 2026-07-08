"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import SecurityPanel from "@/components/SecurityPanel";

type LinkStatus = "active" | "paused" | "deleted";

type LinkRow = {
  id: number;
  slug: string;
  short_url: string;
  url: string;
  title: string | null;
  created_at: string | null;
  clicks: number;
  last_clicked: string | null;
  status: LinkStatus;
  is_active: boolean;
  is_expired: boolean;
  expires_at: string | null;
  redirect_type: number;
  has_password: boolean;
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

type Stats = {
  total_links: number;
  active_links: number;
  paused_links: number;
  total_clicks: number;
  clicks_last_7_days: number[];
  dates_last_7_days: string[];
  top_links: { slug: string; url: string; title: string | null; clicks: number }[];
};

type SlugStats = {
  slug: string;
  url: string;
  title: string | null;
  total_clicks: number;
  status: LinkStatus;
  is_expired: boolean;
  clicks_by_date: { date: string; clicks: number }[];
  clicks_by_country: { country: string; count: number }[];
  recent_clicks: {
    id: number;
    referrer: string | null;
    user_agent: string | null;
    country: string | null;
    city: string | null;
    timestamp: string | null;
  }[];
};

declare global {
  interface Window {
    Chart?: new (
      ctx: CanvasRenderingContext2D,
      config: Record<string, unknown>
    ) => { destroy: () => void; update: () => void };
  }
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function truncate(value: string, max = 48) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/** Convert an ISO date string to the value <input type="datetime-local"> expects */
function toDatetimeLocal(value: string | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function StatusBadge({ status, expired }: { status: LinkStatus; expired: boolean }) {
  if (expired) {
    return (
      <span className="inline-flex items-center rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-medium text-rose-300">
        Expired
      </span>
    );
  }
  if (status === "paused") {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300">
        Paused
      </span>
    );
  }
  if (status === "deleted") {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-700/50 px-2 py-0.5 text-xs font-medium text-slate-400">
        Deleted
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300">
      Active
    </span>
  );
}

export default function Dashboard({ username }: { username: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<"links" | "security">("links");
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 1,
  });
  const [stats, setStats] = useState<Stats | null>(null);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState<LinkStatus | "all">("all");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{ type: "ok" | "err"; message: string } | null>(
    null
  );

  const [url, setUrl] = useState("");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [redirectType, setRedirectType] = useState(302);
  const [expiresAt, setExpiresAt] = useState("");
  const [password, setPassword] = useState("");

  const [editLink, setEditLink] = useState<LinkRow | null>(null);
  const [editPassword, setEditPassword] = useState("");
  const [editExpiry, setEditExpiry] = useState("");
  const [analyticsSlug, setAnalyticsSlug] = useState<string | null>(null);
  const [slugStats, setSlugStats] = useState<SlugStats | null>(null);
  const [qrSlug, setQrSlug] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [showChangePw, setShowChangePw] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNext, setPwNext] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

  const overviewCanvas = useRef<HTMLCanvasElement | null>(null);
  const detailCanvas = useRef<HTMLCanvasElement | null>(null);
  const overviewChart = useRef<{ destroy: () => void } | null>(null);
  const detailChart = useRef<{ destroy: () => void } | null>(null);
  const chartReady = useRef(false);

  const showToast = useCallback((message: string, type: "ok" | "err" = "ok") => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const loadChartJs = useCallback(async () => {
    if (chartReady.current || typeof window === "undefined") return;
    if (window.Chart) {
      chartReady.current = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
      script.async = true;
      script.onload = () => {
        chartReady.current = true;
        resolve();
      };
      script.onerror = () => reject(new Error("Failed to load Chart.js"));
      document.body.appendChild(script);
    });
  }, []);

  const fetchLinks = useCallback(
    async (page = 1, q = search, status = statusFilter) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), limit: "10" });
        if (q.trim()) params.set("search", q.trim());
        if (status !== "all") params.set("status", status);
        const res = await fetch(`/api/links?${params.toString()}`);
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.error || "Failed to load links");
        }
        setLinks(json.data);
        setPagination(json.pagination);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Failed to load links", "err");
      } finally {
        setLoading(false);
      }
    },
    [search, statusFilter, showToast]
  );

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/stats");
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Stats failed");
      setStats(json);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    void fetchLinks(1, "", "all");
    void fetchStats();
    void loadChartJs().catch(console.error);
  }, [fetchLinks, fetchStats, loadChartJs]);

  useEffect(() => {
    if (!stats || !overviewCanvas.current) return;
    void loadChartJs()
      .then(() => {
        if (!window.Chart || !overviewCanvas.current) return;
        overviewChart.current?.destroy();
        const ctx = overviewCanvas.current.getContext("2d");
        if (!ctx) return;
        overviewChart.current = new window.Chart(ctx, {
          type: "line",
          data: {
            labels: stats.dates_last_7_days.map((d) => d.slice(5)),
            datasets: [
              {
                label: "Clicks (7 days)",
                data: stats.clicks_last_7_days,
                borderColor: "#38bdf8",
                backgroundColor: "rgba(56, 189, 248, 0.15)",
                fill: true,
                tension: 0.35,
                pointRadius: 3,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,0.1)" } },
              y: {
                beginAtZero: true,
                ticks: { color: "#94a3b8", precision: 0 },
                grid: { color: "rgba(148,163,184,0.1)" },
              },
            },
          },
        });
      })
      .catch(console.error);
  }, [stats, loadChartJs]);

  useEffect(() => {
    if (!slugStats || !detailCanvas.current) return;
    void loadChartJs()
      .then(() => {
        if (!window.Chart || !detailCanvas.current) return;
        detailChart.current?.destroy();
        const ctx = detailCanvas.current.getContext("2d");
        if (!ctx) return;
        detailChart.current = new window.Chart(ctx, {
          type: "bar",
          data: {
            labels: slugStats.clicks_by_date.map((d) => d.date.slice(5)),
            datasets: [
              {
                label: "Clicks",
                data: slugStats.clicks_by_date.map((d) => d.clicks),
                backgroundColor: "rgba(14, 165, 233, 0.65)",
                borderRadius: 6,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { color: "#94a3b8" }, grid: { display: false } },
              y: {
                beginAtZero: true,
                ticks: { color: "#94a3b8", precision: 0 },
                grid: { color: "rgba(148,163,184,0.1)" },
              },
            },
          },
        });
      })
      .catch(console.error);
  }, [slugStats, loadChartJs]);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          slug: slug || undefined,
          title: title || undefined,
          redirect_type: redirectType,
          expires_at: expiresAt ? new Date(expiresAt).toISOString() : undefined,
          password: password || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Create failed");
      }
      showToast(`Created /${json.data.slug}`);
      setUrl("");
      setSlug("");
      setTitle("");
      setExpiresAt("");
      setPassword("");
      await Promise.all([fetchLinks(1, search, statusFilter), fetchStats()]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Create failed", "err");
    } finally {
      setSubmitting(false);
    }
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
    void fetchLinks(1, searchInput, statusFilter);
  };

  const onFilterChange = (value: LinkStatus | "all") => {
    setStatusFilter(value);
    void fetchLinks(1, search, value);
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied to clipboard");
    } catch {
      showToast("Copy failed", "err");
    }
  };

  const onTogglePause = async (row: LinkRow) => {
    const nextStatus = row.status === "paused" ? "active" : "paused";
    try {
      const res = await fetch(`/api/links/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Update failed");
      showToast(nextStatus === "paused" ? `Paused /${row.slug}` : `Resumed /${row.slug}`);
      await Promise.all([fetchLinks(pagination.page, search, statusFilter), fetchStats()]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Update failed", "err");
    }
  };

  const onDelete = async (row: LinkRow) => {
    if (!confirm(`Delete short link /${row.slug}? This can be undone from the "deleted" filter.`))
      return;
    try {
      const res = await fetch(`/api/links/${row.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Delete failed");
      showToast(`Deleted /${row.slug}`);
      await Promise.all([fetchLinks(pagination.page, search, statusFilter), fetchStats()]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Delete failed", "err");
    }
  };

  const onRestore = async (row: LinkRow) => {
    try {
      const res = await fetch(`/api/links/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Restore failed");
      showToast(`Restored /${row.slug}`);
      await Promise.all([fetchLinks(pagination.page, search, statusFilter), fetchStats()]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Restore failed", "err");
    }
  };

  const openEdit = (row: LinkRow) => {
    setEditLink({ ...row });
    setEditPassword("");
    setEditExpiry(toDatetimeLocal(row.expires_at));
  };

  const onSaveEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editLink) return;
    try {
      const res = await fetch(`/api/links/${editLink.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: editLink.url,
          slug: editLink.slug,
          title: editLink.title,
          redirect_type: editLink.redirect_type,
          status: editLink.status,
          expires_at: editExpiry ? new Date(editExpiry).toISOString() : null,
          ...(editPassword ? { password: editPassword } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Update failed");
      showToast("Link updated");
      setEditLink(null);
      await Promise.all([fetchLinks(pagination.page, search, statusFilter), fetchStats()]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Update failed", "err");
    }
  };

  const clearEditPassword = async () => {
    if (!editLink) return;
    if (!confirm("Remove password protection from this link?")) return;
    try {
      const res = await fetch(`/api/links/${editLink.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "" }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Update failed");
      showToast("Password removed");
      setEditLink({ ...editLink, has_password: false });
      await fetchLinks(pagination.page, search, statusFilter);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Update failed", "err");
    }
  };

  const openAnalytics = async (slugValue: string) => {
    setAnalyticsSlug(slugValue);
    setSlugStats(null);
    try {
      const res = await fetch(`/api/stats/${encodeURIComponent(slugValue)}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Stats failed");
      setSlugStats(json);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Stats failed", "err");
      setAnalyticsSlug(null);
    }
  };

  const openQr = async (slugValue: string) => {
    setQrSlug(slugValue);
    setQrUrl(null);
    try {
      const res = await fetch(`/api/qr/${encodeURIComponent(slugValue)}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "QR failed");
      setQrUrl(json.qr_url);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "QR failed", "err");
      setQrSlug(null);
    }
  };

  const rangeLabel = useMemo(() => {
    if (!pagination.total) return "0 links";
    const start = (pagination.page - 1) * pagination.limit + 1;
    const end = Math.min(pagination.page * pagination.limit, pagination.total);
    return `${start}–${end} of ${pagination.total}`;
  }, [pagination]);

  return (
    <div className="mx-auto min-h-screen max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-300">
              Admin dashboard
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800/70 px-3 py-1 text-xs text-slate-300">
              Signed in as <strong className="ml-1 text-white">{username}</strong>
            </span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Shortly
          </h1>
          <p className="mt-2 max-w-xl text-sm text-slate-400">
            Create, edit, pause, expire, and analyze every short link. Security tools
            live under the Security tab.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <button
              type="button"
              onClick={() => setShowChangePw(true)}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300 hover:bg-slate-800"
            >
              Change password
            </button>
            <button
              type="button"
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                router.replace("/login");
                router.refresh();
              }}
              className="rounded-lg border border-rose-500/40 px-3 py-1.5 text-rose-200 hover:bg-rose-500/10"
            >
              Sign out
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Active" value={stats?.active_links ?? "—"} />
          <StatCard label="Paused" value={stats?.paused_links ?? "—"} />
          <StatCard label="Total clicks" value={stats?.total_clicks ?? "—"} />
          <StatCard
            label="7-day clicks"
            value={stats ? stats.clicks_last_7_days.reduce((a, b) => a + b, 0) : "—"}
          />
        </div>
      </header>

      <div className="mb-6 flex gap-2 border-b border-slate-800">
        <button
          type="button"
          onClick={() => setTab("links")}
          className={`border-b-2 px-3 py-2 text-sm font-medium transition ${
            tab === "links"
              ? "border-sky-400 text-white"
              : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          Links
        </button>
        <button
          type="button"
          onClick={() => setTab("security")}
          className={`border-b-2 px-3 py-2 text-sm font-medium transition ${
            tab === "security"
              ? "border-sky-400 text-white"
              : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          Security
        </button>
      </div>

      {tab === "security" ? (
        <SecurityPanel onToast={showToast} />
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 shadow-xl shadow-black/20">
              <h2 className="mb-4 text-lg font-semibold text-white">Create short link</h2>
              <form onSubmit={onCreate} className="grid gap-3">
                <label className="grid gap-1 text-sm">
                  <span className="text-slate-400">Destination URL *</span>
                  <input
                    required
                    type="url"
                    placeholder="https://example.com/very/long/path"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 placeholder:text-slate-600 focus:ring-2"
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="grid gap-1 text-sm">
                    <span className="text-slate-400">Custom slug</span>
                    <input
                      type="text"
                      placeholder="optional"
                      value={slug}
                      onChange={(e) => setSlug(e.target.value)}
                      className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 placeholder:text-slate-600 focus:ring-2"
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    <span className="text-slate-400">Title</span>
                    <input
                      type="text"
                      placeholder="optional"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 placeholder:text-slate-600 focus:ring-2"
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    <span className="text-slate-400">Redirect</span>
                    <select
                      value={redirectType}
                      onChange={(e) => setRedirectType(Number(e.target.value))}
                      className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 focus:ring-2"
                    >
                      <option value={302}>302 Temporary</option>
                      <option value={301}>301 Permanent</option>
                    </select>
                  </label>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-sm">
                    <span className="text-slate-400">Expires at (optional)</span>
                    <input
                      type="datetime-local"
                      value={expiresAt}
                      onChange={(e) => setExpiresAt(e.target.value)}
                      className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 focus:ring-2"
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    <span className="text-slate-400">Password protect (optional)</span>
                    <input
                      type="text"
                      placeholder="leave blank for none"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 placeholder:text-slate-600 focus:ring-2"
                    />
                  </label>
                </div>
                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-1 inline-flex items-center justify-center rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? "Creating…" : "Shorten URL"}
                </button>
              </form>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 shadow-xl shadow-black/20">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-white">Clicks · last 7 days</h2>
                <a href="/api/export" className="text-xs font-medium text-sky-300 hover:text-sky-200">
                  Export CSV
                </a>
              </div>
              <div className="h-56">
                <canvas ref={overviewCanvas} />
              </div>
              {stats?.top_links?.length ? (
                <div className="mt-4 border-t border-slate-800 pt-4">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                    Top links
                  </p>
                  <ul className="space-y-2">
                    {stats.top_links.slice(0, 5).map((item) => (
                      <li key={item.slug} className="flex items-center justify-between gap-3 text-sm">
                        <button
                          type="button"
                          onClick={() => openAnalytics(item.slug)}
                          className="truncate text-left text-sky-300 hover:underline"
                        >
                          /{item.slug}
                        </button>
                        <span className="shrink-0 tabular-nums text-slate-400">{item.clicks}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          </div>

          <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/70 p-5 shadow-xl shadow-black/20">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">All links</h2>
                <p className="text-xs text-slate-500">{rangeLabel}</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <select
                  value={statusFilter}
                  onChange={(e) => onFilterChange(e.target.value as LinkStatus | "all")}
                  className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-sky-500/40 focus:ring-2"
                >
                  <option value="all">All (except deleted)</option>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="deleted">Deleted</option>
                </select>
                <form onSubmit={onSearch} className="flex w-full max-w-md gap-2">
                  <input
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Search slug or URL…"
                    className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-sky-500/40 placeholder:text-slate-600 focus:ring-2"
                  />
                  <button
                    type="submit"
                    className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                  >
                    Search
                  </button>
                </form>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-2 py-3 font-medium">#</th>
                    <th className="px-2 py-3 font-medium">Slug</th>
                    <th className="px-2 py-3 font-medium">URL</th>
                    <th className="px-2 py-3 font-medium">Status</th>
                    <th className="px-2 py-3 font-medium">Clicks</th>
                    <th className="px-2 py-3 font-medium">Expires</th>
                    <th className="px-2 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={7} className="px-2 py-10 text-center text-slate-500">
                        Loading links…
                      </td>
                    </tr>
                  ) : links.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-2 py-10 text-center text-slate-500">
                        No links yet. Create your first short URL above.
                      </td>
                    </tr>
                  ) : (
                    links.map((row) => (
                      <tr
                        key={row.id}
                        className="border-b border-slate-800/80 text-slate-300 hover:bg-slate-800/40"
                      >
                        <td className="px-2 py-3 tabular-nums text-slate-500">{row.id}</td>
                        <td className="px-2 py-3">
                          <div className="flex items-center gap-1.5 font-medium text-sky-300">
                            /{row.slug}
                            {row.has_password ? (
                              <span title="Password protected" className="text-slate-500">
                                🔒
                              </span>
                            ) : null}
                          </div>
                          {row.title ? (
                            <div className="text-xs text-slate-500">{row.title}</div>
                          ) : null}
                        </td>
                        <td className="px-2 py-3">
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-slate-300 hover:text-white hover:underline"
                            title={row.url}
                          >
                            {truncate(row.url, 46)}
                          </a>
                        </td>
                        <td className="px-2 py-3">
                          <StatusBadge status={row.status} expired={row.is_expired} />
                        </td>
                        <td className="px-2 py-3 tabular-nums">{row.clicks}</td>
                        <td className="px-2 py-3 whitespace-nowrap text-xs text-slate-400">
                          {formatDate(row.expires_at)}
                        </td>
                        <td className="px-2 py-3">
                          <div className="flex flex-wrap gap-1.5">
                            <ActionBtn onClick={() => copyText(row.short_url)}>Copy</ActionBtn>
                            <ActionBtn onClick={() => openAnalytics(row.slug)}>Stats</ActionBtn>
                            <ActionBtn onClick={() => openQr(row.slug)}>QR</ActionBtn>
                            <ActionBtn onClick={() => openEdit(row)}>Edit</ActionBtn>
                            {row.status !== "deleted" ? (
                              <ActionBtn onClick={() => onTogglePause(row)}>
                                {row.status === "paused" ? "Resume" : "Pause"}
                              </ActionBtn>
                            ) : null}
                            {row.status === "deleted" ? (
                              <ActionBtn onClick={() => onRestore(row)}>Restore</ActionBtn>
                            ) : (
                              <ActionBtn danger onClick={() => onDelete(row)}>
                                Delete
                              </ActionBtn>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                disabled={pagination.page <= 1 || loading}
                onClick={() => fetchLinks(pagination.page - 1, search, statusFilter)}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-xs text-slate-500">
                Page {pagination.page} / {pagination.totalPages}
              </span>
              <button
                type="button"
                disabled={pagination.page >= pagination.totalPages || loading}
                onClick={() => fetchLinks(pagination.page + 1, search, statusFilter)}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </section>
        </>
      )}

      {/* Edit modal */}
      {editLink ? (
        <Modal title={`Edit /${editLink.slug}`} onClose={() => setEditLink(null)}>
          <form onSubmit={onSaveEdit} className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-slate-400">URL</span>
              <input
                required
                type="url"
                value={editLink.url}
                onChange={(e) => setEditLink({ ...editLink, url: e.target.value })}
                className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 focus:ring-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-slate-400">Slug</span>
              <input
                required
                value={editLink.slug}
                onChange={(e) => setEditLink({ ...editLink, slug: e.target.value })}
                className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 focus:ring-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-slate-400">Title</span>
              <input
                value={editLink.title || ""}
                onChange={(e) => setEditLink({ ...editLink, title: e.target.value || null })}
                className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 focus:ring-2"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                <span className="text-slate-400">Redirect type</span>
                <select
                  value={editLink.redirect_type}
                  onChange={(e) =>
                    setEditLink({ ...editLink, redirect_type: Number(e.target.value) })
                  }
                  className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 focus:ring-2"
                >
                  <option value={302}>302 Temporary</option>
                  <option value={301}>301 Permanent</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-slate-400">Status</span>
                <select
                  value={editLink.status}
                  onChange={(e) =>
                    setEditLink({ ...editLink, status: e.target.value as LinkStatus })
                  }
                  className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 focus:ring-2"
                >
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                </select>
              </label>
            </div>
            <label className="grid gap-1 text-sm">
              <span className="text-slate-400">Expires at</span>
              <input
                type="datetime-local"
                value={editExpiry}
                onChange={(e) => setEditExpiry(e.target.value)}
                className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 focus:ring-2"
              />
              <span className="text-xs text-slate-600">Clear the field to remove expiry.</span>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-slate-400">
                {editLink.has_password ? "Set new password" : "Add password"}
              </span>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder={editLink.has_password ? "•••••• (leave blank to keep)" : "optional"}
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 placeholder:text-slate-600 focus:ring-2"
                />
                {editLink.has_password ? (
                  <button
                    type="button"
                    onClick={clearEditPassword}
                    className="shrink-0 rounded-xl border border-rose-500/40 px-3 py-2 text-xs text-rose-300 hover:bg-rose-500/10"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </label>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditLink(null)}
                className="rounded-xl border border-slate-700 px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950"
              >
                Save changes
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {/* Analytics modal */}
      {analyticsSlug ? (
        <Modal
          title={`Analytics · /${analyticsSlug}`}
          onClose={() => {
            setAnalyticsSlug(null);
            setSlugStats(null);
            detailChart.current?.destroy();
            detailChart.current = null;
          }}
          wide
        >
          {!slugStats ? (
            <p className="text-sm text-slate-400">Loading analytics…</p>
          ) : (
            <div className="grid gap-6">
              <div className="grid gap-3 sm:grid-cols-3">
                <StatCard label="Total clicks" value={slugStats.total_clicks} />
                <StatCard label="Countries" value={slugStats.clicks_by_country.length} />
                <StatCard label="Destination" value={truncate(slugStats.url, 28)} />
              </div>
              <div className="h-64 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                <canvas ref={detailCanvas} />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-white">By country</h3>
                  <ul className="max-h-48 space-y-1 overflow-auto text-sm">
                    {slugStats.clicks_by_country.length === 0 ? (
                      <li className="text-slate-500">No click data yet</li>
                    ) : (
                      slugStats.clicks_by_country.map((c) => (
                        <li
                          key={c.country}
                          className="flex justify-between gap-3 rounded-lg px-2 py-1 hover:bg-slate-800/50"
                        >
                          <span>{c.country}</span>
                          <span className="tabular-nums text-slate-400">{c.count}</span>
                        </li>
                      ))
                    )}
                  </ul>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-white">Recent clicks</h3>
                  <ul className="max-h-48 space-y-2 overflow-auto text-xs text-slate-400">
                    {slugStats.recent_clicks.length === 0 ? (
                      <li>No recent clicks</li>
                    ) : (
                      slugStats.recent_clicks.map((c) => (
                        <li key={c.id} className="rounded-lg border border-slate-800 px-2 py-1.5">
                          <div className="text-slate-300">
                            {formatDate(c.timestamp)} · {c.country || "??"}
                            {c.city ? ` / ${c.city}` : ""}
                          </div>
                          <div className="truncate">
                            {c.referrer || "direct"} · {truncate(c.user_agent || "", 60)}
                          </div>
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </Modal>
      ) : null}

      {/* QR modal */}
      {qrSlug ? (
        <Modal title={`QR · /${qrSlug}`} onClose={() => setQrSlug(null)}>
          <div className="flex flex-col items-center gap-4 text-center">
            {qrUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrUrl}
                alt={`QR code for /${qrSlug}`}
                className="h-64 w-64 rounded-xl bg-white p-3"
              />
            ) : (
              <p className="text-sm text-slate-400">Generating QR…</p>
            )}
            <p className="text-sm text-slate-400">
              Scan to open <span className="text-sky-300">/{qrSlug}</span>
            </p>
            {qrUrl ? (
              <a href={qrUrl} target="_blank" rel="noreferrer" className="text-sm text-sky-300 hover:underline">
                Open QR image
              </a>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {/* Change password modal */}
      {showChangePw ? (
        <Modal
          title="Change password"
          onClose={() => {
            setShowChangePw(false);
            setPwCurrent("");
            setPwNext("");
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (pwNext.length < 8) {
                showToast("New password must be at least 8 characters", "err");
                return;
              }
              setPwSaving(true);
              try {
                const res = await fetch("/api/auth/change-password", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ current_password: pwCurrent, new_password: pwNext }),
                });
                const json = await res.json();
                if (!res.ok || !json.success) throw new Error(json.error || "Change failed");
                showToast("Password updated");
                setShowChangePw(false);
                setPwCurrent("");
                setPwNext("");
              } catch (err) {
                showToast(err instanceof Error ? err.message : "Change failed", "err");
              } finally {
                setPwSaving(false);
              }
            }}
            className="grid gap-3"
          >
            <label className="grid gap-1 text-sm">
              <span className="text-slate-400">Current password</span>
              <input
                type="password"
                required
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 focus:ring-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-slate-400">
                New password <span className="text-slate-600">(min 8 chars)</span>
              </span>
              <input
                type="password"
                required
                minLength={8}
                value={pwNext}
                onChange={(e) => setPwNext(e.target.value)}
                className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none ring-sky-500/40 focus:ring-2"
              />
            </label>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowChangePw(false)}
                className="rounded-xl border border-slate-700 px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pwSaving}
                className="rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
              >
                {pwSaving ? "Saving…" : "Update password"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {toast ? (
        <div
          className={`toast-enter fixed bottom-5 right-5 z-50 rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${
            toast.type === "ok" ? "bg-emerald-500 text-emerald-950" : "bg-rose-500 text-rose-50"
          }`}
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string | number;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3 ${className}`}>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</div>
    </div>
  );
}

function ActionBtn({
  children,
  onClick,
  danger = false,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-2 py-1 text-xs font-medium transition ${
        danger
          ? "border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
          : "border-slate-700 text-slate-300 hover:bg-slate-800"
      }`}
    >
      {children}
    </button>
  );
}

function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        className={`max-h-[90vh] w-full overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl ${
          wide ? "max-w-4xl" : "max-w-lg"
        }`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-2 py-1 text-sm text-slate-300 hover:bg-slate-800"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
