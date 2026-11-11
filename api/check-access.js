'use strict';
/* GET /api/check-access?telegram_id=...
 *
 * Called once on app load. Three possible answers:
 *   banned   -> blocking screen, everything disabled
 *   unlocked -> Gender filter available even when payment is required
 *   paid     -> same as unlocked, bought with Stars
 *
 * This is advisory only: the client decides whether to show the filter. The
 * real enforcement would have to happen where the match is made — but matching
 * happens peer-to-peer over MQTT, so a determined user can always edit their
 * own card. Documented as a known limitation rather than pretended away.
 */

const { send, fail, asText } = require('./_lib/fb');
const store = require('./_lib/store');
const { tooMany, clientKey } = require('./_lib/ratelimit');

module.exports = async function handler(req, res) {
  /* Read-only: a POST here is a mistake or a probe, not a feature. */
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    return fail(res, 405, 'GET only.');
  }

  if (tooMany('access:' + clientKey(req), 90, 60000)) {
    return fail(res, 429, 'Too many requests — please try again in a moment.');
  }

  const id = asText((req.query && req.query.telegram_id) || '', 64).trim();
  if (!id) return fail(res, 400, 'telegram_id is required.');

  const required = await store.getPaymentRequired();

  try {
    const user = await store.getUser(id);
    if (!user) {
      return send(res, 200, {
        ok: true, banned: false, unlocked: false, paid: false,
        paymentRequired: required, known: false, reportCount: 0
      });
    }
    return send(res, 200, {
      ok: true,
      banned: !!user.banned,
      unlocked: !!user.unlocked,
      paid: !!user.paid,
      paymentRequired: required,
      known: true,
      reportCount: Number(user.reportCount) || 0,
      name: user.name || ''
    });
  } catch (e) {
    /* Fail open on ban checks: a Firestore outage should not lock everybody
     * out of a chat app. Fail closed on payment instead (see the catch below). */
    return send(res, 200, {
      ok: true, banned: false, unlocked: false, paid: false,
      paymentRequired: true, known: false, reportCount: 0, backend: 'offline'
    });
  }
};
