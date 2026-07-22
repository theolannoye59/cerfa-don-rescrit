import { Readable } from "node:stream";
import { google } from "googleapis";
import { getOAuthClientForRequest, isGoogleAuthError } from "./google-auth.js";

/** Dossier Drive « racine rescrits » (peut être inaccessible en lecture si seul YYYY est partagé). */
const DEFAULT_PARENT_FOLDER_ID = "1uKyNWqsgBbzCEcpgHtw9ayNtCCt8eh";

export const DRIVE_BUILD = "2026-07-22-dual-actions-oauth-fix";

function looksLikeDriveId(id) {
  return /^[a-zA-Z0-9_-]{20,}$/.test(id);
}

export function getParentFolderId() {
  const raw = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
  const trimmed = raw == null ? "" : String(raw).trim();
  if (looksLikeDriveId(trimmed)) return trimmed;
  return DEFAULT_PARENT_FOLDER_ID;
}

/** ID direct du dossier année (ex. 2026) — utile si les parents ne sont pas visibles. */
export function getYearFolderIdOverride() {
  const raw = process.env.GOOGLE_DRIVE_YEAR_FOLDER_ID;
  const trimmed = raw == null ? "" : String(raw).trim();
  return looksLikeDriveId(trimmed) ? trimmed : null;
}

/** Drive API authentifiée avec le compte Google de la requête (cookie). */
export function getDrive(req) {
  if (!req) throw new Error("getDrive(req) : requête HTTP manquante");
  const { client } = getOAuthClientForRequest(req);
  return google.drive({ version: "v3", auth: client });
}

export function currentYear(date = new Date()) {
  return String(date.getFullYear());
}

/** DONYYYYXXX — XXX sur 3 chiffres, numérotation dans l’année. */
export function parseDonNumber(name, year) {
  const base = String(name || "").replace(/\.pdf$/i, "");
  const match = base.match(new RegExp(`^DON${year}(\\d{3})$`, "i"));
  return match ? Number.parseInt(match[1], 10) : null;
}

export function formatDonNumber(year, seq) {
  return `DON${year}${String(seq).padStart(3, "0")}`;
}

export function wrapDriveError(err, context = {}) {
  const base = err?.message || String(err);
  const bits = [base];
  if (context.op) bits.push(`op=${context.op}`);
  if (context.parentId) bits.push(`parent=${context.parentId}`);
  if (context.folderId) bits.push(`folder=${context.folderId}`);
  if (context.year) bits.push(`year=${context.year}`);
  bits.push(`build=${DRIVE_BUILD}`);

  if (isGoogleAuthError(err) || isGoogleAuthError({ message: base })) {
    const wrapped = new Error(
      "Session Google invalide (unauthorized_client / invalid_grant). Reconnectez Google Drive puis réessayez."
    );
    wrapped.statusCode = 401;
    wrapped.code = "GOOGLE_REAUTH_REQUIRED";
    wrapped.detail = bits.join(" | ");
    wrapped.cause = err;
    return wrapped;
  }

  const wrapped = new Error(bits.join(" | "));
  const rawStatus =
    err?.statusCode || err?.response?.status || Number(err?.code) || 500;
  wrapped.statusCode =
    typeof rawStatus === "number" && rawStatus >= 400 && rawStatus < 600
      ? rawStatus
      : 500;
  wrapped.cause = err;
  return wrapped;
}

async function getFolderById(drive, folderId, op) {
  try {
    const { data } = await drive.files.get({
      fileId: folderId,
      fields: "id, name, mimeType",
      supportsAllDrives: true,
    });
    if (!data?.id) throw new Error(`Dossier Drive sans id (${folderId})`);
    if (data.mimeType && data.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error(`L’ID ${folderId} n’est pas un dossier (mime=${data.mimeType})`);
    }
    return data;
  } catch (err) {
    throw wrapDriveError(err, { op, folderId });
  }
}

/** true si le compte OAuth peut au moins lire le dossier parent. */
export async function canAccessParentFolder(drive) {
  const parentId = getParentFolderId();
  try {
    await getFolderById(drive, parentId, "files.get(parent)");
    return true;
  } catch {
    return false;
  }
}

