'use strict';
/* GET /api/admin/user/[telegram_id]
 *
 * Vercel maps the bracketed folder to a dynamic segment and passes it as
 * req.query.telegram_id. All the work lives in lib/user-detail.js so this file
 * stays a thin adapter.
 */

const { send, fail } = require('../../_lib/fb');
const auth = require('../../_lib/auth');
const store = require('../../_lib/store');
const { loadUser } = require('../../_lib/user-detail');

module.exports = async function handler(req, res) {
  if (!auth.requireAdmin(req, res, fail)) return;

  const id = String((req.query && req.query.telegram_id) || '').trim();
  if (!id) return fail(res, 400, 'telegram_id is required.');

  try {
    const payload = await loadUser(store.fs(), id);
    send(res, 200, payload);
  } catch (e) {
    if (e.code === 'not_found') return fail(res, 404, 'User not found.');
    if (e.code === 'firebase_not_configured') {
      return send(res, 200, { ok: false, backend: 'offline', user: null, reports: [], calls: [] });
    }
    fail(res, 500, 'Could not load user details.');
  }
};
