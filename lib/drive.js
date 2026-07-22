import { Readable } from "node:stream";
import { google } from "googleapis";

const DEFAULT_PARENT_FOLDER_ID = "1uKyNWqsgBbzCEcpgHtw9ayNtCCt8eh";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d’environnement manquante : ${name}`);
  return value;
}

/** ID dossier parent Drive — lu à chaque requête (évite un env vide figé au bundling). */
export function getParentFolderId() {
  const raw = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
  const id = String(raw && raw.trim() ? raw : DEFAULT_PARENT_FOLDER_ID).trim();
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(id)) {
    throw new Error(
      `GOOGLE_DRIVE_PARENT_FOLDER_ID invalide (${JSON.stringify(id)}). Attendu un ID Drive du type 1uKyNWqsgBbzCEcpgHtw9ayNtCCt8eh`
    );
  }
  return id;
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

export async function findYearFolder(drive, year) {
  const parentId = getParentFolderId();
  const q = [
    `'${parentId}' in parents`,
    "trashed = false",
    "mimeType = 'application/vnd.google-apps.folder'",
    `name = '${year}'`,
  ].join(" and ");

  const { data } = await drive.files.list({
    q,
    fields: "files(id, name)",
    spaces: "drive",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return data.files?.[0] || null;
}

export async function ensureYearFolder(drive, year) {
  const existing = await findYearFolder(drive, year);
  if (existing?.id) return existing;

  const parentId = getParentFolderId();
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
  do {
    const { data } = await drive.files.list({
      q,
      fields: "nextPageToken, files(id, name)",
      spaces: "drive",
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return files;
}

export async function nextReceiptNumber(drive, year = currentYear()) {
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
