'use strict';
/* POST /api/admin/toggle-payment  body: { required: true|false }
 *
 * Flips the global switch that every client reads from /api/payment-required.
 * Logged, because "payments were turned off for 3 hours" is exactly the kind of
 * thing an admin needs to be able to explain later.
 */

const { send, fail } = require('../_lib/fb');
const auth = require('../_lib/auth');
const store = require('../_lib/store');

module.exports = async function handler(req, res) {
  if (!auth.requireAdmin(req, res, fail)) return;
  if (!auth.requirePost(req, res, fail)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof body.required !== 'boolean') {
    return fail(res, 400, 'required must be true or false.');
  }

  try {
    await store.setPaymentRequired(body.required);
    await store.logAdmin('toggle-payment', 'config/payment',
      body.required ? 'paid (Stars)' : 'free');

    /* Confirm by reading back, so the UI never shows a state the DB rejected. */
    const actual = await store.getPaymentRequired();
    send(res, 200, { ok: true, required: actual });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return fail(res, 503, 'Firebase is not configured — the toggle cannot be saved.');
    }
    fail(res, 500, 'Could not save the toggle.');
  }
};
