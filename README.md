# Shortly

**Shortly** is a production-grade, self-hosted, privacy-friendly URL shortener with an
owner-only admin dashboard, click analytics, QR codes, and a hardened public API.
Anyone can shorten a URL — only the owner (admin) can view analytics, edit, pause,
expire, or delete links.

This repository ships **two runnable implementations** of the same product:

| Implementation | Where | Stack |
| :--- | :--- | :--- |
| **Primary app (this sandbox)** | `src/` | Next.js App Router + PostgreSQL (Drizzle ORM) |
| **Portable reference build** | `cloudflare/` | Cloudflare Workers + D1 (Hono) |

---

## Table of contents

1. [Access model](#access-model)
2. [Feature matrix](#feature-matrix)
3. [Security architecture](#security-architecture)
4. [Anti-spam & abuse prevention](#anti-spam--abuse-prevention)
5. [Link lifecycle (pause / expire / delete)](#link-lifecycle-pause--expire--delete)
6. [Getting started](#getting-started)
7. [Environment variables](#environment-variables)
8. [Database schema](#database-schema)
9. [API reference](#api-reference)
10. [Admin dashboard tour](#admin-dashboard-tour)
11. [Cloudflare Workers alternative](#cloudflare-workers-alternative)
12. [Production deployment checklist](#production-deployment-checklist)
13. [License](#license)

---

## Access model

| Surface | Who can access | Notes |
| :--- | :--- | :--- |
| `/` — public shortener page | **Anyone** | Rate-limited + CAPTCHA + honeypot |
| `POST /api/shorten` | **Anyone** | Same anti-spam pipeline as the UI |
| `GET /api/captcha` | **Anyone** | Issues a stateless math challenge |
| `/{slug}` — redirect | **Anyone** | Rate-limited, tracks anonymized clicks |
| `GET /api/qr/{slug}` | **Anyone** | Only reveals whether the slug exists |
| `/login` | **Anyone** (to attempt login) | Brute-force protected |
| `/admin` — dashboard | **Owner only** | Requires a valid signed session cookie |
| `/api/links*`, `/api/stats*`, `/api/export` | **Owner only** | 401/403 without a valid session |
| `/api/admin/blocked-ips*`, `/api/admin/audit-log` | **Owner only** | Security tooling |

The public can **never** see the admin dashboard, edit/delete links, view analytics,
or manage the IP blocklist — every mutating/reporting endpoint checks the signed
session server-side (`requireAdmin()` in `src/lib/session.ts`).

---

## Feature matrix

### Core link management
- Random 6-character slugs or custom aliases
- 301 (permanent) or 302 (temporary) redirect modes, configurable per link
- **Manual expiry** — set an exact date/time; expired links show a dedicated "Expired" page and stop redirecting automatically
- **Pause / Resume** — instantly disable a link without deleting its history, then re-enable it later
- **Soft delete + Restore** — deleted links are hidden but recoverable from the "Deleted" filter; a hard-delete option purges permanently
- **Per-link password protection** — scrypt-hashed, prompts visitors before redirecting
- Duplicate URL reuse (returns the existing short link instead of creating a duplicate) unless a custom slug is requested
- Rename slug / edit destination URL / edit title at any time

### Analytics
- Total links, active/paused counts, total clicks, 7-day trend chart (Chart.js)
- Per-link analytics: 14-day click chart, clicks by country, recent click log (referrer, user agent, country/city)
- CSV export of all links (admin-only)

### Security & spam prevention
See the [Security architecture](#security-architecture) and
[Anti-spam & abuse prevention](#anti-spam--abuse-prevention) sections below.

---

## Security architecture

| Concern | Implementation |
| :--- | :--- |
| **Password storage** | `scrypt` (Node's built-in, no external deps) for both the admin account and per-link passwords. Format: `scrypt$N$r$p$salt$hash`. |
| **Session tokens** | Custom HMAC-SHA256 signed tokens (`src/lib/crypto.ts`), stored in an `HttpOnly`, `SameSite=Lax`, `Secure` (in prod) cookie. Not a JWT library — zero extra dependencies, fully auditable ~150 lines of code. |
| **Session invalidation** | Every user has a `token_version`. Changing the password increments it, instantly invalidating all previously issued sessions. |
| **CSRF protection** | All cookie-authenticated, state-changing requests (`POST`/`PUT`/`DELETE`) require the `Origin`/`Referer` header to match the request host (`ensureSameOrigin`). |
| **Brute-force login protection** | Per-IP rate limit (10 attempts / 5 min) **and** per-account lockout (5 failed attempts → 15 minute lock), tracked in `users.failed_attempts` / `users.locked_until`. |
| **Timing-safe comparisons** | `crypto.timingSafeEqual` for password and signature checks; a dummy hash is verified even when the username doesn't exist, to avoid leaking account existence via response timing. |
| **IP privacy** | Raw IP addresses are **never stored**. A truncated SHA-256 hash (`hashIp()`) is stored instead, used for analytics, IP blocking, and abuse detection. |
| **Reserved routes** | `admin`, `login`, `api`, `_next`, etc. can never be claimed as a short slug (enforced in both `src/lib/utils.ts` and `src/middleware.ts`). |
| **Security headers** | `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` set globally in `next.config.ts`. |
| **SQL injection** | 100% parameterized queries via Drizzle ORM — no raw string interpolation anywhere. |
| **Audit trail** | Every sensitive action (login success/failure, lockouts, link create/update/pause/resume/delete, IP block/unblock) is written to the `audit_logs` table and viewable from the dashboard's Security tab. |

---

## Anti-spam & abuse prevention

The public `/api/shorten` endpoint is the highest-risk surface (unauthenticated,
write access) and is protected by multiple independent layers:

1. **Short-window rate limit** — 20 requests / minute / IP.
2. **Daily creation cap** — 40 links / day / IP (separate sliding window).
3. **IP blocklist** — admin can block abusive networks from the Security tab; blocked IPs get an immediate `403`.
4. **Honeypot field** — a hidden `company` input that's invisible to real users but often auto-filled by bots; any non-empty value silently rejects the request.
5. **Stateless math CAPTCHA** — `/api/captcha` issues a signed, short-lived challenge (`"7 + 12 = ?"`). The answer is verified without any server-side storage, and submissions faster than ~1 second are rejected (blocks naive scripted bots).
6. **Destination URL safety checks** (`src/lib/security.ts`):
   - Max URL length (2048 chars)
   - Only `http://` / `https://`
   - Blocks `localhost`, loopback, link-local, and private (RFC1918) IP targets
   - Blocks links that point back at the shortener's own domain (prevents redirect loops)
   - Blocks obviously dangerous file extensions (`.exe`, `.apk`, `.msi`, …)
7. **Admin-only advanced fields** — expiry, password protection, and custom redirect codes are only settable from the authenticated admin API; the public endpoint always creates plain 302 links with no PII-bearing metadata.

Everything above degrades gracefully — legitimate users see a simple arithmetic
question and never notice the honeypot.

---

## Link lifecycle (pause / expire / delete)

Links move through an explicit `status` state machine (`active → paused → active`,
or `active/paused → deleted → active`):

- **Active** — resolves and redirects normally.
- **Paused** — visiting the short link shows a "Paused" page (HTTP 403); fully reversible from the dashboard with one click, no data lost.
- **Expired** — computed from `expires_at`; once the timestamp passes, visitors see an "Expired" page (HTTP 410) even though the link status is still `active`. Set or clear the expiry at any time from the Edit modal.
- **Deleted (soft)** — hidden from default listings and resolves as 404; recoverable via the "Deleted" filter → Restore. A `?hard=true` query flag on the `DELETE` endpoint permanently purges the link and its click history.

---

## Getting started

### Prerequisites
- Node.js 20+
- PostgreSQL (already configured in this sandbox via `DATABASE_URL`)

### Install & run

```bash
npm install
npx drizzle-kit push     # sync schema to PostgreSQL
npm run dev
```

Visit `http://localhost:3000`:
- Public shortener: `/`
- Admin login: `/login`

### First admin login

On first request, if no admin user exists, one is bootstrapped automatically using
`ADMIN_USERNAME` / `ADMIN_PASSWORD` from the environment. If those aren't set, a
**dev-only fallback** of `admin` / `admin` is created — **change this immediately**
from the dashboard's "Change password" button before exposing the app publicly.

---

## Environment variables

| Variable | Required | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `SESSION_SECRET` | ✅ in production | HMAC signing key for session/CAPTCHA tokens. Must be **≥32 characters**. Generate with `openssl rand -hex 32`. If unset, a deterministic dev-only key is derived from `DATABASE_URL` (a warning is logged). |
| `ADMIN_USERNAME` | Optional | Username for the auto-bootstrapped admin account (default: `admin`) |
| `ADMIN_PASSWORD` | Recommended | Password for the auto-bootstrapped admin account. If omitted, defaults to `admin` (dev only — change it after first login). |
| `NEXT_PUBLIC_APP_URL` | Recommended | Public origin used to build `short_url` values and to block self-referential redirects, e.g. `https://sho.rt` |

Example `.env`:

```env
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db
SESSION_SECRET=replace-with-a-random-64-character-hex-string-in-production
ADMIN_USERNAME=admin
ADMIN_PASSWORD=use-a-strong-unique-password-here
NEXT_PUBLIC_APP_URL=https://your.domain
```

---

## Database schema

### `links`
| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | serial PK | |
| `slug` | text, unique | short code |
| `url` | text | destination |
| `title` | text, nullable | optional label |
| `created_at` | timestamptz | |
| `clicks` | integer | denormalized counter |
| `last_clicked` | timestamptz, nullable | |
| `status` | text | `active` \| `paused` \| `deleted` |
| `expires_at` | timestamptz, nullable | manual expiry |
| `password` | text, nullable | scrypt hash, never plaintext |
| `redirect_type` | integer | `301` or `302` |
| `created_by_ip_hash` | text, nullable | hashed creator IP (abuse tracing) |

### `clicks`
`id`, `slug`, `referrer`, `user_agent`, `country`, `city`, `ip_hash`, `timestamp`

### `users` (admin accounts)
`id`, `username` (unique), `password_hash` (scrypt), `role`, `token_version`,
`failed_attempts`, `locked_until`, `created_at`, `last_login_at`

### `blocked_ips`
`id`, `ip_hash` (unique), `reason`, `created_at`

### `audit_logs`
`id`, `actor_type` (`admin`/`public`/`system`), `actor_id`, `action`, `target_type`,
`target_id`, `metadata` (JSON string), `ip_hash`, `created_at`

### `settings`
`key` (PK), `value` — reserved for future global configuration

---

## API reference

### Public endpoints

**`GET /api/captcha`** → `{ success, token, question }`

**`POST /api/shorten`**
```bash
curl -X POST http://localhost:3000/api/shorten \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://example.com/very/long",
    "slug": "optional-alias",
    "captcha_token": "<token from /api/captcha>",
    "captcha_answer": "19"
  }'
```
Response:
```json
{
  "success": true,
  "data": {
    "slug": "abc123",
    "short_url": "https://your.domain/abc123",
    "url": "https://example.com/very/long",
    "created_at": "2026-07-09T12:00:00.000Z"
  }
}
```

**`GET /{slug}`** → 301/302 redirect (or 403 Paused / 404 Not found / 410 Expired / 401 Password required)

**`GET /api/qr/{slug}`** → `{ success, slug, short_url, qr_url, size }` (append `?raw=1` for the PNG image directly)

### Admin endpoints (require a valid session cookie)

Login first to receive the session cookie:
```bash
curl -c cookie.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
```

| Endpoint | Method | Purpose |
| :--- | :--- | :--- |
| `/api/links` | `GET` | List links (`?page&limit&search&status=active\|paused\|deleted\|all`) |
| `/api/links` | `POST` | Create a link (supports `expires_at`, `password`, `redirect_type`) |
| `/api/links/:id` | `GET` | Fetch one link |
| `/api/links/:id` | `PUT` | Edit URL/slug/title/status/expiry/password/redirect type |
| `/api/links/:id` | `DELETE` | Soft delete (`?hard=true` to permanently purge) |
| `/api/stats` | `GET` | Overall analytics + 7-day trend + top links |
| `/api/stats/:slug` | `GET` | Per-link analytics (14-day trend, countries, recent clicks) |
| `/api/export` | `GET` | CSV export of all links |
| `/api/admin/blocked-ips` | `GET` / `POST` | List / add a blocked IP |
| `/api/admin/blocked-ips/:id` | `DELETE` | Remove a block |
| `/api/admin/audit-log` | `GET` | Recent security/audit trail |
| `/api/auth/me` | `GET` | Current session info |
| `/api/auth/logout` | `POST` | Clear session |
| `/api/auth/change-password` | `POST` | Rotate password (invalidates old sessions) |

Example — pause a link:
```bash
curl -b cookie.txt -X PUT http://localhost:3000/api/links/1 \
  -H 'Content-Type: application/json' \
  -d '{"status":"paused"}'
```

Example — set an expiry:
```bash
curl -b cookie.txt -X PUT http://localhost:3000/api/links/1 \
  -H 'Content-Type: application/json' \
  -d '{"expires_at":"2026-12-31T23:59:00.000Z"}'
```

---

## Admin dashboard tour

- **Links tab** — create form (URL, alias, title, redirect type, expiry, password), searchable/filterable table (status: active/paused/deleted), per-row actions: Copy, Stats, QR, Edit, Pause/Resume, Delete/Restore.
- **Security tab** — IP blocklist manager (block/unblock by address, reason notes) and a live audit log of logins, lockouts, and link lifecycle events.
- **Change password** — rotates the scrypt hash and bumps `token_version`, immediately signing out any other active sessions.

---

## Cloudflare Workers alternative

For teams who prefer a fully edge-native deployment, `cloudflare/` contains a
lighter-weight reference implementation on **Cloudflare Workers + D1** (Hono
framework) covering the core shortening/redirect/analytics/QR feature set.

> Note: the advanced hardening features documented above (stateless CAPTCHA,
> account lockout, IP blocklist, audit log) are implemented in the primary
> Next.js app. The Workers build is intended as a minimal, portable starting
> point — the same defensive patterns (scrypt hashing, hashed IPs, rate
> limiting) can be ported using the code in `src/lib/` as a reference.

```bash
cd cloudflare
npm install
npx wrangler d1 create url-shortener-db     # copy the database_id into wrangler.toml
npx wrangler d1 migrations apply url-shortener-db --remote
npx wrangler secret put API_KEY             # optional
npx wrangler deploy
```

See `cloudflare/wrangler.toml` and `cloudflare/migrations/0001_initial.sql` for
full configuration.

---

## Production deployment checklist

- [ ] Set a strong, unique `SESSION_SECRET` (≥32 random chars)
- [ ] Set `ADMIN_USERNAME` + a strong `ADMIN_PASSWORD` **before** first boot
- [ ] Set `NEXT_PUBLIC_APP_URL` to your real domain (enables self-redirect protection)
- [ ] Log in once and use "Change password" to rotate away from any default credential
- [ ] Serve over HTTPS (required for `Secure` cookies to be honored)
- [ ] Review the Security tab periodically for suspicious audit log entries
- [ ] Consider moving rate limiting to a shared store (e.g. Redis) if you run multiple server instances, since the built-in limiter is per-process

---

## License

MIT — use freely for personal or commercial self-hosting.
