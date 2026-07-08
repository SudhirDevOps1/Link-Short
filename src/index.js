/**
 * Cloudflare Workers URL Shortener
 * Stack: Hono + D1 (SQLite)
 *
 * Routes:
 *  GET  /                 Admin dashboard
 *  POST /api/links        Create short link
 *  GET  /api/links        List links
 *  PUT  /api/links/:id    Update link
 *  DELETE /api/links/:id  Soft-delete link
 *  GET  /api/stats        Overall analytics
 *  GET  /api/stats/:slug  Per-link analytics
 *  GET  /api/qr/:slug     QR metadata / image
 *  GET  /api/export       CSV export
 *  GET  /:slug            Redirect + track click
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import dashboardHtml from "./dashboard.html";

/** @typedef {{ DB: D1Database; API_KEY?: string; APP_URL?: string; DEFAULT_REDIRECT?: string; REQUIRE_API_KEY?: string }} Env */

const app = new Hono();

const RESERVED = new Set([
  "api",
  "admin",
  "dashboard",
  "favicon.ico",
  "robots.txt",
  "health",
]);

const rateMap = new Map();

function jsonError(c, message, status = 400) {
  return c.json({ success: false, error: message }, status);
}

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidSlug(slug) {
  return /^[a-zA-Z0-9_-]{2,64}$/.test(slug || "");
}

