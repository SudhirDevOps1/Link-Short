"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type Result = {
  slug: string;
  short_url: string;
  url: string;
  created_at: string | null;
};

type Captcha = {
  token: string;
  question: string;
};

export default function PublicShortener() {
  const [url, setUrl] = useState("");
  const [slug, setSlug] = useState("");
  const [company, setCompany] = useState(""); // honeypot — must stay empty
  const [captcha, setCaptcha] = useState<Captcha | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadCaptcha = useCallback(async () => {
    try {
      const res = await fetch("/api/captcha");
      const json = await res.json();
      if (res.ok && json.success) {
        setCaptcha({ token: json.token, question: json.question });
        setCaptchaAnswer("");
      }
    } catch {
      /* silently retry on submit */
    }
  }, []);

  useEffect(() => {
    void loadCaptcha();
  }, [loadCaptcha]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const res = await fetch("/api/shorten", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          slug: slug.trim() || undefined,
          company, // honeypot field — real users never fill this
          captcha_token: captcha?.token,
          captcha_answer: captchaAnswer,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to create link");
      }
      setResult(json.data);
      setSlug("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create link");
    } finally {
      setLoading(false);
      void loadCaptcha();
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.short_url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="w-full max-w-2xl">
      <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-black/40 sm:p-8">
        <h2 className="text-2xl font-semibold text-white">Shorten a URL</h2>
        <p className="mt-1 text-sm text-slate-400">
          Paste a long link and get a compact, shareable short URL. Free, no signup.
        </p>

        <form onSubmit={submit} className="mt-6 grid gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-slate-400">Long URL</span>
            <input
              required
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/very/long/path?with=params"
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-slate-100 outline-none ring-sky-500/40 placeholder:text-slate-600 focus:ring-2"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-slate-400">
              Custom alias <span className="text-slate-600">(optional)</span>
            </span>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="my-brand"
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-slate-100 outline-none ring-sky-500/40 placeholder:text-slate-600 focus:ring-2"
            />
          </label>

          {/* Honeypot field — hidden from real users via CSS, bots often fill every field */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
            <label>
              Company
              <input
                type="text"
                name="company"
                tabIndex={-1}
                autoComplete="off"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </label>
          </div>

          <label className="grid gap-1 text-sm">
            <span className="text-slate-400">
              Quick check: {captcha ? captcha.question : "loading…"}
            </span>
            <input
              required
              type="text"
              inputMode="numeric"
              value={captchaAnswer}
              onChange={(e) => setCaptchaAnswer(e.target.value)}
              placeholder="Your answer"
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-slate-100 outline-none ring-sky-500/40 placeholder:text-slate-600 focus:ring-2"
            />
          </label>

          <button
            type="submit"
            disabled={loading || !captcha}
            className="mt-2 inline-flex items-center justify-center rounded-xl bg-sky-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Shortening…" : "Shorten URL"}
          </button>
        </form>

        {error ? (
          <div className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        {result ? (
          <div className="mt-6 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4">
            <p className="text-xs uppercase tracking-wide text-emerald-300">Your short link</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <a
                href={result.short_url}
                target="_blank"
                rel="noreferrer"
                className="break-all text-lg font-semibold text-emerald-100 hover:underline"
              >
                {result.short_url}
              </a>
              <button
                type="button"
                onClick={copy}
                className="rounded-lg border border-emerald-400/40 px-3 py-1 text-xs font-medium text-emerald-100 hover:bg-emerald-500/20"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="mt-2 break-all text-xs text-slate-400">→ {result.url}</p>
          </div>
        ) : null}
      </div>

      <p className="mt-4 text-center text-xs text-slate-500">
        Protected by rate limiting and a quick human check. By using this service you
        agree not to shorten malicious, illegal, or abusive URLs.
      </p>
    </div>
  );
}
