import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Admin users. Passwords stored as scrypt hashes.
 * - tokenVersion allows global session invalidation after password change.
 * - failedAttempts / lockedUntil implement brute-force lockout on login.
 */
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("admin"),
    tokenVersion: integer("token_version").notNull().default(1),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("users_username_idx").on(table.username)]
);

/**
 * Short links table.
 * `status` replaces a simple boolean flag so links can be explicitly
 * paused (temporarily disabled, reversible) vs. deleted (soft, hidden)
 * vs. active. This gives the owner fine-grained lifecycle control.
 */
export const links = pgTable(
  "links",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    clicks: integer("clicks").notNull().default(0),
    lastClicked: timestamp("last_clicked", { withTimezone: true }),
    /** 'active' | 'paused' | 'deleted' */
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    password: text("password"),
    redirectType: integer("redirect_type").notNull().default(302),
    /** Privacy-friendly hash of the creator's IP (never the raw IP). */
    createdByIpHash: text("created_by_ip_hash"),
  },
  (table) => [
    uniqueIndex("links_slug_idx").on(table.slug),
    index("links_url_idx").on(table.url),
    index("links_created_at_idx").on(table.createdAt),
    index("links_status_idx").on(table.status),
    index("links_created_by_ip_idx").on(table.createdByIpHash),
  ]
);

/**
 * Individual click events for analytics.
 * Country is typically derived from request headers (e.g. CF-IPCountry).
 */
export const clicks = pgTable(
  "clicks",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull(),
    referrer: text("referrer"),
    userAgent: text("user_agent"),
    country: text("country"),
    city: text("city"),
    ipHash: text("ip_hash"),
    timestamp: timestamp("timestamp", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("clicks_slug_idx").on(table.slug),
    index("clicks_timestamp_idx").on(table.timestamp),
    index("clicks_country_idx").on(table.country),
  ]
);

/**
 * IP blocklist for abuse / spam prevention. IPs are stored hashed
 * (same SHA-256 truncated hash used for click analytics) — never raw.
 */
export const blockedIps = pgTable(
  "blocked_ips",
  {
    id: serial("id").primaryKey(),
    ipHash: text("ip_hash").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("blocked_ips_hash_idx").on(table.ipHash)]
);

/**
 * Audit trail of sensitive actions (admin link mutations, IP blocks,
 * logins, etc.) for accountability and incident investigation.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    actorType: text("actor_type").notNull(), // 'admin' | 'public' | 'system'
    actorId: integer("actor_id"),
    action: text("action").notNull(), // e.g. 'link.create', 'link.pause'
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: text("metadata"), // JSON-encoded extra context
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_logs_created_at_idx").on(table.createdAt),
    index("audit_logs_action_idx").on(table.action),
  ]
);

/**
 * Key/value settings (API defaults, redirect mode, etc.)
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type Link = typeof links.$inferSelect;
export type NewLink = typeof links.$inferInsert;
export type Click = typeof clicks.$inferSelect;
export type NewClick = typeof clicks.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type BlockedIp = typeof blockedIps.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