function generateSlug(len = 6) {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function hashIp(ip) {
  if (!ip) return null;
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function originOf(c) {
  return (c.env.APP_URL || new URL(c.req.url).origin).replace(/\/$/, "");
}

function serializeLink(row, origin) {
  return {
    id: row.id,
    slug: row.slug,
    short_url: `${origin}/${row.slug}`,
    url: row.url,
    title: row.title,
    created_at: row.created_at,
    clicks: row.clicks,
    last_clicked: row.last_clicked,
    is_active: !!row.is_active,
    expires_at: row.expires_at,
    redirect_type: row.redirect_type,
    has_password: !!row.password,
  };
}

function clientIp(c) {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function rateLimit(ip, limit = 100, windowMs = 60_000) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || entry.resetAt <= now) {
    rateMap.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

function requireAuth(c) {
  // Only enforce when API_KEY secret is configured and not explicitly disabled
  if (!c.env.API_KEY || c.env.REQUIRE_API_KEY === "false") return null;
  const key =
    c.req.header("x-api-key") ||
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (key !== c.env.API_KEY) return jsonError(c, "Unauthorized", 401);
  return null;
}

// Global middleware
app.use("*", cors());
app.use("/api/*", async (c, next) => {
  const ip = clientIp(c);
  if (!rateLimit(ip)) {
    return jsonError(c, "Rate limit exceeded. Try again later.", 429);
  }
  // Auth for mutating/list endpoints (not public QR metadata optionally)
  if (c.req.method !== "OPTIONS") {
    const path = new URL(c.req.url).pathname;
    const publicOk = path.startsWith("/api/qr/");
    if (!publicOk) {
      const denied = requireAuth(c);
      if (denied) return denied;
    }
  }
  await next();
});

app.get("/", (c) =>
  c.html(typeof dashboardHtml === "string" ? dashboardHtml : String(dashboardHtml))
);

app.get("/health", (c) => c.json({ ok: true }));

// Create link
app.post("/api/links", async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body?.url || !isValidUrl(body.url)) {
      return jsonError(c, "A valid URL with http:// or https:// is required");
    }

    // Reuse existing mapping when no custom slug
    if (!body.slug) {
      const existing = await c.env.DB.prepare(
        "SELECT * FROM links WHERE url = ? AND is_active = 1 LIMIT 1"
      )
        .bind(body.url)
        .first();
      if (existing) {
        return c.json({
          success: true,
          data: serializeLink(existing, originOf(c)),
        });
      }
    }

    let slug = (body.slug || "").trim();
    if (slug) {
      if (!isValidSlug(slug) || RESERVED.has(slug.toLowerCase())) {
        return jsonError(c, "Invalid or reserved slug");
      }
      const clash = await c.env.DB.prepare(
        "SELECT id FROM links WHERE slug = ? LIMIT 1"
      )
        .bind(slug)
        .first();
      if (clash) return jsonError(c, "Slug is already taken", 409);
    } else {
      for (let i = 0; i < 8; i++) {
        const candidate = generateSlug(6);
        const clash = await c.env.DB.prepare(
          "SELECT id FROM links WHERE slug = ? LIMIT 1"
        )
          .bind(candidate)
          .first();
        if (!clash) {
          slug = candidate;
          break;
        }
      }
      if (!slug) return jsonError(c, "Failed to generate slug", 500);
    }

    const redirectType =
      body.redirect_type === 301 || body.redirectType === 301 ? 301 : 302;
    const title = body.title || null;
    const expiresAt = body.expires_at || body.expiresAt || null;
    const password = body.password || null;

    const result = await c.env.DB.prepare(
      `INSERT INTO links (slug, url, title, expires_at, password, redirect_type)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
      .bind(slug, body.url, title, expiresAt, password, redirectType)
      .first();

    return c.json(
      { success: true, data: serializeLink(result, originOf(c)) },
      201
    );
  } catch (err) {
    console.error(err);
    return jsonError(c, "Failed to create link", 500);
  }
});

// List links
app.get("/api/links", async (c) => {
  try {
    const page = Math.max(1, Number(c.req.query("page") || 1));
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") || 20)));
    const offset = (page - 1) * limit;
    const search = (c.req.query("search") || "").trim();
    const activeOnly = c.req.query("active") !== "false";

    let where = activeOnly ? "WHERE is_active = 1" : "WHERE 1=1";
    const binds = [];
    if (search) {
      where += " AND (slug LIKE ? OR url LIKE ? OR IFNULL(title,'') LIKE ?)";
      const q = `%${search}%`;
      binds.push(q, q, q);
    }

    const totalRow = await c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM links ${where}`
    )
      .bind(...binds)
      .first();

    const { results } = await c.env.DB.prepare(
      `SELECT * FROM links ${where} ORDER BY datetime(created_at) DESC LIMIT ? OFFSET ?`
    )
      .bind(...binds, limit, offset)
      .all();

    const total = Number(totalRow?.total || 0);
    const origin = originOf(c);
    return c.json({
      success: true,
      data: (results || []).map((r) => serializeLink(r, origin)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    console.error(err);
    return jsonError(c, "Failed to list links", 500);
  }
});

// Update
app.put("/api/links/:id", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return jsonError(c, "Invalid id");
    const existing = await c.env.DB.prepare("SELECT * FROM links WHERE id = ?")
      .bind(id)
      .first();
    if (!existing) return jsonError(c, "Link not found", 404);

    const body = await c.req.json().catch(() => ({}));
    let slug = existing.slug;
    let url = existing.url;
    let title = existing.title;
    let isActive = existing.is_active;
    let redirectType = existing.redirect_type;
    let expiresAt = existing.expires_at;
    let password = existing.password;

    if (body.url !== undefined) {
      if (!isValidUrl(body.url)) return jsonError(c, "Invalid URL");
      url = body.url;
    }
    if (body.slug !== undefined) {
      if (!isValidSlug(body.slug) || RESERVED.has(body.slug.toLowerCase())) {
        return jsonError(c, "Invalid slug");
      }
      if (body.slug !== existing.slug) {
        const clash = await c.env.DB.prepare(
          "SELECT id FROM links WHERE slug = ? LIMIT 1"
        )
          .bind(body.slug)
          .first();
        if (clash) return jsonError(c, "Slug is already taken", 409);
        slug = body.slug;
      }
    }
    if (body.title !== undefined) title = body.title;
    if (body.is_active !== undefined || body.isActive !== undefined) {
      isActive = body.is_active ?? body.isActive ? 1 : 0;
    }
    if (body.redirect_type === 301 || body.redirectType === 301) redirectType = 301;
    if (body.redirect_type === 302 || body.redirectType === 302) redirectType = 302;
    if (body.expires_at !== undefined || body.expiresAt !== undefined) {
      expiresAt = body.expires_at ?? body.expiresAt;
    }
    if (body.password !== undefined) password = body.password;

    await c.env.DB.prepare(
      `UPDATE links SET slug=?, url=?, title=?, is_active=?, redirect_type=?, expires_at=?, password=? WHERE id=?`
    )
      .bind(slug, url, title, isActive, redirectType, expiresAt, password, id)
      .run();

    if (slug !== existing.slug) {
      await c.env.DB.prepare("UPDATE clicks SET slug = ? WHERE slug = ?")
        .bind(slug, existing.slug)
        .run();
    }

    const updated = await c.env.DB.prepare("SELECT * FROM links WHERE id = ?")
      .bind(id)
      .first();
    return c.json({ success: true, data: serializeLink(updated, originOf(c)) });
  } catch (err) {
    console.error(err);
    return jsonError(c, "Failed to update link", 500);
  }
});

// Delete (soft by default)
app.delete("/api/links/:id", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return jsonError(c, "Invalid id");
    const existing = await c.env.DB.prepare("SELECT * FROM links WHERE id = ?")
      .bind(id)
      .first();
    if (!existing) return jsonError(c, "Link not found", 404);

    const hard = c.req.query("hard") === "true";
    if (hard) {
      await c.env.DB.prepare("DELETE FROM clicks WHERE slug = ?")
        .bind(existing.slug)
        .run();
      await c.env.DB.prepare("DELETE FROM links WHERE id = ?").bind(id).run();
      return c.json({ success: true, deleted: true, hard: true });
    }

    await c.env.DB.prepare("UPDATE links SET is_active = 0 WHERE id = ?")
      .bind(id)
      .run();
    return c.json({ success: true, deleted: true, hard: false });
  } catch (err) {
    console.error(err);
    return jsonError(c, "Failed to delete link", 500);
  }
});

