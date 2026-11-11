'use strict';
/* GET /api/admin/live
 *
 * Polled every 5 s by the dashboard. Returns both live tables plus a small
 * map of reportCount per id, so the waiting table can show "Reports" without a
 * second query per row.
 */

const { send, fail } = require('../_lib/fb');
const auth = require('../_lib/auth');
const store = require('../_lib/store');

module.exports = async function handler(req, res) {
  if (!auth.requireAdmin(req, res, fail)) return;

  try {
    const handle = store.fs();

    /* Pruning first keeps the "online now" number honest even without TTL. */
    await store.pruneHeartbeats();
    const live = await store.listLiveHeartbeats();

    const nowMs = Date.now();
    const waiting = live
      .filter(function (h) { return h.status === 'waiting'; })
      .map(function (h) {
        return {
          id: h.id,
          name: h.name,
          gender: h.gender,
          filter: h.filter,
          waitingSec: h.since ? Math.max(0, Math.round((nowMs - h.since) / 1000)) : 0,
          reportCount: 0
        };
      })
      .sort(function (a, b) { return b.waitingSec - a.waitingSec; });

    /* --- active calls, with names resolved in one pass ------------------- */
    let callsSnap;
    try {
      callsSnap = await handle.collection('activeCalls').limit(200).get();
    } catch (e) { callsSnap = { docs: [] }; }

    const calls = callsSnap.docs.map(function (doc) {
      const d = doc.data() || {};
      const startMs = Number(d.startedAtMs) || (d.startedAt && d.startedAt.toMillis ? d.startedAt.toMillis() : 0);
      return {
        callId: doc.id,
        userA: d.userA || '',
        userB: d.userB || '',
        startedAtMs: startMs,
        durationSec: startMs ? Math.max(0, Math.round((nowMs - startMs) / 1000)) : 0
      };
    }).sort(function (a, b) { return b.durationSec - a.durationSec; });

    /* --- names + report counts for everyone referenced above ------------- */
    const ids = new Set();
    waiting.forEach(function (w) { ids.add(w.id); });
    calls.forEach(function (c) { if (c.userA) ids.add(c.userA); if (c.userB) ids.add(c.userB); });

    const names = {};
    const counts = {};
    const idList = Array.from(ids).slice(0, 120);

    /* Firestore `in` is capped at 10 values, so chunk it. */
    for (let i = 0; i < idList.length; i += 10) {
      const chunk = idList.slice(i, i + 10);
      try {
        const snap = await handle.collection('users')
          .where('__name__', 'in', chunk.map(function (id) { return handle.collection('users').doc(id); }))
          .get();
        snap.docs.forEach(function (doc) {
          const d = doc.data() || {};
          names[doc.id] = d.name || '';
          counts[doc.id] = Number(d.reportCount) || 0;
        });
      } catch (e) { /* names are cosmetic; never fail the live view for them */ }
    }

    waiting.forEach(function (w) { w.reportCount = counts[w.id] || 0; });
    calls.forEach(function (c) {
      c.nameA = names[c.userA] || '';
      c.nameB = names[c.userB] || '';
    });

    send(res, 200, {
      ok: true,
      onlineNow: live.length,
      waiting: waiting,
      calls: calls,
      serverTime: nowMs
    });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return send(res, 200, {
        ok: false, backend: 'offline',
        onlineNow: 0, waiting: [], calls: [], serverTime: Date.now(),
        error: 'Firebase is not configured.'
      });
    }
    fail(res, 500, 'Could not load live data.');
  }
};
