import { google } from "googleapis";
import {
  createOAuthClient,
  parseCookies,
  setCookie,
  clearCookie,
  seal,
  RT_COOKIE,
  EMAIL_COOKIE,
  STATE_COOKIE,
  publicOrigin,
} from "../../../lib/google-auth.js";
import { sendJson, getQuery } from "../../../lib/drive.js";

void process.env.GOOGLE_CLIENT_ID;
void process.env.GOOGLE_CLIENT_SECRET;
void process.env.SESSION_SECRET;
void process.env.AUTH_PASSWORD_HASH;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Méthode non autorisée" });
    return;
  }

  try {
    const query = getQuery(req);
    if (query.error) {
      res.statusCode = 302;
      res.setHeader(
        "Location",
        `${publicOrigin(req)}/?google=error&reason=${encodeURIComponent(query.error)}`
      );
      res.end();
      return;
    }

    const code = query.code;
    const state = query.state;
    const cookies = parseCookies(req);
    if (!code || !state || !cookies[STATE_COOKIE] || cookies[STATE_COOKIE] !== state) {
      sendJson(res, 400, { error: "État OAuth invalide — réessayez la connexion Google." });
      return;
    }

    const client = createOAuthClient(req);
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      // Souvent si l’utilisateur avait déjà autorisé sans prompt=consent
      sendJson(res, 400, {
        error:
          "Google n’a pas renvoyé de refresh token. Révoquez l’accès de l’app dans votre compte Google puis reconnectez-vous.",
      });
      return;
    }

    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const me = await oauth2.userinfo.get();
    const email = me.data.email || "";

    clearCookie(res, STATE_COOKIE);
    setCookie(res, RT_COOKIE, seal(tokens.refresh_token), { maxAge: 60 * 60 * 24 * 180 });
    if (email) {
      setCookie(res, EMAIL_COOKIE, email, { maxAge: 60 * 60 * 24 * 180, httpOnly: false });
    }

    res.statusCode = 302;
    res.setHeader("Location", `${publicOrigin(req)}/?google=connected`);
    res.end();
  } catch (err) {
    console.error(err);
    res.statusCode = 302;
    res.setHeader(
      "Location",
      `${publicOrigin(req)}/?google=error&reason=${encodeURIComponent(err.message || "oauth_failed")}`
    );
    res.end();
  }
}
