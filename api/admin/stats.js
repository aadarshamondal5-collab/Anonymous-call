'use strict';
/* GET /api/admin/stats
 *
 * One round-trip for the whole header strip: total users, online, waiting,
 * in call, calls today, Stars revenue today, reports today.
 *
 * "Today" is UTC. Documented so nobody wonders why it rolls over at an odd hour.
 */

const { send, fail } = require('../_lib/fb');
const auth = require('../_lib/auth');
const store = require('../_lib/store');

async function countCollection(handle, name, limit) {
  try {
    const snap = await handle.collection(name).limit(limit || 5000).get();
    return { size: snap.size, docs: snap.docs };
  } catch (e) {
    return { size: 0, docs: [] };
  }
}

module.exports = async function handler(req, res) {
  if (!auth.requireAdmin(req, res, fail)) return;

  try {
    const handle = store.fs();

    /* Expired rows are excluded by the query itself, so the numbers are right
     * even if the TTL policy is off. The prune keeps storage tidy. */
    await store.pruneHeartbeats();
    const live = await store.listLiveHeartbeats();

    const users = await countCollection(handle, 'users', 5000);
    const calls = await countCollection(handle, 'activeCalls', 500);

    const waiting = live.filter(function (h) { return h.status === 'waiting'; }).length;
    const calling = live.filter(function (h) { return h.status === 'calling'; }).length;
    const inCall = Math.max(calling, calls.size * 2);

    const agg = await store.getTodayAggregates();

    /* Revenue today: sum of paidStars on users whose paidAt is today. Small app,
     * so a scan is fine; a real product would keep a daily rollup document. */
    let revenue = 0;
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayStartMs = dayStart.getTime();
    users.docs.forEach(function (doc) {
      const d = doc.data() || {};
      if (d.paid && Number(d.paidAt) >= dayStartMs) revenue += Number(d.paidStars) || 0;
    });

    const required = await store.getPaymentRequired();

    send(res, 200, {
      ok: true,
      totalUsers: users.size,
      onlineNow: live.length,
      waiting: waiting,
      inCall: inCall,
      callsToday: agg.callsToday,
      revenueToday: revenue,
      reportsToday: agg.reportsToday,
      paymentRequired: required,
      serverTime: Date.now(),
      backend: 'live'
    });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return send(res, 200, {
        ok: false, backend: 'offline',
        totalUsers: 0, onlineNow: 0, waiting: 0, inCall: 0,
        callsToday: 0, revenueToday: 0, reportsToday: 0,
        paymentRequired: true, serverTime: Date.now(),
        error: 'Firebase is not configured (FIREBASE_SERVICE_ACCOUNT).'
      });
    }
    fail(res, 500, 'Could not load stats.');
  }
};
