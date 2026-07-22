import crypto from "node:crypto";
import { google } from "googleapis";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];
export const RT_COOKIE = "cerfa_google_rt";
export const EMAIL_COOKIE = "cerfa_google_email";
export const STATE_COOKIE = "cerfa_oauth_state";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 jours

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d’environnement manquante : ${name}`);
  return value;
}

function cookieSecret() {
  const raw =
    process.env.SESSION_SECRET ||
    process.env.AUTH_PASSWORD_HASH ||
    "cerfa-dev-insecure-secret";
  return crypto.createHash("sha256").update(raw).digest();
}

export function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cookieSecret(), iv);
  const enc = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function openSealed(sealed) {
  try {
    const buf = Buffer.from(String(sealed), "base64url");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", cookieSecret(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function isSecureRequest(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return proto === "https";
}

export function publicOrigin(req) {
  const proto = isSecureRequest(req) ? "https" : "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  return `${proto}://${host}`;
}

export function redirectUri(req) {
  return `${publicOrigin(req)}/api/auth/google/callback`;
}

/** Client OAuth pour le flux d’autorisation (avec redirect_uri). */
export function createOAuthClient(req) {
  return new google.auth.OAuth2(
    requiredEnv("GOOGLE_CLIENT_ID"),
    requiredEnv("GOOGLE_CLIENT_SECRET"),
    redirectUri(req)
  );
}

/**
 * Client OAuth pour appeler l’API Drive (refresh token).
 * Sans redirect_uri : évite unauthorized_client quand le token
 * a été émis avec un autre type de client / URI.
 */
export function createOAuthClientForApi() {
  return new google.auth.OAuth2(
    requiredEnv("GOOGLE_CLIENT_ID"),
    requiredEnv("GOOGLE_CLIENT_SECRET")
  );
}

export function setCookie(res, name, value, { maxAge = COOKIE_MAX_AGE, httpOnly = true, secure } = {}) {
  const useSecure = secure ?? true;
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "SameSite=Lax",
  ];
  if (httpOnly) parts.push("HttpOnly");
  if (useSecure) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

export function clearCookie(res, name) {
  appendSetCookie(
    res,
    `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`
  );
}

function appendSetCookie(res, line) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", line);
  } else if (Array.isArray(prev)) {
    res.setHeader("Set-Cookie", [...prev, line]);
  } else {
    res.setHeader("Set-Cookie", [prev, line]);
  }
}

export function getUserRefreshToken(req) {
  const cookies = parseCookies(req);
  const sealed = cookies[RT_COOKIE];
  if (!sealed) return null;
  return openSealed(sealed);
}

export function getUserEmail(req) {
  const cookies = parseCookies(req);
  return cookies[EMAIL_COOKIE] || null;
}

export function clearGoogleSessionCookies(res) {
  clearCookie(res, RT_COOKIE);
  clearCookie(res, EMAIL_COOKIE);
  clearCookie(res, STATE_COOKIE);
}

/**
 * Client Drive pour la requête : uniquement le compte connecté via cookie.
 * (Plus de fallback GOOGLE_REFRESH_TOKEN — source fréquente de unauthorized_client
 * quand le token desktop ne correspond plus au client Web.)
 */
export function getOAuthClientForRequest(req) {
  const userRt = getUserRefreshToken(req);
  if (!userRt) {
    const err = new Error(
      "Google Drive non connecté. La connexion sera demandée à l’enregistrement."
    );
    err.statusCode = 401;
    err.code = "GOOGLE_NOT_CONNECTED";
    throw err;
  }
  const client = createOAuthClientForApi();
  client.setCredentials({ refresh_token: userRt });
  return { client, source: "user" };
}

export function randomState() {
  return crypto.randomBytes(24).toString("base64url");
}

export function isGoogleAuthError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  const dataErr = String(err?.response?.data?.error || "").toLowerCase();
  return (
    dataErr === "unauthorized_client" ||
    dataErr === "invalid_grant" ||
    msg.includes("unauthorized_client") ||
    msg.includes("invalid_grant")
  );
}
