import { NextRequest } from "next/server";
import { after } from "next/server";
import { applyRateLimit, clientIp } from "@/lib/auth";
import {
  checkLinkPassword,
  getLinkBySlug,
  isExpired,
  recordClick,
} from "@/lib/links";
import { hashIp } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/**
 * Redirect endpoint for short links.
 * Primary path is /:slug via middleware rewrite, but /r/:slug also works.
 */
export async function GET(request: NextRequest, context: Ctx) {
  try {
    // Redirects are generally lightweight but bots can hammer them.
    const rl = applyRateLimit(request, {
      bucket: "redirect",
      limit: 600,
      windowMs: 60_000,
    });
    if (rl) return rl;

    const { slug } = await context.params;
    // Fetch regardless of status so we can show an accurate message
    // (paused vs. deleted vs. never-existed vs. expired).
    const link = await getLinkBySlug(slug, false);

    if (!link || link.status === "deleted") {
      return new Response(notFoundHtml(slug), {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (link.status === "paused") {
      return new Response(pausedHtml(slug), {
        status: 403,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (isExpired(link)) {
      return new Response(expiredHtml(slug), {
        status: 410,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Optional password gate via ?p=... (hashed compare)
    if (link.password) {
      const provided = request.nextUrl.searchParams.get("p");
      if (!checkLinkPassword(provided, link.password)) {
        return new Response(passwordHtml(slug), {
          status: 401,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    const referrer = request.headers.get("referer");
    const userAgent = request.headers.get("user-agent");
    const country =
      request.headers.get("cf-ipcountry") ||
      request.headers.get("x-vercel-ip-country") ||
      null;
    const city =
      request.headers.get("cf-ipcity") ||
      request.headers.get("x-vercel-ip-city") ||
      null;
    const ip = clientIp(request);

    // Non-blocking analytics (don't delay the redirect)
    after(async () => {
      try {
        await recordClick({
          slug: link.slug,
          referrer,
          userAgent,
          country,
          city,
          ipHash: hashIp(ip),
        });
      } catch (err) {
        console.error("Failed to record click", err);
      }
    });

    const status = link.redirectType === 301 ? 301 : 302;
    return Response.redirect(link.url, status);
  } catch (error) {
    console.error("Redirect error", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

function shellStyles() {
  return `body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
  .card{background:#1e293b;border:1px solid #334155;padding:2rem;border-radius:1rem;max-width:28rem;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4)}
  h1{margin:0 0 .5rem;font-size:1.75rem}
  a{color:#38bdf8;text-decoration:none}
  a:hover{text-decoration:underline}
  input,button{width:100%;padding:.75rem;border-radius:.5rem;border:1px solid #334155;background:#0f172a;color:#e2e8f0;margin-top:.5rem;font:inherit}
  button{background:#0ea5e9;border:none;cursor:pointer;font-weight:600;color:#082f49}`;
}

function notFoundHtml(slug: string) {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Link not found</title>
  <style>${shellStyles()}</style></head><body><div class="card"><h1>404</h1>
  <p>Short link <strong>/${escapeHtml(slug)}</strong> was not found.</p>
  <p><a href="/">Create a short link →</a></p></div></body></html>`;
}

function pausedHtml(slug: string) {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Link paused</title>
  <style>${shellStyles()}</style></head><body><div class="card"><h1>Paused</h1>
  <p>Short link <strong>/${escapeHtml(slug)}</strong> has been temporarily paused by its owner.</p>
  <p><a href="/">Go to homepage →</a></p></div></body></html>`;
}

function expiredHtml(slug: string) {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Link expired</title>
  <style>${shellStyles()}</style></head><body><div class="card"><h1>Expired</h1>
  <p>Short link <strong>/${escapeHtml(slug)}</strong> has expired.</p>
  <p><a href="/">Create a short link →</a></p></div></body></html>`;
}

function passwordHtml(slug: string) {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Password required</title>
  <style>${shellStyles()}</style></head>
  <body><div class="card"><h1>Protected link</h1>
  <p>Enter the password to continue to <strong>/${escapeHtml(slug)}</strong>.</p>
  <form method="GET" action="/r/${encodeURIComponent(slug)}">
  <input type="password" name="p" placeholder="Password" required autofocus />
  <button type="submit">Continue</button></form></div></body></html>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
