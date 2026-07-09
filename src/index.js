/**
 * Cloudflare Workers URL Shortener
 * Stack: Hono + D1 (SQLite) + Web Crypto AES-GCM URL Encryption
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import dashboardHtml from "./dashboard.html";

const app = new Hono();

// Global unhandled error boundary
app.onError((err, c) => {
  console.error("Global Error Boundary:", err);
  return c.text(`Application Error: ${err.message}\nStack: ${err.stack}`, 500);
});

// Rate limiting in-memory store
const rateMap = new Map();

// Helper to hash IP (SHA-256) for privacy-first tracking
async function hashIp(ip) {
  if (!ip) return "unknown";
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

// Client IP extractor
function clientIp(c) {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "127.0.0.1"
  );
}

// Rate Limiter: 100 requests per IP per minute
function isRateLimited(ip, limit = 100) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || entry.resetAt <= now) {
    rateMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  if (entry.count >= limit) return true;
  entry.count += 1;
  return false;
}

// PBKDF2 Password Hashing
async function hashPassword(password, salt = "shortly-system-salt-value") {
  const encoder = new TextEncoder();
  const saltBuffer = encoder.encode(salt);
  const passwordBuffer = encoder.encode(password);
  
  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBuffer,
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBuffer,
      iterations: 50000,
      hash: "SHA-256"
    },
    baseKey,
    256 // 32 bytes
  );
  
  return btoa(String.fromCharCode(...new Uint8Array(derivedBits)));
}

// AES-GCM encryption/decryption using Web Crypto API
async function getCryptoKey(secret) {
  const encoder = new TextEncoder();
  const rawKey = encoder.encode(secret.padEnd(32, '0').slice(0, 32)); // Normalize to 32 bytes key
  return await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptUrl(url, secret) {
  try {
    const key = await getCryptoKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encodedUrl = new TextEncoder().encode(url);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encodedUrl
    );
    const ivBase64 = btoa(String.fromCharCode(...iv));
    const ciphertextBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
    return `${ivBase64}.${ciphertextBase64}`;
  } catch (err) {
    console.error("Encryption error:", err);
    return url; // fallback to plain if failed
  }
}

async function decryptUrl(encryptedStr, secret) {
  try {
    if (!encryptedStr || !encryptedStr.includes(".")) return encryptedStr; // fallback if not encrypted
    const parts = encryptedStr.split(".");
    const iv = Uint8Array.from(atob(parts[0]), c => c.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(parts[1]), c => c.charCodeAt(0));
    const key = await getCryptoKey(secret);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch (err) {
    console.error("Decryption error (check AUTH_SECRET consistency):", err.message);
    return encryptedStr;
  }
}

// Secure HMAC Session Cookie management
async function createSessionToken(username, tokenVersion, secret) {
  const expires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  const payload = `${username}:${tokenVersion}:${expires}`;
  
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const sigStr = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
  return `${btoa(payload)}.${sigStr}`;
}

async function verifySessionToken(token, secret) {
  try {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    
    const payload = atob(parts[0]);
    const sigStr = parts[1];
    const [username, tokenVersion, expires] = payload.split(":");
    
    if (Date.now() > parseInt(expires)) return null;
    
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    
    const signatureBytes = Uint8Array.from(atob(sigStr), c => c.charCodeAt(0));
    const verified = await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(payload));
    
    if (!verified) return null;
    return { username, tokenVersion: parseInt(tokenVersion) };
  } catch {
    return null;
  }
}

// Stateless math CAPTCHA generator
async function generateCaptcha(secret) {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const ans = a + b;
  const expires = Date.now() + 5 * 60 * 1000; // 5 min
  const msg = `${ans}:${expires}`;
  
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(msg));
  const sigStr = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
  return {
    question: `What is ${a} + ${b}?`,
    token: `${btoa(msg)}.${sigStr}`
  };
}

async function verifyCaptcha(token, answer, secret) {
  try {
    if (!token || !answer) return false;
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    
    const msg = atob(parts[0]);
    const sigStr = parts[1];
    const [ans, expires] = msg.split(":");
    
    if (Date.now() > parseInt(expires)) return false;
    if (ans !== answer.trim()) return false;
    
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signatureBytes = Uint8Array.from(atob(sigStr), c => c.charCodeAt(0));
    return await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(msg));
  } catch {
    return false;
  }
}

// JSON formatting helpers
function jsonError(c, msg, status = 400) {
  return c.json({ success: false, error: msg }, status);
}

// Write system Audit Log
async function writeAuditLog(db, actorType, actorId, action, targetType, targetId, metadata, ipHash) {
  try {
    await db.prepare(
      "INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, metadata, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(actorType, actorId, action, targetType, targetId, JSON.stringify(metadata || {}), ipHash).run();
  } catch (err) {
    console.error("Audit log failed:", err);
  }
}

// IP Block check middleware
async function checkIpBlocklist(c, next) {
  const ip = clientIp(c);
  const ipHash = await hashIp(ip);
  const blocked = await c.env.DB.prepare("SELECT 1 FROM blocked_ips WHERE ip_hash = ? LIMIT 1").bind(ipHash).first();
  if (blocked) {
    return c.text("Forbidden: Your IP is blocked.", 403);
  }
  await next();
}

// User Gating middleware (Enforces session and injects scoped role)
async function requireAuthUser(c, next) {
  const secret = c.env.AUTH_SECRET || c.env.API_KEY || "fallback-secret-64-character-for-session-management";
  const token = getCookie(c, "session");
  const userSession = await verifySessionToken(token, secret);
  
  if (!userSession) {
    return jsonError(c, "Unauthorized: Invalid or expired session", 401);
  }
  
  const user = await c.env.DB.prepare(
    "SELECT * FROM users WHERE username = ? LIMIT 1"
  ).bind(userSession.username).first();
  
  if (!user || user.token_version !== userSession.tokenVersion) {
    return jsonError(c, "Unauthorized: Session invalidated", 401);
  }
  
  c.set("user", user);
  await next();
}

// Admin Gating middleware
async function requireAdmin(c, next) {
  await requireAuthUser(c, async () => {
    const user = c.get("user");
    if (user.role !== "admin") {
      return jsonError(c, "Forbidden: Admin privileges required", 403);
    }
    await next();
  });
}

// Bootstrap default user on first request
async function ensureAdminUser(db, env) {
  const adminUser = env.ADMIN_USERNAME || "admin";
  const user = await db.prepare("SELECT * FROM users WHERE username = ? LIMIT 1").bind(adminUser).first();
  const defaultPassword = env.ADMIN_PASSWORD || "admin";
  const hash = await hashPassword(defaultPassword);
  
  if (!user) {
    console.log(`ensureAdminUser - No master admin '${adminUser}' found, bootstrapping...`);
    await db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')"
    ).bind(adminUser, hash).run();
  } else if (env.ADMIN_PASSWORD) {
    console.log(`ensureAdminUser - ADMIN_PASSWORD env override detected, updating database hash for '${adminUser}'.`);
    await db.prepare(
      "UPDATE users SET password_hash = ? WHERE username = ?"
    ).bind(hash, adminUser).run();
  }
}

// Apply core middlewares
app.use("*", cors());
app.use("*", async (c, next) => {
  const ip = clientIp(c);
  if (isRateLimited(ip)) {
    return jsonError(c, "Rate limit exceeded. Please wait a minute.", 429);
  }
  await next();
});
app.use("*", checkIpBlocklist);

// GET / -> Public shortener HTML dashboard
app.get("/", async (c) => {
  await ensureAdminUser(c.env.DB, c.env);
  return c.html(dashboardHtml);
});

// GET /admin -> Admin Dashboard (requires session to see dashboard, otherwise login SPA handles it)
app.get("/admin", async (c) => {
  await ensureAdminUser(c.env.DB, c.env);
  return c.html(dashboardHtml);
});

// GET /api/captcha -> get stateless CAPTCHA
app.get("/api/captcha", async (c) => {
  const secret = c.env.AUTH_SECRET || c.env.API_KEY || "captcha-signing-fallback-salt";
  const captcha = await generateCaptcha(secret);
  return c.json({ success: true, ...captcha });
});

// POST /api/auth/register (User sign up)
app.post("/api/auth/register", async (c) => {
  const secret = c.env.AUTH_SECRET || c.env.API_KEY || "captcha-signing-fallback-salt";
  const body = await c.req.json().catch(() => null);
  const ip = clientIp(c);
  const ipHash = await hashIp(ip);
  
  if (!body?.username || !body?.password) {
    return jsonError(c, "Username and password are required.");
  }
  
  const username = body.username.trim().toLowerCase();
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
    return jsonError(c, "Username must be alphanumeric (3-20 chars).");
  }
  if (body.password.length < 5) {
    return jsonError(c, "Password must be at least 5 characters.");
  }
  
  const captchaVerified = await verifyCaptcha(body.captcha_token, body.captcha_answer, secret);
  if (!captchaVerified) {
    return jsonError(c, "Invalid or expired CAPTCHA.");
  }
  
  const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE username = ? LIMIT 1").bind(username).first();
  if (exists) {
    return jsonError(c, "Username is already registered.");
  }
  
  const hash = await hashPassword(body.password);
  await c.env.DB.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')"
  ).bind(username, hash).run();
  
  await writeAuditLog(c.env.DB, "public", null, "register_user", "user", username, {}, ipHash);
  return c.json({ success: true, message: "Registration successful. Please login." });
});

// POST /api/auth/login
app.post("/api/auth/login", async (c) => {
  const secret = c.env.AUTH_SECRET || c.env.API_KEY || "fallback-secret-64-character-for-session-management";
  const body = await c.req.json().catch(() => null);
  const ip = clientIp(c);
  const ipHash = await hashIp(ip);
  
  if (!body?.username || !body?.password) {
    return jsonError(c, "Username and password required");
  }

  const captchaVerified = await verifyCaptcha(body.captcha_token, body.captcha_answer, secret);
  if (!captchaVerified) {
    return jsonError(c, "Invalid or expired CAPTCHA answer.");
  }
  
  const username = body.username.trim().toLowerCase();
  console.log(`Login attempt for user: ${username}`);
  
  const user = await c.env.DB.prepare(
    "SELECT * FROM users WHERE username = ? LIMIT 1"
  ).bind(username).first();
  
  if (!user) {
    console.log(`Login failed: user '${username}' not found in database.`);
    await writeAuditLog(c.env.DB, "public", null, "login_failed", "user", username, { reason: "User not found" }, ipHash);
    return jsonError(c, "Invalid credentials", 401);
  }
  
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return jsonError(c, `Account locked. Try again after ${new Date(user.locked_until).toLocaleTimeString()}`, 403);
  }
  
  const passwordHash = await hashPassword(body.password);
  console.log(`DB stored hash: ${user.password_hash}`);
  console.log(`Computed input hash: ${passwordHash}`);
  
  if (passwordHash !== user.password_hash) {
    const attempts = user.failed_attempts + 1;
    let lockedUntil = null;
    
    if (attempts >= 5) {
      const lockDate = new Date(Date.now() + 15 * 60 * 1000);
      lockedUntil = lockDate.toISOString();
      await c.env.DB.prepare(
        "UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?"
      ).bind(attempts, lockedUntil, user.id).run();
      await writeAuditLog(c.env.DB, "public", null, "account_locked", "user", user.username, { attempts }, ipHash);
      return jsonError(c, "Account locked due to too many failed attempts. Try again in 15 minutes.", 403);
    } else {
      await c.env.DB.prepare(
        "UPDATE users SET failed_attempts = ? WHERE id = ?"
      ).bind(attempts, user.id).run();
      await writeAuditLog(c.env.DB, "public", null, "login_failed", "user", user.username, { attempts }, ipHash);
      return jsonError(c, `Invalid credentials. Attempts remaining: ${5 - attempts}`, 401);
    }
  }
  
  await c.env.DB.prepare(
    "UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?"
  ).bind(new Date().toISOString(), user.id).run();
  
  const sessionToken = await createSessionToken(user.username, user.token_version, secret);
  
  setCookie(c, "session", sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 24 * 60 * 60
  });
  
  await writeAuditLog(c.env.DB, "admin", user.id, "login_success", "user", user.username, {}, ipHash);
  return c.json({ success: true, username: user.username });
});

// POST /api/auth/logout (Authenticated user only)
app.post("/api/auth/logout", requireAuthUser, async (c) => {
  const user = c.get("user");
  const ipHash = await hashIp(clientIp(c));
  deleteCookie(c, "session");
  await writeAuditLog(c.env.DB, "admin", user.id, "logout", "user", user.username, {}, ipHash);
  return c.json({ success: true });
});

// POST /api/auth/change-password (Authenticated user only)
app.post("/api/auth/change-password", requireAuthUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  const ipHash = await hashIp(clientIp(c));
  
  if (!body?.password || body.password.length < 5) {
    return jsonError(c, "New password must be at least 5 characters long");
  }
  
  const newHash = await hashPassword(body.password);
  const newTokenVersion = user.token_version + 1;
  
  await c.env.DB.prepare(
    "UPDATE users SET password_hash = ?, token_version = ? WHERE id = ?"
  ).bind(newHash, newTokenVersion, user.id).run();
  
  await writeAuditLog(c.env.DB, "admin", user.id, "change_password", "user", user.username, {}, ipHash);
  deleteCookie(c, "session");
  return c.json({ success: true, message: "Password updated successfully. Please login again." });
});

// GET /api/auth/me (Check session state)
app.get("/api/auth/me", async (c) => {
  const secret = c.env.AUTH_SECRET || c.env.API_KEY || "fallback-secret-64-character-for-session-management";
  const token = getCookie(c, "session");
  const userSession = await verifySessionToken(token, secret);
  if (!userSession) return c.json({ authenticated: false });
  return c.json({ authenticated: true, username: userSession.username });
});

// PUBLIC: POST /api/shorten -> Create link anonymously (encrypted at rest)
app.post("/api/shorten", async (c) => {
  const secret = c.env.AUTH_SECRET || c.env.API_KEY || "captcha-signing-fallback-salt";
  const body = await c.req.json().catch(() => null);
  const ip = clientIp(c);
  const ipHash = await hashIp(ip);
  
  if (!body?.url || !/^https?:\/\//i.test(body.url)) {
    return jsonError(c, "A valid URL starting with http:// or https:// is required");
  }
  
  const captchaVerified = await verifyCaptcha(body.captcha_token, body.captcha_answer, secret);
  if (!captchaVerified) {
    return jsonError(c, "Invalid or expired CAPTCHA answer.");
  }
  
  const requestOrigin = new URL(c.req.url).origin;
  const origin = (c.env.APP_URL && c.env.APP_URL !== "https://example.com" ? c.env.APP_URL : requestOrigin).replace(/\/$/, "");
  if (body.url.startsWith(origin)) {
    return jsonError(c, "Self-referencing redirection loops are blocked.");
  }
  if (/\.(exe|dmg|msi|apk|bat|sh)$/i.test(body.url)) {
    return jsonError(c, "Executable redirects are blocked for safety.");
  }
  
  let slug = body.slug ? body.slug.trim() : "";
  if (slug) {
    if (!/^[a-zA-Z0-9_-]{2,64}$/.test(slug)) {
      return jsonError(c, "Custom slug must be alphanumeric (2-64 chars)");
    }
    const exists = await c.env.DB.prepare("SELECT 1 FROM links WHERE slug = ? LIMIT 1").bind(slug).first();
    if (exists) return jsonError(c, "Custom slug is already taken");
  } else {
    let attempts = 0;
    while (attempts < 5) {
      const hashInput = body.url + Date.now() + Math.random().toString();
      const encoder = new TextEncoder();
      const digest = await crypto.subtle.digest("SHA-256", encoder.encode(hashInput));
      const fullHash = [...new Uint8Array(digest)]
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
      slug = fullHash.slice(0, 8);
      const exists = await c.env.DB.prepare("SELECT 1 FROM links WHERE slug = ? LIMIT 1").bind(slug).first();
      if (!exists) break;
      attempts++;
    }
  }
  
  // Encrypt destination URL
  const encryptedUrl = await encryptUrl(body.url, secret);
  
  await c.env.DB.prepare(
    "INSERT INTO links (slug, url, title, redirect_type, created_by_ip_hash, user_id) VALUES (?, ?, ?, 302, ?, NULL)"
  ).bind(slug, encryptedUrl, body.title || "Public Link", ipHash).run();
  
  await writeAuditLog(c.env.DB, "public", null, "create_link", "link", slug, { url: "[encrypted]" }, ipHash);
  
  return c.json({
    success: true,
    data: {
      slug,
      short_url: `${origin}/${slug}`,
      url: body.url,
      created_at: new Date().toISOString()
    }
  });
});

// SCOPED: GET /api/links (Paginated & Searchable list, scoped by user_id)
app.get("/api/links", requireAuthUser, async (c) => {
  const user = c.get("user");
  const secret = c.env.AUTH_SECRET || c.env.API_KEY || "fallback-secret-64-character-for-session-management";
  const query = c.req.query();
  const search = query.search ? `%${query.search}%` : "%";
  const limit = parseInt(query.limit) || 10;
  const page = parseInt(query.page) || 1;
  const offset = (page - 1) * limit;
  const origin = (c.env.APP_URL || new URL(c.req.url).origin).replace(/\/$/, "");
  
  let total, rows;
  
  if (user.role === "admin") {
    // Admin sees all links
    total = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM links WHERE (slug LIKE ? OR title LIKE ?) AND is_active = 1"
    ).bind(search, search).first();
    rows = await c.env.DB.prepare(
      "SELECT * FROM links WHERE (slug LIKE ? OR title LIKE ?) AND is_active = 1 ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).bind(search, search, limit, offset).all();
  } else {
    // User sees only their links
    total = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM links WHERE user_id = ? AND (slug LIKE ? OR title LIKE ?) AND is_active = 1"
    ).bind(user.id, search, search).first();
    rows = await c.env.DB.prepare(
      "SELECT * FROM links WHERE user_id = ? AND (slug LIKE ? OR title LIKE ?) AND is_active = 1 ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).bind(user.id, search, search, limit, offset).all();
  }
  
  const formatted = await Promise.all(rows.results.map(async row => ({
    ...row,
    url: await decryptUrl(row.url, secret),
    short_url: `${origin}/${row.slug}`,
    is_active: !!row.is_active
  })));
  
  return c.json({
    success: true,
    data: formatted,
    pagination: {
      total: total.count,
      page,
      limit,
      total_pages: Math.ceil(total.count / limit)
    }
  });
});

// SCOPED: POST /api/links (Authenticated link creation, associated with user_id)
app.post("/api/links", requireAuthUser, async (c) => {
  const user = c.get("user");
  const secret = c.env.AUTH_SECRET || c.env.API_KEY || "fallback-secret-64-character-for-session-management";
  const body = await c.req.json().catch(() => null);
  const ipHash = await hashIp(clientIp(c));
  
  if (!body?.url || !/^https?:\/\//i.test(body.url)) {
    return jsonError(c, "A valid URL with http:// or https:// is required");
  }
  
  let slug = body.slug ? body.slug.trim() : "";
  if (slug) {
    if (!/^[a-zA-Z0-9_-]{2,64}$/.test(slug)) {
      return jsonError(c, "Slug must be alphanumeric (2-64 chars)");
    }
    const exists = await c.env.DB.prepare("SELECT 1 FROM links WHERE slug = ? LIMIT 1").bind(slug).first();
    if (exists) return jsonError(c, "Slug is already taken");
  } else {
    let attempts = 0;
    while (attempts < 5) {
      const hashInput = body.url + Date.now() + Math.random().toString();
      const encoder = new TextEncoder();
      const digest = await crypto.subtle.digest("SHA-256", encoder.encode(hashInput));
      const fullHash = [...new Uint8Array(digest)]
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
      slug = fullHash.slice(0, 8);
      const exists = await c.env.DB.prepare("SELECT 1 FROM links WHERE slug = ? LIMIT 1").bind(slug).first();
      if (!exists) break;
      attempts++;
    }
  }
  
  // Encrypt destination URL
  const encryptedUrl = await encryptUrl(body.url, secret);
  
  await c.env.DB.prepare(
    "INSERT INTO links (slug, url, title, expires_at, password, redirect_type, created_by_ip_hash, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    slug, 
    encryptedUrl, 
    body.title || null, 
    body.expires_at || null, 
    body.password ? await hashPassword(body.password) : null,
    body.redirect_type || 302,
    ipHash,
    user.id
  ).run();
  
  await writeAuditLog(c.env.DB, "user", user.id, "create_link", "link", slug, { url: "[encrypted]" }, ipHash);
  
  const requestOrigin = new URL(c.req.url).origin;
  const origin = (c.env.APP_URL && c.env.APP_URL !== "https://example.com" ? c.env.APP_URL : requestOrigin).replace(/\/$/, "");
  return c.json({
    success: true,
    data: { slug, short_url: `${origin}/${slug}`, url: body.url }
  });
});

// SCOPED: PUT /api/links/:id (Edit link, verifies ownership)
app.put("/api/links/:id", requireAuthUser, async (c) => {
  const user = c.get("user");
  const secret = c.env.AUTH_SECRET || c.env.API_KEY || "fallback-secret-64-character-for-session-management";
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const ipHash = await hashIp(clientIp(c));
  
  const link = await c.env.DB.prepare("SELECT * FROM links WHERE id = ? LIMIT 1").bind(id).first();
  if (!link) return jsonError(c, "Link not found", 404);
  
  // Verify ownership (unless admin)
  if (user.role !== "admin" && link.user_id !== user.id) {
    return jsonError(c, "Forbidden: Access denied", 403);
  }
  
  if (!body?.url || !/^https?:\/\//i.test(body.url)) {
    return jsonError(c, "A valid URL is required");
  }
  
  let passwordHash = link.password;
  if (body.password !== undefined) {
    passwordHash = body.password ? await hashPassword(body.password) : null;
  }
  
  // Encrypt destination URL
  const encryptedUrl = await encryptUrl(body.url, secret);
  
  await c.env.DB.prepare(
    "UPDATE links SET url = ?, title = ?, expires_at = ?, password = ?, redirect_type = ? WHERE id = ?"
  ).bind(
    encryptedUrl, 
    body.title || null, 
    body.expires_at || null, 
    passwordHash,
    body.redirect_type || 302, 
    id
  ).run();
  
  await writeAuditLog(c.env.DB, "user", user.id, "edit_link", "link", link.slug, { url: "[encrypted]" }, ipHash);
  return c.json({ success: true });
});

// SCOPED: DELETE /api/links/:id (Soft-delete link, verifies ownership)
app.delete("/api/links/:id", requireAuthUser, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const ipHash = await hashIp(clientIp(c));
  
  const link = await c.env.DB.prepare("SELECT * FROM links WHERE id = ? LIMIT 1").bind(id).first();
  if (!link) return jsonError(c, "Link not found", 404);
  
  // Verify ownership
  if (user.role !== "admin" && link.user_id !== user.id) {
    return jsonError(c, "Forbidden: Access denied", 403);
  }
  
  await c.env.DB.prepare("UPDATE links SET is_active = 0 WHERE id = ?").bind(id).run();
  await writeAuditLog(c.env.DB, "user", user.id, "delete_link", "link", link.slug, {}, ipHash);
  return c.json({ success: true });
});

// SCOPED: GET /api/stats (Overall dashboard stats, scoped by user_id)
app.get("/api/stats", requireAuthUser, async (c) => {
  const user = c.get("user");
  let totalLinks, totalClicks, topLinks;
  
  if (user.role === "admin") {
    totalLinks = await c.env.DB.prepare("SELECT COUNT(*) as count FROM links WHERE is_active = 1").first();
    totalClicks = await c.env.DB.prepare("SELECT COUNT(*) as count FROM clicks").first();
    topLinks = await c.env.DB.prepare(
      "SELECT slug, url, clicks FROM links WHERE is_active = 1 ORDER BY clicks DESC LIMIT 5"
    ).all();
  } else {
    totalLinks = await c.env.DB.prepare("SELECT COUNT(*) as count FROM links WHERE user_id = ? AND is_active = 1").bind(user.id).first();
    totalClicks = await c.env.DB.prepare("SELECT COUNT(*) as count FROM clicks WHERE slug IN (SELECT slug FROM links WHERE user_id = ?)").bind(user.id).first();
    topLinks = await c.env.DB.prepare(
      "SELECT slug, url, clicks FROM links WHERE user_id = ? AND is_active = 1 ORDER BY clicks DESC LIMIT 5"
    ).bind(user.id).all();
  }
  
  // Clicks last 7 days chart array
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    
    let clickCount;
    if (user.role === "admin") {
      clickCount = await c.env.DB.prepare(
        "SELECT COUNT(*) as count FROM clicks WHERE timestamp LIKE ?"
      ).bind(`${dateStr}%`).first();
    } else {
      clickCount = await c.env.DB.prepare(
        "SELECT COUNT(*) as count FROM clicks WHERE slug IN (SELECT slug FROM links WHERE user_id = ?) AND timestamp LIKE ?"
      ).bind(user.id, `${dateStr}%`).first();
    }
    
    last7Days.push({ date: dateStr, clicks: clickCount.count });
  }
  
  return c.json({
    success: true,
    total_links: totalLinks.count,
    total_clicks: totalClicks.count,
    clicks_last_7_days: last7Days,
    top_links: topLinks.results
  });
});

// SCOPED: GET /api/stats/:slug (Per-link specific stats, verifies ownership)
app.get("/api/stats/:slug", requireAuthUser, async (c) => {
  const user = c.get("user");
  const secret = c.env.AUTH_SECRET || c.env.API_KEY || "fallback-secret-64-character-for-session-management";
  const slug = c.req.param("slug");
  
  const link = await c.env.DB.prepare("SELECT * FROM links WHERE slug = ? AND is_active = 1 LIMIT 1").bind(slug).first();
  if (!link) return jsonError(c, "Link not found", 404);
  
  // Verify ownership
  if (user.role !== "admin" && link.user_id !== user.id) {
    return jsonError(c, "Forbidden: Access denied", 403);
  }
  
  const clicksByCountry = await c.env.DB.prepare(
    "SELECT country, COUNT(*) as count FROM clicks WHERE slug = ? GROUP BY country ORDER BY count DESC LIMIT 10"
  ).bind(slug).all();
  
  const recentClicks = await c.env.DB.prepare(
    "SELECT timestamp, referrer, user_agent, country, city FROM clicks WHERE slug = ? ORDER BY timestamp DESC LIMIT 20"
  ).bind(slug).all();
  
  return c.json({
    success: true,
    slug,
    url: await decryptUrl(link.url, secret),
    title: link.title,
    clicks: link.clicks,
    clicks_by_country: clicksByCountry.results,
    recent_clicks: recentClicks.results
  });
});

// ADMIN: GET /api/admin/blocked-ips
app.get("/api/admin/blocked-ips", requireAdmin, async (c) => {
  const list = await c.env.DB.prepare("SELECT * FROM blocked_ips ORDER BY created_at DESC").all();
  return c.json({ success: true, data: list.results });
});

app.post("/api/admin/blocked-ips", requireAdmin, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  const ipHash = await hashIp(clientIp(c));
  
  if (!body?.ip_hash) return jsonError(c, "IP Hash is required");
  
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO blocked_ips (ip_hash, reason) VALUES (?, ?)"
  ).bind(body.ip_hash, body.reason || "Manual Block").run();
  
  await writeAuditLog(c.env.DB, "admin", user.id, "block_ip", "ip", body.ip_hash, { reason: body.reason }, ipHash);
  return c.json({ success: true });
});

app.delete("/api/admin/blocked-ips/:id", requireAdmin, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const ipHash = await hashIp(clientIp(c));
  
  const block = await c.env.DB.prepare("SELECT * FROM blocked_ips WHERE id = ? LIMIT 1").bind(id).first();
  await c.env.DB.prepare("DELETE FROM blocked_ips WHERE id = ?").bind(id).run();
  if (block) {
    await writeAuditLog(c.env.DB, "admin", user.id, "unblock_ip", "ip", block.ip_hash, {}, ipHash);
  }
  return c.json({ success: true });
});

// ADMIN: Audit Trail endpoint
app.get("/api/admin/audit-log", requireAdmin, async (c) => {
  const logs = await c.env.DB.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100").all();
  return c.json({ success: true, data: logs.results });
});

// PUBLIC: GET /api/qr/:slug -> API endpoint redirect to qrserver
app.get("/api/qr/:slug", async (c) => {
  const slug = c.req.param("slug");
  const link = await c.env.DB.prepare("SELECT 1 FROM links WHERE slug = ? AND is_active = 1 LIMIT 1").bind(slug).first();
  if (!link) return jsonError(c, "Slug not found", 404);
  
  const origin = (c.env.APP_URL || new URL(c.req.url).origin).replace(/\/$/, "");
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(`${origin}/${slug}`)}`;
  
  return c.redirect(qrUrl);
});

// PUBLIC REDIRECT: GET /:slug (Decrypts destination URL at runtime)
app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const secret = c.env.AUTH_SECRET || c.env.API_KEY || "captcha-signing-fallback-salt";
  
  // Skip routing reserved words
  const reserved = ["api", "health", "favicon.ico", "admin"];
  if (reserved.includes(slug)) return c.notFound();
  
  const link = await c.env.DB.prepare("SELECT * FROM links WHERE slug = ? AND is_active = 1 LIMIT 1").bind(slug).first();
  if (!link) return c.notFound();
  
  // Expiration date validation
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    return c.text("Expired: This short link has expired.", 410);
  }
  
  // Password protection validation
  if (link.password) {
    const pwInput = c.req.query("password");
    if (!pwInput) {
      return c.html(`
        <html>
          <head>
            <title>Password Required</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
              form { background: #1e293b; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 300px; }
              input { width: 100%; padding: 0.5rem; margin: 0.5rem 0 1rem; box-sizing: border-box; border-radius: 4px; border: 1px solid #475569; background: #0f172a; color: #fff; }
              button { width: 100%; padding: 0.5rem; background: #3b82f6; border: none; color: #fff; border-radius: 4px; cursor: pointer; }
            </style>
          </head>
          <body>
            <form method="GET">
              <h3>Password Protected Link</h3>
              <label>Enter Password:</label>
              <input type="password" name="password" required autofocus />
              <button type="submit">Access Redirect</button>
            </form>
          </body>
        </html>
      `, 401);
    }
    
    const inputHash = await hashPassword(pwInput);
    if (inputHash !== link.password) {
      return c.text("Unauthorized: Incorrect link password", 401);
    }
  }
  
  // Log click event asynchronously using executionCtx.waitUntil
  const ip = clientIp(c);
  const userAgent = c.req.header("user-agent") || "";
  const referrer = c.req.header("referer") || "";
  const country = c.req.header("cf-ipcountry") || "unknown";
  const city = c.req.header("cf-ipcity") || "";
  
  c.executionCtx.waitUntil((async () => {
    try {
      const ipHash = await hashIp(ip);
      // Insert click details
      await c.env.DB.prepare(
        "INSERT INTO clicks (slug, referrer, user_agent, country, city, ip_hash) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(slug, referrer, userAgent, country, city, ipHash).run();
      
      // Update link click counters
      await c.env.DB.prepare(
        "UPDATE links SET clicks = clicks + 1, last_clicked = ? WHERE id = ?"
      ).bind(new Date().toISOString(), link.id).run();
    } catch (err) {
      console.error("Failed to log click statistics asynchronously:", err);
    }
  })());
  
  // Decrypt URL at runtime
  const decryptedUrl = await decryptUrl(link.url, secret);
  return c.redirect(decryptedUrl, link.redirect_type || 302);
});

export default app;
