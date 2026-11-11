'use strict';
/* POST /api/admin/login  body: { id, password }
 *
 * The password is checked HERE, server-side, against Vercel env vars only.
 * There is no hardcoded fallback anywhere in this project — if ADMIN_ID or
 * ADMIN_PASSWORD is not set, this route answers 503 and admin login is simply
 * disabled. Closed is the safe failure mode for an auth endpoint.
 *
 * Rate limited per IP and (softly) per submitted id, so online guessing is
 * pointless even if someone learns the id.
 */

const { send, fail, asText } = require('../_lib/fb');
const auth = require('../_lib/auth');
const store = require('../_lib/store');
const { tooMany, clientKey } = require('../_lib/ratelimit');

module.exports = async function handler(req, res) {
  if (!auth.requirePost(req, res, fail)) return;

  /* A missing env var is a setup problem, not a wrong password. Say which one
   * is missing so a fresh deploy is debuggable from the login screen. */
  const problem = auth.setupProblem();
  if (problem) return fail(res, 503, problem);

  const expected = auth.adminCredentials();
  if (!expected) return fail(res, 503, 'Admin login is disabled: environment variables are missing.');

  /* 8 attempts per 10 minutes per IP. Generous enough for a typo, tight enough
   * to make online guessing pointless. */
  if (tooMany('login:' + clientKey(req), 8, 600000)) {
    return fail(res, 429, 'Too many login attempts. Try again in 10 minutes.');
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = asText(body.id, 64).trim();
  const password = String(body.password === undefined ? '' : body.password);

  /* A second, looser bucket keyed on the submitted id: catches an attacker who
   * rotates IPs but keeps hammering the same account name. */
  if (id && tooMany('login-id:' + id.toLowerCase(), 20, 600000)) {
    return fail(res, 429, 'Too many attempts for this ID. Wait 10 minutes.');
  }

  /* Both compares always run, so a wrong id and a wrong password take the same
   * time — the response must not reveal which half was wrong. */
  const okId = auth.sameString(id, expected.id);
  const okPass = auth.sameString(password, expected.password);

  if (!okId || !okPass) {
    /* Log the failure without the attempted password. */
    try {
      await store.logAdmin('login-failed', clientKey(req),
        'admin id: ' + id.slice(0, 32));
    } catch (e) { /* ignore */ }
    return fail(res, 401, 'Wrong admin ID or password.');
  }

  const token = auth.issueToken();
  if (!token) {
    return fail(res, 500,
      'Could not create a token — set ADMIN_PASSWORD (min ' + auth.MIN_PASSWORD_LEN +
      ' chars) and/or ADMIN_TOKEN_SECRET.');
  }

  try { await store.logAdmin('login', expected.id, 'source: env'); } catch (e) { /* ignore */ }

  send(res, 200, {
    ok: true,
    token: token,
    expiresInMs: auth.TOKEN_TTL_MS,
    mode: 'env'
  });
};
