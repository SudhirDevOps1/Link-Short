"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type BlockedIp = {
  id: number;
  ip_hash: string;
  reason: string | null;
  created_at: string | null;
};

type AuditEntry = {
  id: number;
  actor_type: string;
  actor_id: number | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: unknown;
  created_at: string | null;
};

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function actionColor(action: string) {
  if (action.includes("delete") || action.includes("block") || action.includes("failed")) {
    return "text-rose-300";
  }
  if (action.includes("pause") || action.includes("locked")) return "text-amber-300";
  if (action.includes("create") || action.includes("success") || action.includes("resume")) {
    return "text-emerald-300";
  }
  return "text-slate-300";
}

export default function SecurityPanel({
  onToast,
}: {
  onToast: (message: string, type?: "ok" | "err") => void;
}) {
  const [blocked, setBlocked] = useState<BlockedIp[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [ipInput, setIpInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ipsRes, auditRes] = await Promise.all([
        fetch("/api/admin/blocked-ips"),
        fetch("/api/admin/audit-log?limit=30"),
      ]);
      const ipsJson = await ipsRes.json();
      const auditJson = await auditRes.json();
      if (ipsRes.ok && ipsJson.success) setBlocked(ipsJson.data);
      if (auditRes.ok && auditJson.success) setAudit(auditJson.data);
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Failed to load security data", "err");
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const addBlock = async (e: FormEvent) => {
    e.preventDefault();
    setAdding(true);
    try {
      const res = await fetch("/api/admin/blocked-ips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: ipInput.trim(), reason: reasonInput.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed to block IP");
      onToast("IP blocked");
      setIpInput("");
      setReasonInput("");
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Failed to block IP", "err");
    } finally {
      setAdding(false);
    }
  };

  const removeBlock = async (id: number) => {
    if (!confirm("Unblock this IP?")) return;
    try {
      const res = await fetch(`/api/admin/blocked-ips/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed to unblock");
      onToast("IP unblocked");
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Failed to unblock", "err");
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 shadow-xl shadow-black/20">
        <h2 className="mb-1 text-lg font-semibold text-white">IP blocklist</h2>
        <p className="mb-4 text-xs text-slate-500">
          Block abusive networks from creating new short links. IPs are stored as
          irreversible hashes — never in plaintext.
        </p>
        <form onSubmit={addBlock} className="mb-4 grid gap-2 sm:grid-cols-[1.2fr_1fr_auto]">
          <input
            required
            placeholder="IP address (e.g. 203.0.113.4)"
            value={ipInput}
            onChange={(e) => setIpInput(e.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-sky-500/40 placeholder:text-slate-600 focus:ring-2"
          />
          <input
            placeholder="Reason (optional)"
            value={reasonInput}
            onChange={(e) => setReasonInput(e.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-sky-500/40 placeholder:text-slate-600 focus:ring-2"
          />
          <button
            type="submit"
            disabled={adding}
            className="rounded-xl bg-rose-500 px-3 py-2 text-sm font-semibold text-rose-950 hover:bg-rose-400 disabled:opacity-60"
          >
            {adding ? "Blocking…" : "Block IP"}
          </button>
        </form>

        <div className="max-h-80 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : blocked.length === 0 ? (
            <p className="text-sm text-slate-500">No blocked IPs.</p>
          ) : (
            <ul className="space-y-2">
              {blocked.map((b) => (
                <li
                  key={b.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs text-slate-300">
                      {b.ip_hash}
                    </div>
                    <div className="text-xs text-slate-500">
                      {b.reason || "No reason given"} · {formatDate(b.created_at)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeBlock(b.id)}
                    className="shrink-0 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                  >
                    Unblock
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 shadow-xl shadow-black/20">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Audit log</h2>
          <button
            type="button"
            onClick={() => load()}
            className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            Refresh
          </button>
        </div>
        <p className="mb-4 text-xs text-slate-500">
          Recent security-relevant actions: logins, lockouts, link lifecycle changes,
          IP blocks.
        </p>
        <div className="max-h-96 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : audit.length === 0 ? (
            <p className="text-sm text-slate-500">No activity yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {audit.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-xl border border-slate-800 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`font-medium ${actionColor(entry.action)}`}>
                      {entry.action}
                    </span>
                    <span className="text-xs text-slate-500">
                      {formatDate(entry.created_at)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {entry.actor_type}
                    {entry.actor_id ? ` #${entry.actor_id}` : ""}
                    {entry.target_type ? ` → ${entry.target_type} ${entry.target_id ?? ""}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
