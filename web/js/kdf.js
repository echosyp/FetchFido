// @ts-check
/**
 * Password key derivation, done here in the browser rather than on the server.
 *
 * The server never sees the password. It receives a 32-byte key derived from
 * it with PBKDF2-SHA256 at 600,000 rounds (the OWASP figure), salted with a
 * digest of the email so each account's key is distinct, and stores a salted
 * SHA-256 of that key. Anyone holding the database still has to pay the full
 * PBKDF2 cost per guess, so this protects passwords exactly as a server-side
 * hash would -- while the server does one cheap hash per login. That is what
 * lets the hosted version run inside a Cloudflare Worker's 10 ms CPU budget,
 * where the same derivation in WebAssembly measured 590 ms.
 *
 * WebCrypto does the work natively, well under a second on a phone. It is
 * only available in a secure context (https or localhost), which the rest of
 * the app needs anyway for Bluetooth and geolocation.
 *
 * The derivation is versioned by name. The server states which it expects in
 * /api/v1/me (`kdf`); a change means a new name and a new test vector, pinned
 * in web/test/kdf.test.mjs and internal/auth/auth_test.go.
 */

export const KDF = 'pbkdf2-sha256-v1';
export const ITERATIONS = 600000;
export const MIN_PASSWORD = 10;
const SALT_PREFIX = 'fetchfido-kdf-v1:';

/**
 * Email as the server stores it, so the salt matches however it was typed.
 * @param {string} email
 */
export function normaliseEmail(email) {
  return email.trim().toLowerCase();
}

/**
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{kdf: string, key: string}>} key is base64url, no padding
 */
export async function deriveKey(email, password) {
  if (password.length < MIN_PASSWORD) {
    throw new Error(`password must be at least ${MIN_PASSWORD} characters`);
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('password sign-in needs a secure context (https or localhost)');
  }
  const text = new TextEncoder();
  const salt = await subtle.digest('SHA-256', text.encode(SALT_PREFIX + normaliseEmail(email)));
  const material = await subtle.importKey('raw', text.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    material,
    256,
  );
  return { kdf: KDF, key: base64url(new Uint8Array(bits)) };
}

/** @param {Uint8Array} bytes */
function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
