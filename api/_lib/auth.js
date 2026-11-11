'use strict';
/* ---------------------------------------------------------------------------
 * Admin credentials + session tokens.
 *
 * NOTHING IS HARDCODED HERE.
 *
 * The admin ID and password come ONLY from Vercel environment variables:
 *
 *   ADMIN_ID        e.g. "lc_ops_7f3a"   (never the guessable "admin")
 *   ADMIN_PASSWORD  long random string   (min 12 chars, enforced below)
 *   ADMIN_TOKEN_SECRET  optional; if absent it is derived from ADMIN_PASSWORD
 *
 * If either ADMIN_ID or ADMIN_PASSWORD is missing, admin login is DISABLED.
 * That is intentional: the safe failure mode for an auth endpoint is "closed",
 * never "open with a guessable default". /api/admin/login returns 503 and says
 * which variable is missing, so a misconfigured deploy is obvious instead of
 * silently insecure.
 *
 * There is no fallback password anywhere in this repo, so leaking the built
 * JavaScript (which is unavoidable on a static host) leaks nothing.
 *
 * A successful login returns a signed token (HMAC-SHA256 over the expiry
 * timestamp) that every admin route verifies. No database round-trip, no
 * cookie juggling, works fine on serverless.
 * ------------------------------------------------------------------------- */

const crypto = require('crypto');

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;    // 8 hours
const MIN_PASSWORD_LEN = 12;

/** Reads the credentials from the environment. Returns null when unset. */
function adminCredentials() {
  const id = (process.env.ADMIN_ID || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!id || !password) return null;
  return { id: id, password: password };
}

/** Human-readable reason the panel cannot log in, or '' when it is configured. */
function setupProblem() {
  const missing = [];
  if (!(process.env.ADMIN_ID || '').trim()) missing.push('ADMIN_ID');
  if (!(process.env.ADMIN_PASSWORD || '')) missing.push('ADMIN_PASSWORD');
  if (missing.length) {
    return 'Admin login is disabled: set ' + missing.join(' and ') +
      ' in the Vercel environment variables.';
  }
  if ((process.env.ADMIN_PASSWORD || '').length < MIN_PASSWORD_LEN) {
    return 'ADMIN_PASSWORD must be at least ' + MIN_PASSWORD_LEN + ' characters long.';
  }
  return '';
}

function secret() {
  /* ADMIN_TOKEN_SECRET is the right var. If the operator only set
   * ADMIN_PASSWORD we derive a secret from it so tokens still work — rotating
   * the password then also invalidates every existing session, which is fine. */
  const dedicated = process.env.ADMIN_TOKEN_SECRET;
  if (dedicated && dedicated.length >= 8) return dedicated;
  const pw = process.env.ADMIN_PASSWORD;
  if (pw && pw.length >= MIN_PASSWORD_LEN) return 'linkcall::' + pw;
  return null;
}

function sign(payload) {
  const key = secret();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

/** Constant-time compare so a wrong password cannot be brute-forced by timing. */
function sameString(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    /* Still do a compare of equal-length buffers so the timing does not leak
     * the length of the expected value. */
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function issueToken() {
  const exp = Date.now() + TOKEN_TTL_MS;
  const sig = sign(String(exp));
  if (!sig) return null;
  return exp + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(String(exp));
  if (!expected) return false;
  return sameString(parts[1], expected);
}

/** Pulls the bearer token from the Authorization header or an x-admin-token. */
function tokenFrom(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (header && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  const alt = req.headers && (req.headers['x-admin-token'] || req.headers['X-Admin-Token']);
  return alt ? String(alt).trim() : '';
}

/** Guard for admin routes. Returns true when the request may proceed. */
function requireAdmin(req, res, fail) {
  if (verifyToken(tokenFrom(req))) return true;
  fail(res, 401, 'Admin token is invalid or expired. Please log in again.');
  return false;
}

/** Only allow POST — every mutating route is POST-only. */
function requirePost(req, res, fail) {
  if (String(req.method || 'GET').toUpperCase() === 'POST') return true;
  fail(res, 405, 'POST only.');
  return false;
}

module.exports = {
  TOKEN_TTL_MS, MIN_PASSWORD_LEN,
  adminCredentials, setupProblem,
  issueToken, verifyToken, tokenFrom, requireAdmin, requirePost, sameString
};
