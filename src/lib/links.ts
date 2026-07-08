import { and, desc, eq, gte, ilike, ne, or, sql, count } from "drizzle-orm";
import { db } from "@/db";
import { clicks, links, type Link } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import {
  generateSlug,
  isValidSlug,
  isValidUrl,
  RESERVED_SLUGS,
  lastNDates,
  toIso,
} from "@/lib/utils";

export type LinkStatus = "active" | "paused" | "deleted";

export class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function createLink(input: {
  url: string;
  slug?: string | null;
  title?: string | null;
  expiresAt?: string | null;
  password?: string | null;
  redirectType?: number | null;
  reuseExisting?: boolean;
  createdByIpHash?: string | null;
}) {
  const url = input.url?.trim();
  if (!url || !isValidUrl(url)) {
    throw new AppError("A valid URL with http:// or https:// is required", 400);
  }

  if (input.reuseExisting !== false) {
    const existing = await db
      .select()
      .from(links)
      .where(and(eq(links.url, url), eq(links.status, "active")))
      .limit(1);
    if (existing[0] && !input.slug) {
      return existing[0];
    }
  }

  let slug = input.slug?.trim() || "";
  if (slug) {
    if (!isValidSlug(slug) || RESERVED_SLUGS.has(slug.toLowerCase())) {
      throw new AppError(
        "Slug must be 2-64 chars (letters, numbers, _ or -) and not reserved",
        400
      );
    }
    const clash = await db
      .select({ id: links.id })
      .from(links)
      .where(eq(links.slug, slug))
      .limit(1);
    if (clash[0]) {
      throw new AppError("Slug is already taken", 409);
    }
  } else {
    // Generate unique slug with retries
    for (let i = 0; i < 8; i++) {
      const candidate = generateSlug(6);
      const clash = await db
        .select({ id: links.id })
        .from(links)
        .where(eq(links.slug, candidate))
        .limit(1);
      if (!clash[0]) {
        slug = candidate;
        break;
      }
    }
    if (!slug) {
      throw new AppError("Failed to generate a unique slug", 500);
    }
  }

  const redirectType =
    input.redirectType === 301 || input.redirectType === 302
      ? input.redirectType
      : 302;

  let expiresAt: Date | null = null;
  if (input.expiresAt) {
    const parsed = new Date(input.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppError("Invalid expiresAt date", 400);
    }
    if (parsed.getTime() <= Date.now()) {
      throw new AppError("Expiry date must be in the future", 400);
    }
    expiresAt = parsed;
  }

  const passwordPlain = input.password?.trim();

  const [created] = await db
    .insert(links)
    .values({
      slug,
      url,
      title: input.title?.trim() || null,
      expiresAt,
      password: passwordPlain ? hashPassword(passwordPlain) : null,
      redirectType,
      status: "active",
      createdByIpHash: input.createdByIpHash || null,
    })
    .returning();

  return created;
}

/** Verify a plaintext password against a stored (hashed) link password. */
export function checkLinkPassword(
  provided: string | null | undefined,
  storedHash: string | null | undefined
): boolean {
  if (!storedHash) return true;
  if (!provided) return false;
  return verifyPassword(provided, storedHash);
}

/** True if a link's expiry timestamp has passed. */
export function isExpired(link: Pick<Link, "expiresAt">): boolean {
  return Boolean(link.expiresAt && link.expiresAt.getTime() < Date.now());
}

