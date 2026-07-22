import {
  getUserEmail,
  getUserRefreshToken,
} from "../../../lib/google-auth.js";
import { sendJson } from "../../../lib/drive.js";

void process.env.GOOGLE_CLIENT_ID;
void process.env.GOOGLE_CLIENT_SECRET;
void process.env.GOOGLE_REFRESH_TOKEN;
void process.env.SESSION_SECRET;
void process.env.AUTH_PASSWORD_HASH;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Méthode non autorisée" });
    return;
  }

  const userRt = Boolean(getUserRefreshToken(req));
  const envFallback = Boolean(process.env.GOOGLE_REFRESH_TOKEN);
  const email = getUserEmail(req);

  sendJson(res, 200, {
    connected: userRt || envFallback,
    source: userRt ? "user" : envFallback ? "env" : null,
    email: userRt ? email : envFallback ? "(compte serveur)" : null,
  });
}
