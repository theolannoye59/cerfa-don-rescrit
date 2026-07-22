import { Readable } from "node:stream";
import { google } from "googleapis";

/** Dossier Drive connu (Echo Symphonic) — fallback si l’env Vercel est vide / invalide (ex. "."). */
const DEFAULT_PARENT_FOLDER_ID = "1uKyNWqsgBbzCEcpgHtw9ayNtCCt8eh";

/** Stamp renvoyé dans les erreurs pour vérifier quel build tourne en prod. */
export const DRIVE_BUILD = "2026-07-22-parent-hardfallback";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d’environnement manquante : ${name}`);
  return value;
}

function looksLikeDriveId(id) {
  return /^[a-zA-Z0-9_-]{20,}$/.test(id);
}

/**
 * ID dossier parent Drive.
 * - Si GOOGLE_DRIVE_PARENT_FOLDER_ID est un ID Drive valide → on l’utilise
 * - Sinon (absent, vide, ".", espaces, etc.) → fallback hardcodé
 *   (évite l’erreur Google « File not found: . » quand l’env vaut « . » ou est vide côté bundle)
 */
export function getParentFolderId() {
  const raw = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
  const trimmed = raw == null ? "" : String(raw).trim();
  if (looksLikeDriveId(trimmed)) return trimmed;
  return DEFAULT_PARENT_FOLDER_ID;
}

export function getOAuthClient() {
  const client = new google.auth.OAuth2(
    requiredEnv("GOOGLE_CLIENT_ID"),
    requiredEnv("GOOGLE_CLIENT_SECRET")
  );
  client.setCredentials({ refresh_token: requiredEnv("GOOGLE_REFRESH_TOKEN") });
  return client;
}

export function getDrive() {
  return google.drive({ version: "v3", auth: getOAuthClient() });
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

/** Enrichit les erreurs Google avec l’opération + l’ID utilisé (sans secrets). */
export function wrapDriveError(err, context = {}) {
  const base = err?.message || String(err);
  const bits = [base];
  if (context.op) bits.push(`op=${context.op}`);
  if (context.parentId) bits.push(`parent=${context.parentId}`);
  if (context.folderId) bits.push(`folder=${context.folderId}`);
  bits.push(`build=${DRIVE_BUILD}`);
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

export async function assertParentFolderAccessible(drive) {
  const parentId = getParentFolderId();
  try {
    const { data } = await drive.files.get({
      fileId: parentId,
      fields: "id, name, mimeType",
      supportsAllDrives: true,
    });
    if (!data?.id) {
      throw new Error(`Dossier parent Drive sans id (parent=${parentId})`);
    }
    if (data.mimeType && data.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error(
        `GOOGLE_DRIVE_PARENT_FOLDER_ID ne pointe pas vers un dossier (mime=${data.mimeType}, parent=${parentId})`
      );
    }
    return data;
  } catch (err) {
    throw wrapDriveError(err, { op: "files.get(parent)", parentId });
  }
}

export async function findYearFolder(drive, year) {
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
    throw wrapDriveError(err, { op: "files.list(yearFolder)", parentId });
  }
}

export async function ensureYearFolder(drive, year) {
  const existing = await findYearFolder(drive, year);
  if (existing?.id) return existing;

  const parentId = getParentFolderId();
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
    throw wrapDriveError(err, { op: "files.create(yearFolder)", parentId });
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
    throw wrapDriveError(err, { op: "files.list(donFiles)", folderId });
  }

  return files;
}

export async function nextReceiptNumber(drive, year = currentYear()) {
  await assertParentFolderAccessible(drive);
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
  return { year, folderId: folder.id, receiptNumber, nextSeq: max + 1 };
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
