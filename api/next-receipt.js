import {
  assertAuthorized,
  getDrive,
  nextReceiptNumber,
  currentYear,
  sendJson,
  getQuery,
  getParentFolderId,
  DRIVE_BUILD,
} from "../lib/drive.js";
import { clearGoogleSessionCookies } from "../lib/google-auth.js";

void process.env.GOOGLE_CLIENT_ID;
void process.env.GOOGLE_CLIENT_SECRET;
void process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
void process.env.GOOGLE_DRIVE_YEAR_FOLDER_ID;
void process.env.AUTH_PASSWORD_HASH;
void process.env.SESSION_SECRET;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { error: "Méthode non autorisée" });
    return;
  }

  try {
    assertAuthorized(req);
    const parentFolderId = getParentFolderId();

    const query = getQuery(req);
    const yearParam = query.year;
    const year =
      yearParam && /^\d{4}$/.test(String(yearParam))
        ? String(yearParam)
        : currentYear();
    const drive = getDrive(req);
    const result = await nextReceiptNumber(drive, year);
    sendJson(res, 200, { ...result, parentFolderId, build: DRIVE_BUILD });
  } catch (err) {
    console.error(err);
    if (err.code === "GOOGLE_REAUTH_REQUIRED" || err.code === "GOOGLE_NOT_CONNECTED") {
      clearGoogleSessionCookies(res);
    }
    sendJson(res, err.statusCode || 500, {
      error: err.message || "Erreur lors du calcul du numéro",
      code: err.code || undefined,
      detail: err.detail || undefined,
      parentFolderId: getParentFolderId(),
      build: DRIVE_BUILD,
    });
  }
}
