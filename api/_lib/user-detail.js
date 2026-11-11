'use strict';
/* GET /api/admin/user/:telegram_id
 *
 * Everything about one user, for the detail sheet: profile, the full report
 * list (newest first) and their last calls from callHistory.
 *
 * NOTE: Vercel needs the dynamic segment spelled `[telegram_id].js`. The sibling
 * file `api/admin/user/[telegram_id].js` is the real route; this module only
 * holds the logic so the two never drift apart.
 */

const store = require('./store');

async function loadUser(handle, id) {
  const user = await store.getUser(id);
  if (!user) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }

  const reports = Array.isArray(user.reports) ? user.reports.slice() : [];
  reports.sort(function (a, b) { return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0); });

  /* Their calls, from either side of the pair. Two indexed queries, merged. */
  let calls = [];
  try {
    const [asA, asB] = await Promise.all([
      handle.collection('callHistory').where('userA', '==', id).limit(50).get(),
      handle.collection('callHistory').where('userB', '==', id).limit(50).get()
    ]);
    const seen = {};
    asA.docs.concat(asB.docs).forEach(function (doc) {
      if (seen[doc.id]) return;
      seen[doc.id] = true;
      const d = doc.data() || {};
      const startMs = Number(d.createdAtMs) || (d.startTime && d.startTime.toMillis ? d.startTime.toMillis() : 0);
      calls.push({
        callId: d.call_id || doc.id,
        partner: String(d.userA) === String(id) ? d.userB : d.userA,
        duration: Number(d.duration) || 0,
        startMs: startMs
      });
    });
    calls.sort(function (a, b) { return b.startMs - a.startMs; });
    calls = calls.slice(0, 30);
  } catch (e) { calls = []; }

  const partnerIds = Array.from(new Set(calls.map(function (c) { return c.partner; }).filter(Boolean))).slice(0, 10);
  const names = {};
  if (partnerIds.length) {
    try {
      const snap = await handle.collection('users')
        .where('__name__', 'in', partnerIds.map(function (p) { return handle.collection('users').doc(p); }))
        .get();
      snap.docs.forEach(function (doc) { names[doc.id] = (doc.data() || {}).name || ''; });
    } catch (e) { /* names are cosmetic */ }
  }
  calls.forEach(function (c) { c.partnerName = names[c.partner] || ''; });

  return {
    ok: true,
    user: {
      id: user.id,
      name: user.name || '',
      paid: !!user.paid,
      unlocked: !!user.unlocked,
      banned: !!user.banned,
      totalCalls: Number(user.totalCalls) || 0,
      totalMinutes: Math.round((Number(user.totalMinutes) || 0) * 10) / 10,
      reportCount: Number(user.reportCount) || reports.length || 0,
      firstSeen: Number(user.firstSeen) || 0,
      lastSeen: Number(user.lastSeen) || 0,
      paidAt: Number(user.paidAt) || 0,
      paidStars: Number(user.paidStars) || 0
    },
    reports: reports.slice(0, 60),
    calls: calls
  };
}

module.exports = { loadUser };
