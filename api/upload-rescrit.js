import {
  assertAuthorized,
  getDrive,
  nextReceiptNumber,
  currentYear,
  parseDonNumber,
  listDonFiles,
  ensureYearFolder,
  uploadPdf,
  sendJson,
  readBody,
  getParentFolderId,
  DRIVE_BUILD,
} from "../lib/drive.js";

void process.env.GOOGLE_CLIENT_ID;
void process.env.GOOGLE_CLIENT_SECRET;
void process.env.GOOGLE_REFRESH_TOKEN;
void process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
void process.env.GOOGLE_DRIVE_YEAR_FOLDER_ID;
void process.env.AUTH_PASSWORD_HASH;

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Méthode non autorisée" });
    return;
  }

  try {
    assertAuthorized(req);
    const parentFolderId = getParentFolderId();

    const receiptNumber = String(req.headers["x-receipt-number"] || "").trim();
    if (!/^DON\d{7}$/i.test(receiptNumber)) {
      sendJson(res, 400, {
        error: "En-tête X-Receipt-Number invalide (attendu DONYYYYXXX)",
      });
      return;
    }

    const year = receiptNumber.slice(3, 7);
    const seq = parseDonNumber(receiptNumber, year);
    if (seq == null) {
      sendJson(res, 400, { error: "Numéro de reçu illisible" });
      return;
    }

    const pdfBuffer = await readBody(req);
    if (!pdfBuffer?.length) {
      sendJson(res, 400, { error: "PDF manquant" });
      return;
    }
    if (pdfBuffer.subarray(0, 4).toString() !== "%PDF") {
      sendJson(res, 400, { error: "Le corps de la requête n’est pas un PDF" });
      return;
    }

    const drive = getDrive();
    const folder = await ensureYearFolder(drive, year || currentYear());
    const existing = await listDonFiles(drive, folder.id, year);
    const clash = existing.find(
      (f) => f.name.replace(/\.pdf$/i, "").toUpperCase() === receiptNumber.toUpperCase()
    );
    if (clash) {
      sendJson(res, 409, {
        error: `Le fichier ${receiptNumber}.pdf existe déjà sur Drive`,
        fileId: clash.id,
      });
      return;
    }

    const expected = await nextReceiptNumber(drive, year);
    if (expected.receiptNumber.toUpperCase() !== receiptNumber.toUpperCase()) {
      sendJson(res, 409, {
        error: `Numéro obsolète. Prochain disponible : ${expected.receiptNumber}`,
        receiptNumber: expected.receiptNumber,
      });
      return;
    }

    const file = await uploadPdf(drive, {
      folderId: folder.id,
      receiptNumber: receiptNumber.toUpperCase(),
      pdfBuffer,
    });

    sendJson(res, 200, {
      ok: true,
      receiptNumber: receiptNumber.toUpperCase(),
      year,
      folderId: folder.id,
      fileId: file.id,
      fileName: file.name,
      webViewLink: file.webViewLink || null,
      parentFolderId,
      build: DRIVE_BUILD,
    });
  } catch (err) {
    console.error(err);
    sendJson(res, err.statusCode || 500, {
      error: err.message || "Erreur lors de l’upload Drive",
      parentFolderId: getParentFolderId(),
      build: DRIVE_BUILD,
    });
  }
}
