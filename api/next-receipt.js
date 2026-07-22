import {
  assertAuthorized,
  getDrive,
  nextReceiptNumber,
  currentYear,
  sendJson,
} from "./_lib/drive.js";

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
    const yearParam = req.query?.year;
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
