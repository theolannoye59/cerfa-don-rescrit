import {
  clearCookie,
  RT_COOKIE,
  EMAIL_COOKIE,
  STATE_COOKIE,
} from "../../../lib/google-auth.js";
import { sendJson } from "../../../lib/drive.js";

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    sendJson(res, 405, { error: "Méthode non autorisée" });
    return;
  }

  clearCookie(res, RT_COOKIE);
  clearCookie(res, EMAIL_COOKIE);
  clearCookie(res, STATE_COOKIE);
  sendJson(res, 200, { ok: true, connected: false });
}