// Overall stats
app.get("/api/stats", async (c) => {
  try {
    const totalsSafe = await c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM links WHERE is_active = 1) AS total_links,
         (SELECT COALESCE(SUM(clicks),0) FROM links WHERE is_active = 1) AS total_clicks`
    ).first();

    const dates = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      dates.push(d.toISOString().slice(0, 10));
    }
    const since = dates[0] + " 00:00:00";
    const { results: daily } = await c.env.DB.prepare(
      `SELECT substr(timestamp,1,10) AS date, COUNT(*) AS clicks
       FROM clicks WHERE timestamp >= ?
       GROUP BY substr(timestamp,1,10)`
    )
      .bind(since)
      .all();

    const map = new Map((daily || []).map((r) => [r.date, Number(r.clicks)]));
    const clicks_last_7_days = dates.map((d) => map.get(d) || 0);

    const { results: top } = await c.env.DB.prepare(
      `SELECT slug, url, title, clicks FROM links WHERE is_active = 1 ORDER BY clicks DESC LIMIT 10`
    ).all();

    return c.json({
      success: true,
      total_links: Number(totalsSafe?.total_links || 0),
      total_clicks: Number(totalsSafe?.total_clicks || 0),
      clicks_last_7_days,
      dates_last_7_days: dates,
      top_links: top || [],
    });
  } catch (err) {
    console.error(err);
    return jsonError(c, "Failed to load stats", 500);
  }
});

// Per-slug stats
app.get("/api/stats/:slug", async (c) => {
  try {
    const slug = c.req.param("slug");
    const link = await c.env.DB.prepare("SELECT * FROM links WHERE slug = ?")
      .bind(slug)
      .first();
    if (!link) return jsonError(c, "Link not found", 404);

    const dates = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      dates.push(d.toISOString().slice(0, 10));
    }
    const since = dates[0] + " 00:00:00";

    const { results: daily } = await c.env.DB.prepare(
      `SELECT substr(timestamp,1,10) AS date, COUNT(*) AS clicks
       FROM clicks WHERE slug = ? AND timestamp >= ?
       GROUP BY substr(timestamp,1,10)`
    )
      .bind(slug, since)
      .all();
    const map = new Map((daily || []).map((r) => [r.date, Number(r.clicks)]));

    const { results: byCountry } = await c.env.DB.prepare(
      `SELECT COALESCE(country,'Unknown') AS country, COUNT(*) AS count
       FROM clicks WHERE slug = ?
       GROUP BY COALESCE(country,'Unknown')
       ORDER BY count DESC LIMIT 20`
    )
      .bind(slug)
      .all();

    const { results: recent } = await c.env.DB.prepare(
      `SELECT id, referrer, user_agent, country, city, timestamp
       FROM clicks WHERE slug = ? ORDER BY datetime(timestamp) DESC LIMIT 25`
    )
      .bind(slug)
      .all();

    return c.json({
      success: true,
      slug: link.slug,
      url: link.url,
      title: link.title,
      total_clicks: link.clicks,
      created_at: link.created_at,
      last_clicked: link.last_clicked,
      is_active: !!link.is_active,
      clicks_by_date: dates.map((date) => ({ date, clicks: map.get(date) || 0 })),
      clicks_by_country: byCountry || [],
      recent_clicks: recent || [],
    });
  } catch (err) {
    console.error(err);
    return jsonError(c, "Failed to load slug stats", 500);
  }
});

// QR
app.get("/api/qr/:slug", async (c) => {
  try {
    const slug = c.req.param("slug");
    const link = await c.env.DB.prepare("SELECT * FROM links WHERE slug = ?")
      .bind(slug)
      .first();
    if (!link) return jsonError(c, "Link not found", 404);
    const shortUrl = `${originOf(c)}/${link.slug}`;
    const size = c.req.query("size") || "300x300";
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${encodeURIComponent(size)}&data=${encodeURIComponent(shortUrl)}`;

    if (c.req.query("raw") === "1") {
      const img = await fetch(qrUrl);
      return new Response(img.body, {
        headers: {
          "Content-Type": img.headers.get("Content-Type") || "image/png",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    return c.json({
      success: true,
      slug: link.slug,
      short_url: shortUrl,
      qr_url: qrUrl,
      size,
    });
  } catch (err) {
    console.error(err);
    return jsonError(c, "Failed to generate QR", 500);
  }
});

// CSV export
app.get("/api/export", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM links ORDER BY datetime(created_at) DESC"
    ).all();
    const origin = originOf(c);
    const header =
      "id,slug,short_url,url,title,clicks,created_at,last_clicked,is_active,expires_at";
    const lines = [header];
    for (const row of results || []) {
      const cells = [
        row.id,
        row.slug,
        `${origin}/${row.slug}`,
        row.url,
        row.title,
        row.clicks,
        row.created_at,
        row.last_clicked,
        row.is_active,
        row.expires_at,
      ].map((v) => {
        if (v === null || v === undefined) return "";
        const s = String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      });
      lines.push(cells.join(","));
    }
    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="links-export.csv"',
      },
    });
  } catch (err) {
    console.error(err);
    return jsonError(c, "Failed to export", 500);
  }
});

