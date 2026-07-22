import {
  createOAuthClient,
  GOOGLE_SCOPES,
  randomState,
  setCookie,
  STATE_COOKIE,
} from "../../../lib/google-auth.js";
import { sendJson } from "../../../lib/drive.js";

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
    const state = randomState();
    setCookie(res, STATE_COOKIE, state, { maxAge: 600, httpOnly: true });

    const client = createOAuthClient(req);
    const url = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent select_account",
      scope: GOOGLE_SCOPES,
      include_granted_scopes: true,
      state,
    });

    res.statusCode = 302;
    res.setHeader("Location", url);
    res.end();
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message || "Impossible de démarrer OAuth Google" });
  }
}