export async function listLinks(options: {
  page?: number;
  limit?: number;
  search?: string;
  /** 'active' | 'paused' | 'deleted' | 'all' | undefined (defaults to non-deleted) */
  status?: LinkStatus | "all";
}) {
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(100, Math.max(1, options.limit || 20));
  const offset = (page - 1) * limit;

  const conditions = [];
  if (!options.status || options.status === "all") {
    if (!options.status) {
      conditions.push(ne(links.status, "deleted"));
    }
  } else {
    conditions.push(eq(links.status, options.status));
  }
  if (options.search?.trim()) {
    const q = `%${options.search.trim()}%`;
    conditions.push(or(ilike(links.slug, q), ilike(links.url, q), ilike(links.title, q)));
  }

  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(links)
      .where(where)
      .orderBy(desc(links.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(links).where(where),
  ]);

  const total = Number(totalRow[0]?.total || 0);

  return {
    data: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

export async function getLinkById(id: number) {
  const [row] = await db.select().from(links).where(eq(links.id, id)).limit(1);
  return row || null;
}

/**
 * Look up by slug. When `activeOnly` is true, only returns links whose
 * status is 'active' (paused/deleted links resolve as "not found" for
 * redirect purposes but remain visible to admins via getLinkById).
 */
export async function getLinkBySlug(slug: string, activeOnly = true) {
  const conditions = [eq(links.slug, slug)];
  if (activeOnly) conditions.push(eq(links.status, "active"));
  const [row] = await db
    .select()
    .from(links)
    .where(and(...conditions))
    .limit(1);
  return row || null;
}

export async function updateLink(
  id: number,
  input: {
    url?: string;
    slug?: string;
    title?: string | null;
    status?: LinkStatus;
    expiresAt?: string | null;
    password?: string | null;
    redirectType?: number;
  }
) {
  const existing = await getLinkById(id);
  if (!existing) throw new AppError("Link not found", 404);

  const patch: Partial<typeof links.$inferInsert> = {};

  if (input.url !== undefined) {
    if (!isValidUrl(input.url)) {
      throw new AppError("A valid URL with http:// or https:// is required", 400);
    }
    patch.url = input.url.trim();
  }

  if (input.slug !== undefined) {
    const slug = input.slug.trim();
    if (!isValidSlug(slug) || RESERVED_SLUGS.has(slug.toLowerCase())) {
      throw new AppError("Invalid slug", 400);
    }
    if (slug !== existing.slug) {
      const clash = await db
        .select({ id: links.id })
        .from(links)
        .where(eq(links.slug, slug))
        .limit(1);
      if (clash[0]) throw new AppError("Slug is already taken", 409);
      patch.slug = slug;
    }
  }

  if (input.title !== undefined) patch.title = input.title?.trim() || null;
  if (input.status !== undefined) {
    if (!["active", "paused", "deleted"].includes(input.status)) {
      throw new AppError("Invalid status", 400);
    }
    patch.status = input.status;
  }
  if (input.password !== undefined) {
    const raw = input.password?.trim();
    patch.password = raw ? hashPassword(raw) : null;
  }
  if (input.redirectType === 301 || input.redirectType === 302) {
    patch.redirectType = input.redirectType;
  }
  if (input.expiresAt !== undefined) {
    if (input.expiresAt === null || input.expiresAt === "") {
      patch.expiresAt = null;
    } else {
      const parsed = new Date(input.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new AppError("Invalid expiresAt date", 400);
      }
      patch.expiresAt = parsed;
    }
  }

  if (Object.keys(patch).length === 0) {
    return existing;
  }

  const [updated] = await db
    .update(links)
    .set(patch)
    .where(eq(links.id, id))
    .returning();

  // If slug changes, also update historical click rows for consistency
  if (patch.slug && patch.slug !== existing.slug) {
    await db
      .update(clicks)
      .set({ slug: patch.slug })
      .where(eq(clicks.slug, existing.slug));
  }

  return updated;
}

/** Temporarily disable a link without losing its data/history. */
export async function pauseLink(id: number) {
  return updateLink(id, { status: "paused" });
}

/** Re-enable a previously paused link. */
export async function resumeLink(id: number) {
  return updateLink(id, { status: "active" });
}

export async function deleteLink(id: number, hard = false) {
  const existing = await getLinkById(id);
  if (!existing) throw new AppError("Link not found", 404);

  if (hard) {
    await db.delete(clicks).where(eq(clicks.slug, existing.slug));
    await db.delete(links).where(eq(links.id, id));
    return { deleted: true, hard: true };
  }

  await db.update(links).set({ status: "deleted" }).where(eq(links.id, id));
  return { deleted: true, hard: false };
}

export async function recordClick(params: {
  slug: string;
  referrer?: string | null;
  userAgent?: string | null;
  country?: string | null;
  city?: string | null;
  ipHash?: string | null;
}) {
  await db.insert(clicks).values({
    slug: params.slug,
    referrer: params.referrer || null,
    userAgent: params.userAgent || null,
    country: params.country || null,
    city: params.city || null,
    ipHash: params.ipHash || null,
  });

  await db
    .update(links)
    .set({
      clicks: sql`${links.clicks} + 1`,
      lastClicked: new Date(),
    })
    .where(eq(links.slug, params.slug));
}

export async function getOverallStats() {
  const [totals] = await db
    .select({
      totalLinks: sql<number>`count(*) filter (where ${links.status} <> 'deleted')`,
      activeLinks: sql<number>`count(*) filter (where ${links.status} = 'active')`,
      pausedLinks: sql<number>`count(*) filter (where ${links.status} = 'paused')`,
      totalClicks: sql<number>`coalesce(sum(${links.clicks}) filter (where ${links.status} <> 'deleted'), 0)`,
    })
    .from(links);

  const dates = lastNDates(7);
  const sevenDaysAgo = new Date(`${dates[0]}T00:00:00.000Z`);

  const daily = await db
    .select({
      date: sql<string>`to_char(${clicks.timestamp} at time zone 'UTC', 'YYYY-MM-DD')`,
      clicks: count(),
    })
    .from(clicks)
    .where(gte(clicks.timestamp, sevenDaysAgo))
    .groupBy(sql`to_char(${clicks.timestamp} at time zone 'UTC', 'YYYY-MM-DD')`);

  const byDate = new Map(daily.map((d) => [d.date, Number(d.clicks)]));
  const clicksLast7Days = dates.map((d) => byDate.get(d) || 0);

  const topLinks = await db
    .select({
      slug: links.slug,
      url: links.url,
      title: links.title,
      clicks: links.clicks,
    })
    .from(links)
    .where(eq(links.status, "active"))
    .orderBy(desc(links.clicks))
    .limit(10);

  return {
    total_links: Number(totals?.totalLinks || 0),
    active_links: Number(totals?.activeLinks || 0),
    paused_links: Number(totals?.pausedLinks || 0),
    total_clicks: Number(totals?.totalClicks || 0),
    clicks_last_7_days: clicksLast7Days,
    dates_last_7_days: dates,
    top_links: topLinks.map((l) => ({
      slug: l.slug,
      url: l.url,
      title: l.title,
      clicks: l.clicks,
    })),
  };
}

export async function getSlugStats(slug: string) {
  const link = await getLinkBySlug(slug, false);
  if (!link) throw new AppError("Link not found", 404);

  const dates = lastNDates(14);
  const since = new Date(`${dates[0]}T00:00:00.000Z`);

  const [daily, byCountry, recent] = await Promise.all([
    db
      .select({
        date: sql<string>`to_char(${clicks.timestamp} at time zone 'UTC', 'YYYY-MM-DD')`,
        clicks: count(),
      })
      .from(clicks)
      .where(and(eq(clicks.slug, slug), gte(clicks.timestamp, since)))
      .groupBy(sql`to_char(${clicks.timestamp} at time zone 'UTC', 'YYYY-MM-DD')`),
    db
      .select({
        country: sql<string>`coalesce(${clicks.country}, 'Unknown')`,
        count: count(),
      })
      .from(clicks)
      .where(eq(clicks.slug, slug))
      .groupBy(sql`coalesce(${clicks.country}, 'Unknown')`)
      .orderBy(desc(count()))
      .limit(20),
    db
      .select()
      .from(clicks)
      .where(eq(clicks.slug, slug))
      .orderBy(desc(clicks.timestamp))
      .limit(25),
  ]);

  const byDate = new Map(daily.map((d) => [d.date, Number(d.clicks)]));

  return {
    slug: link.slug,
    url: link.url,
    title: link.title,
    total_clicks: link.clicks,
    created_at: toIso(link.createdAt),
    last_clicked: toIso(link.lastClicked),
    status: link.status,
    is_expired: isExpired(link),
    clicks_by_date: dates.map((date) => ({
      date,
      clicks: byDate.get(date) || 0,
    })),
    clicks_by_country: byCountry.map((c) => ({
      country: c.country,
      count: Number(c.count),
    })),
    recent_clicks: recent.map((c) => ({
      id: c.id,
      referrer: c.referrer,
      user_agent: c.userAgent,
      country: c.country,
      city: c.city,
      timestamp: toIso(c.timestamp),
    })),
  };
}

export function serializeLink(link: Link, origin: string) {
  return {
    id: link.id,
    slug: link.slug,
    short_url: `${origin.replace(/\/$/, "")}/${link.slug}`,
    url: link.url,
    title: link.title,
    created_at: toIso(link.createdAt),
    clicks: link.clicks,
    last_clicked: toIso(link.lastClicked),
    status: link.status,
    is_active: link.status === "active",
    is_expired: isExpired(link),
    expires_at: toIso(link.expiresAt),
    redirect_type: link.redirectType,
    has_password: Boolean(link.password),
  };
}