// Redirect + analytics
app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug) || RESERVED.has(slug.toLowerCase())) {
    return c.notFound();
  }

  try {
    const link = await c.env.DB.prepare(
      "SELECT * FROM links WHERE slug = ? AND is_active = 1 LIMIT 1"
    )
      .bind(slug)
      .first();

    if (!link) {
      return c.html(
        `<!doctype html><html><body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh"><div><h1>404</h1><p>Short link /${slug} not found.</p><a href="/" style="color:#38bdf8">Dashboard</a></div></body></html>`,
        404
      );
    }

    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
      return c.html(
        `<!doctype html><html><body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh"><div><h1>Expired</h1><p>Short link /${slug} has expired.</p><a href="/" style="color:#38bdf8">Dashboard</a></div></body></html>`,
        410
      );
    }

    if (link.password) {
      const provided = c.req.query("p");
      if (provided !== link.password) {
        return c.html(
          `<!doctype html><html><body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh"><form method="GET" style="background:#1e293b;padding:24px;border-radius:12px"><h1>Protected link</h1><input type="password" name="p" placeholder="Password" required style="width:100%;padding:10px;margin:8px 0"/><button style="width:100%;padding:10px">Continue</button></form></body></html>`,
          401
        );
      }
    }

    const referrer = c.req.header("referer") || null;
    const userAgent = c.req.header("user-agent") || null;
    const country = c.req.header("cf-ipcountry") || null;
    const city = c.req.raw.cf?.city || null;
    const ip = clientIp(c);
    const ipHash = await hashIp(ip);

    // Non-blocking click logging
    c.executionCtx.waitUntil(
      (async () => {
        await c.env.DB.prepare(
          `INSERT INTO clicks (slug, referrer, user_agent, country, city, ip_hash)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(slug, referrer, userAgent, country, city, ipHash)
          .run();
        await c.env.DB.prepare(
          `UPDATE links SET clicks = clicks + 1, last_clicked = datetime('now') WHERE slug = ?`
        )
          .bind(slug)
          .run();
      })().catch((err) => console.error("click log failed", err))
    );

    const status = link.redirect_type === 301 ? 301 : 302;
    return c.redirect(link.url, status);
  } catch (err) {
    console.error(err);
    return jsonError(c, "Redirect failed", 500);
  }
});

export default app;
