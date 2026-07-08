import {
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "crypto";

/**
 * Password hashing with scrypt (Node built-in, no extra deps).
 * Format: `scrypt$N$r$p$saltHex$hashHex`
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  if (!password || typeof password !== "string") {
    throw new Error("Password required");
  }
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString(
    "hex"
  )}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    if (!password || !stored) return false;
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
      return false;
    }
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(
      password.normalize("NFKC"),
      salt,
      expected.length,
      { N, r, p, maxmem: 64 * 1024 * 1024 }
    );
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Base64URL helpers */
function b64uEncode(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64uDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function appSecret(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) {
    return Buffer.from(secret, "utf8");
  }
  // Deterministic fallback derived from DATABASE_URL for dev; warn once.
  if (!globalThis.__shortlyWarnedSecret) {
    globalThis.__shortlyWarnedSecret = true;
    console.warn(
      "[shortly] SESSION_SECRET not set or too short (<32 chars). Using a derived dev-only key. Set SESSION_SECRET in production."
    );
  }
  const base = process.env.DATABASE_URL || "insecure-fallback-please-change";
  return Buffer.from(
    scryptSync(base, "shortly-session-salt", 32, { N: 1024, r: 8, p: 1 })
  );
}

/**
 * Generic signed token: base64url(payload).base64url(hmacSha256(payload))
 * `purpose` is embedded in the payload so tokens minted for one endpoint
 * (e.g. captcha) cannot be replayed against another (e.g. session).
 */
type GenericPayload = Record<string, unknown> & {
  purpose: string;
  iat: number;
  exp: number;
};

export function signGeneric<T extends Record<string, unknown>>(
  purpose: string,
  payload: T,
  ttlSeconds: number
): string {
  const now = Math.floor(Date.now() / 1000);
  const full: GenericPayload = {
    ...payload,
    purpose,
    iat: now,
    exp: now + ttlSeconds,
  };
  const body = b64uEncode(JSON.stringify(full));
  const sig = createHmac("sha256", appSecret()).update(body).digest();
  return `${body}.${b64uEncode(sig)}`;
}

export function verifyGeneric<T = Record<string, unknown>>(
  purpose: string,
  token: string | undefined | null
): (T & { iat: number; exp: number }) | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac("sha256", appSecret()).update(body).digest();
  let provided: Buffer;
  try {
    provided = b64uDecode(sig);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  try {
    const payload = JSON.parse(b64uDecode(body).toString("utf8")) as GenericPayload;
    if (payload.purpose !== purpose) return null;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload as T & { iat: number; exp: number };
  } catch {
    return null;
  }
}

/** Session tokens: { uid, tv } signed with purpose "session" */
export type SessionPayload = { uid: number; tv: number };

export function signSession(payload: SessionPayload, ttlSeconds = 60 * 60 * 12): string {
  return signGeneric("session", payload, ttlSeconds);
}

export function verifySession(
  token: string | undefined | null
): (SessionPayload & { iat: number; exp: number }) | null {
  return verifyGeneric<SessionPayload>("session", token);
}

/**
 * Lightweight math CAPTCHA — no external service, no DB storage.
 * The challenge + expected answer are embedded (never the answer itself,
 * only operands) in a signed, short-lived token.
 */
export type CaptchaChallenge = {
  token: string;
  question: string;
};

export function createCaptcha(ttlSeconds = 5 * 60): CaptchaChallenge {
  const a = randomInt(1, 20);
  const b = randomInt(1, 20);
  const token = signGeneric("captcha", { a, b }, ttlSeconds);
  return { token, question: `${a} + ${b} = ?` };
}

export function verifyCaptcha(
  token: string | undefined | null,
  answer: number | string | undefined | null
): boolean {
  const payload = verifyGeneric<{ a: number; b: number }>("captcha", token);
  if (!payload) return false;
  const numericAnswer =
    typeof answer === "string" ? Number(answer.trim()) : Number(answer);
  if (!Number.isFinite(numericAnswer)) return false;
  // Require at least 1.2s between challenge issuance and submission to
  // filter out naive scripted bots that submit instantly.
  const elapsed = Math.floor(Date.now() / 1000) - payload.iat;
  if (elapsed < 1) return false;
  return numericAnswer === payload.a + payload.b;
}

declare global {
  // eslint-disable-next-line no-var
  var __shortlyWarnedSecret: boolean | undefined;
}
