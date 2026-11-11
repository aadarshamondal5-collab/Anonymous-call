'use strict';
/* GET /api/payment-required
 *
 * Public. The mini app needs to know whether Gender Matching is behind the
 * Stars paywall before it renders the filter chips. Returns the "safe" answer
 * (required = true) when Firebase is unreachable, so a broken backend can never
 * silently unlock a paid feature.
 */

const { send, fail } = require('./_lib/fb');
const store = require('./_lib/store');

module.exports = async function handler(req, res) {
  try {
    if (String(req.method || 'GET').toUpperCase() !== 'GET') {
      return fail(res, 405, 'GET only.');
    }
    const required = await store.getPaymentRequired();
    send(res, 200, {
      ok: true,
      required: required,
      price: 50,                 // Stars, informational only
      backend: store.isConfigured() ? 'live' : 'offline'
    });
  } catch (e) {
    // Never 500 here: the page must still boot.
    send(res, 200, { ok: true, required: true, price: 50, backend: 'offline' });
  }
};
