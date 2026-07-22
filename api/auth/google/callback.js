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

function redirectDone(res, origin, ok, error) {
  const q = new URLSearchParams();
  q.set("ok", ok ? "1" : "0");
  if (error) q.set("error", String(error).slice(0, 300));
  res.statusCode = 302;
  res.setHeader("Location", `${origin}/oauth-done.html?${q.toString()}`);
  res.end();
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Méthode non autorisée" });
    return;
  }

  const origin = publicOrigin(req);

  try {
    const query = getQuery(req);
    if (query.error) {
      redirectDone(
        res,
        origin,
        false,
        query.error_description || query.error
      );
      return;
    }

    const code = query.code;
    const state = query.state;
    const cookies = parseCookies(req);
    if (!code || !state || !cookies[STATE_COOKIE] || cookies[STATE_COOKIE] !== state) {
      redirectDone(
        res,
        origin,
        false,
        "État OAuth invalide — fermez la fenêtre et réessayez."
      );
      return;
    }

    const client = createOAuthClient(req);
    const { tokens } = await client.getToken(code);

    if (!tokens.access_token && !tokens.refresh_token) {
      redirectDone(res, origin, false, "Google n’a renvoyé aucun jeton d’accès.");
      return;
    }

    if (!tokens.refresh_token) {
      redirectDone(
        res,
        origin,
        false,
        "Pas de refresh token. Sur https://myaccount.google.com/permissions retirez l’accès à l’app, puis reconnectez-vous."
      );
      return;
    }

    client.setCredentials(tokens);

    // L’e-mail est optionnel : ne doit jamais faire échouer la connexion Drive
    let email = "";
    try {
      if (tokens.access_token) {
        const oauth2 = google.oauth2({ version: "v2", auth: client });
        const me = await oauth2.userinfo.get();
        email = me.data?.email || "";
      }
    } catch (emailErr) {
      console.warn("userinfo skipped:", emailErr?.message || emailErr);
    }

    clearCookie(res, STATE_COOKIE);
    setCookie(res, RT_COOKIE, seal(tokens.refresh_token), {
      maxAge: 60 * 60 * 24 * 180,
    });
    if (email) {
      setCookie(res, EMAIL_COOKIE, email, {
        maxAge: 60 * 60 * 24 * 180,
        httpOnly: false,
      });
    }

    redirectDone(res, origin, true);
  } catch (err) {
    console.error(err);
    const msg =
      err?.response?.data?.error_description ||
      err?.response?.data?.error ||
      err.message ||
      "oauth_failed";
    redirectDone(res, origin, false, msg);
  }
}
