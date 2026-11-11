'use strict';
/* POST /api/admin/user-action
 * body: { telegram_id, action, note }
 * action: ban | unban | unlock | lock | grant-paid | revoke-paid | dismiss-reports
 *
 * On ban we also:
 *   - delete the user's heartbeat document (they vanish from "waiting")
 *   - delete any active call they are in (so the live table is not stale)
 *
 * The banned client is told on its very next heartbeat (<= 3 s): /api/heartbeat
 * answers `banned: true`, the client hangs up and shows the blocking screen.
 * That client's own `endCall()` publishes the MQTT `bye` to the partner, so the
 * other side drops the call immediately — no server-side MQTT client needed.
 */

const { send, fail, asText } = require('../_lib/fb');
const auth = require('../_lib/auth');
const store = require('../_lib/store');

const ACTIONS = {
  ban: 1, unban: 1, unlock: 1, lock: 1,
  'grant-paid': 1, 'revoke-paid': 1, 'dismiss-reports': 1
};

async function clearActiveCalls(handle, telegramId) {
  try {
    const snap = await handle.collection('activeCalls')
      .where('userA', '==', telegramId).limit(20).get();
    const other = await handle.collection('activeCalls')
      .where('userB', '==', telegramId).limit(20).get();
    const batch = handle.batch();
    let n = 0;
    snap.docs.concat(other.docs).forEach(function (doc) { batch.delete(doc.ref); n += 1; });
    if (n) await batch.commit();
    return n;
  } catch (e) {
    return 0;
  }
}

module.exports = async function handler(req, res) {
  if (!auth.requireAdmin(req, res, fail)) return;
  if (!auth.requirePost(req, res, fail)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = asText(body.telegram_id, 64).trim();
  const action = asText(body.action, 24).trim();
  const note = asText(body.note, 200);

  if (!id) return fail(res, 400, 'telegram_id is required.');
  if (!ACTIONS[action]) return fail(res, 400, 'Unknown action.');

  try {
    const handle = store.fs();

    if (action === 'dismiss-reports') {
      await store.clearReports(id);
      await store.logAdmin('dismiss-reports', id, note || 'cleared all reports');
      return send(res, 200, { ok: true, action: action, reportCount: 0 });
    }

    const patch = await store.applyUserAction(id, action);

    let cleared = 0;
    if (action === 'ban') {
      await store.dropHeartbeat(id);
      cleared = await clearActiveCalls(handle, id);
    }

    await store.logAdmin(action, id,
      (note ? note + ' — ' : '') + (cleared ? 'cleared ' + cleared + ' active call(s)' : 'ok'));

    send(res, 200, {
      ok: true,
      action: action,
      banned: !!patch.banned,
      unlocked: !!patch.unlocked,
      paid: !!patch.paid
    });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return fail(res, 503, 'Firebase is not configured.');
    }
    fail(res, 500, 'Could not apply the action.');
  }
};
