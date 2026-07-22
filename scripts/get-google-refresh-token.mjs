/**
 * One-shot : obtient un refresh token Google Drive pour ton compte perso.
 *
 * Prérequis (une fois) :
 * 1. https://console.cloud.google.com → créer un projet
 * 2. APIs & Services → Enable "Google Drive API"
 * 3. OAuth consent screen → External (ou Internal si Workspace)
 *    - Ajoute ton email comme utilisateur test
 *    - Scope : https://www.googleapis.com/auth/drive.file
 *      (ou drive si tu préfères un accès large au Drive)
 * 4. Credentials → Create OAuth client ID → type "Desktop app"
 * 5. Télécharge le JSON, ou copie Client ID / Secret
 *
 * Puis :
 *   export GOOGLE_CLIENT_ID="….apps.googleusercontent.com"
 *   export GOOGLE_CLIENT_SECRET="…"
 *   npm run google:token
 *
 * Colle le refresh_token dans Vercel (GOOGLE_REFRESH_TOKEN).
 */

import http from "node:http";
import { URL } from "node:url";
import { google } from "googleapis";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;
const SCOPES = [
  // Accès aux fichiers créés par l’app + lecture pour numéroter dans le dossier partagé.
  // Si la numérotation échoue (dossier existant non visible), repasse avec "drive".
  "https://www.googleapis.com/auth/drive",
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Définis GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET avant de lancer ce script."
  );
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400);
      res.end("Code OAuth manquant");
      return;
    }
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<h1>OK — tu peux fermer cet onglet.</h1><p>Le refresh token est dans le terminal.</p>"
    );

    console.log("\n=== Colle ces valeurs dans Vercel / .env.local ===\n");
    console.log(`GOOGLE_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token || "(absent — réessaie avec prompt=consent)"}`);
    console.log(`GOOGLE_DRIVE_PARENT_FOLDER_ID=1uKyNWqsgBbzCEcpgHtw9ayNtCCt8eh`);
    console.log("\nAUTH_PASSWORD_HASH=<même hash que dans auth-config.js>\n");

    server.close();
    process.exit(0);
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end("Erreur OAuth");
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Ouvre cette URL dans ton navigateur et connecte-toi avec ton compte Google :\n");
  console.log(authUrl);
  console.log(`\nEn attente du callback sur ${REDIRECT_URI} …`);
});