async function findYearFolderUnderParent(drive, year) {
  const parentId = getParentFolderId();
  const q = [
    `'${parentId}' in parents`,
    "trashed = false",
    "mimeType = 'application/vnd.google-apps.folder'",
    `name = '${year}'`,
  ].join(" and ");

  try {
    const { data } = await drive.files.list({
      q,
      fields: "files(id, name)",
      spaces: "drive",
      corpora: "allDrives",
      pageSize: 10,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return data.files?.[0] || null;
  } catch (err) {
    // Parent invisible / droits partiels → on bascule sur la recherche globale
    console.warn("findYearFolderUnderParent failed:", err?.message || err);
    return null;
  }
}

/**
 * Cherche un dossier nommé YYYY visible par le compte (drive partagé / dossier partagé),
 * sans exiger l’accès aux parents.
 */
async function findYearFolderByName(drive, year) {
  const q = [
    "trashed = false",
    "mimeType = 'application/vnd.google-apps.folder'",
    `name = '${year}'`,
  ].join(" and ");

  try {
    const { data } = await drive.files.list({
      q,
      fields: "files(id, name)",
      spaces: "drive",
      corpora: "allDrives",
      pageSize: 25,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      orderBy: "modifiedTime desc",
    });
    const files = data.files || [];
    if (files.length === 0) return null;
    if (files.length === 1) return files[0];

    // Plusieurs dossiers « 2026 » : on préfère celui qui contient déjà des DON*
    for (const candidate of files) {
      const dons = await listDonFiles(drive, candidate.id, year);
      if (dons.length > 0) return candidate;
    }
    return files[0];
  } catch (err) {
    throw wrapDriveError(err, { op: "files.list(yearByName)", year });
  }
}

export async function findYearFolder(drive, year) {
  const underParent = await findYearFolderUnderParent(drive, year);
  if (underParent?.id) return underParent;
  return findYearFolderByName(drive, year);
}

export async function ensureYearFolder(drive, year) {
  const overrideId = getYearFolderIdOverride();
  if (overrideId) {
    const folder = await getFolderById(
      drive,
      overrideId,
      "files.get(yearOverride)"
    );
    // Si l’override pointe vers un dossier nommé autrement, on l’utilise quand même
    // (cas : ID du dossier 2026 fourni explicitement).
    if (folder.name && folder.name !== year) {
      console.warn(
        `GOOGLE_DRIVE_YEAR_FOLDER_ID name=${folder.name} (attendu ${year}) — utilisation quand même`
      );
    }
    return folder;
  }

  const existing = await findYearFolder(drive, year);
  if (existing?.id) return existing;

  const parentId = getParentFolderId();
  const parentOk = await canAccessParentFolder(drive);
  if (!parentOk) {
    const err = new Error(
      `Dossier ${year} introuvable et parent Drive inaccessible. ` +
        `Sur un drive partagé où seuls les dossiers année sont visibles, ` +
        `crée le dossier ${year} (ou définis GOOGLE_DRIVE_YEAR_FOLDER_ID avec l’ID du dossier ${year}).`
    );
    err.statusCode = 404;
    throw err;
  }

  try {
    const { data } = await drive.files.create({
      requestBody: {
        name: year,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id, name",
      supportsAllDrives: true,
    });

    if (!data?.id) {
      throw new Error(
        `Impossible de créer le dossier ${year} sous le parent Drive ${parentId}`
      );
    }
    return data;
  } catch (err) {
    throw wrapDriveError(err, { op: "files.create(yearFolder)", parentId, year });
  }
}

export async function listDonFiles(drive, folderId, year) {
  if (!folderId) throw new Error("folderId manquant pour lister les reçus");

  const q = [
    `'${folderId}' in parents`,
    "trashed = false",
    `name contains 'DON${year}'`,
  ].join(" and ");

  const files = [];
  let pageToken;
  try {
    do {
      const { data } = await drive.files.list({
        q,
        fields: "nextPageToken, files(id, name)",
        spaces: "drive",
        corpora: "allDrives",
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      files.push(...(data.files || []));
      pageToken = data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    throw wrapDriveError(err, { op: "files.list(donFiles)", folderId, year });
  }

  return files;
}

export async function nextReceiptNumber(drive, year = currentYear()) {
  // Pas de files.get(parent) obligatoire : sur un partage, le parent peut être invisible
  // alors que le dossier YYYY est bien accessible.
  const folder = await ensureYearFolder(drive, year);
  if (!folder?.id) {
    throw new Error(`Dossier année ${year} introuvable ou sans id Drive`);
  }
  const files = await listDonFiles(drive, folder.id, year);
  let max = 0;
  for (const file of files) {
    const n = parseDonNumber(file.name, year);
    if (n != null && n > max) max = n;
  }
  const receiptNumber = formatDonNumber(year, max + 1);
  return {
    year,
    folderId: folder.id,
    folderName: folder.name || year,
    receiptNumber,
    nextSeq: max + 1,
  };
}

export async function uploadPdf(drive, { folderId, receiptNumber, pdfBuffer }) {
  if (!folderId) throw new Error("folderId manquant pour l’upload");
  const fileName = `${receiptNumber}.pdf`;
  const buffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  try {
    const { data } = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media: {
        mimeType: "application/pdf",
        body: Readable.from(buffer),
      },
      fields: "id, name, webViewLink",
      supportsAllDrives: true,
    });
    return data;
  } catch (err) {
    throw wrapDriveError(err, { op: "files.create(pdf)", folderId });
  }
}

export function assertAuthorized(req) {
  const expected = process.env.AUTH_PASSWORD_HASH;
  if (!expected) throw new Error("AUTH_PASSWORD_HASH manquant côté serveur");

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || token.toLowerCase() !== expected.toLowerCase()) {
    const err = new Error("Non autorisé");
    err.statusCode = 401;
    throw err;
  }
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Cerfa-Drive-Build", DRIVE_BUILD);
  res.end(JSON.stringify(body));
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function getQuery(req) {
  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `https://${host}`);
    return Object.fromEntries(url.searchParams.entries());
  } catch {
    return {};
  }
}
