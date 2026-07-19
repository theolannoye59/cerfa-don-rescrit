/* Auth config — change PASSWORD_HASH to rotate the access password.
 *
 * Generate a new hash in the browser console or Node:
 *   printf '%s' 'VotreMotDePasse' | shasum -a 256
 *   (or) crypto.subtle.digest('SHA-256', new TextEncoder().encode('VotreMotDePasse'))
 */
window.AUTH_CONFIG = {
  passwordHash:
    "5c092c93abd06352a8b33c4b70d6c21e56a61f7266b5ab99ba3b5513ae703811",
  sessionKey: "echo-cerfa-auth-v1",
  /** Session duration after successful login (12 hours). */
  sessionTtlMs: 12 * 60 * 60 * 1000,
};
