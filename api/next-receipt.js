import {
  assertAuthorized,
  getDrive,
  nextReceiptNumber,
  currentYear,
  sendJson,
  getQuery,
  getParentFolderId,
} from "../lib/drive.js";

// Références statiques pour que Vercel injecte bien ces env vars dans la function
void process.env.GOOGLE_CLIENT_ID;
void process.env.GOOGLE_CLIENT_SECRET;
void process.env.GOOGLE_REFRESH_TOKEN;
void process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
void process.env.AUTH_PASSWORD_HASH;

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
    // Valide tôt → message clair si l’ID parent est vide / invalide
    getParentFolderId();

    const query = getQuery(req);
    const yearParam = query.year;
    const year =
      yearParam && /^\d{4}$/.test(String(yearParam))
        ? String(yearParam)
        : currentYear();
    const drive = getDrive();
    const result = await nextReceiptNumber(drive, year);
    sendJson(res, 200, result);
  } catch (err) {
    console.error(err);
    sendJson(res, err.statusCode || 500, {
      error: err.message || "Erreur lors du calcul du numéro",
    });
  }
}
