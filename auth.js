(() => {
  const config = window.AUTH_CONFIG || {};
  const SESSION_KEY = config.sessionKey || "echo-cerfa-auth";
  const TTL = config.sessionTtlMs || 12 * 60 * 60 * 1000;
  const EXPECTED = String(config.passwordHash || "").toLowerCase();

  const gate = document.getElementById("auth-gate");
  const app = document.getElementById("app");
  const form = document.getElementById("auth-form");
  const passwordInput = document.getElementById("auth-password");
  const errorEl = document.getElementById("auth-error");
  const logoutBtn = document.getElementById("logout-btn");

  let appLoaded = false;

  function setError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg || "";
    errorEl.hidden = !msg;
  }

  async function sha256Hex(value) {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  function readSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data?.exp || Date.now() > data.exp) {
        sessionStorage.removeItem(SESSION_KEY);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  function writeSession() {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ exp: Date.now() + TTL, at: Date.now() })
    );
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-auth-src="${src}"]`);
      if (existing) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = false;
      script.dataset.authSrc = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Impossible de charger ${src}`));
      document.body.appendChild(script);
    });
  }

  async function unlockApp() {
    if (gate) gate.hidden = true;
    if (app) app.hidden = false;
    document.body.classList.add("is-authenticated");

    if (!appLoaded) {
      await loadScript("https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js");
      await loadScript("./template-base64.js");
      await loadScript("./app.js");
      appLoaded = true;
    }
  }

  function showGate() {
    if (app) app.hidden = true;
    if (gate) gate.hidden = false;
    document.body.classList.remove("is-authenticated");
    setError("");
    if (passwordInput) {
      passwordInput.value = "";
      passwordInput.focus();
    }
  }

  async function tryLogin(password) {
    if (!EXPECTED) {
      setError("Configuration d’accès manquante.");
      return false;
    }
    const hash = await sha256Hex(password);
    if (!timingSafeEqual(hash, EXPECTED)) {
      setError("Mot de passe incorrect.");
      return false;
    }
    writeSession();
    setError("");
    await unlockApp();
    return true;
  }

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    setError("");
    try {
      const ok = await tryLogin(passwordInput?.value || "");
      if (!ok && passwordInput) {
        passwordInput.select();
      }
    } catch (err) {
      console.error(err);
      setError("Erreur d’authentification.");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  logoutBtn?.addEventListener("click", () => {
    clearSession();
    // Soft reload keeps UX simple and clears in-memory app state
    window.location.reload();
  });

  // Boot
  if (readSession()) {
    unlockApp().catch((err) => {
      console.error(err);
      clearSession();
      showGate();
      setError("Session expirée. Reconnectez-vous.");
    });
  } else {
    showGate();
  }
})();
