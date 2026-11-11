'use strict';
/* GET /api/admin/calls?before=<ms>&limit=50
 *
 * Paged call history, newest first. Cursor is the `createdAtMs` of the oldest
 * row currently shown, so "Older ›" is a plain `startAfter`-style filter
 * without needing a composite index on (createdAtMs).
 */

const { send, fail } = require('../_lib/fb');
const auth = require('../_lib/auth');
const store = require('../_lib/store');

module.exports = async function handler(req, res) {
  if (!auth.requireAdmin(req, res, fail)) return;

  const before = Number((req.query && req.query.before) || 0);
  const limit = Math.min(100, Math.max(1, Number((req.query && req.query.limit) || 50)));

  try {
    const handle = store.fs();

    /* Over-fetch a little, then trim after the cursor filter, so a page is
     * almost never short just because some rows had no createdAtMs. */
    let snap;
    try {
      snap = await handle.collection('callHistory')
        .orderBy('createdAtMs', 'desc')
        .limit(limit + 20)
        .get();
    } catch (e) {
      snap = await handle.collection('callHistory').limit(limit + 20).get();
    }

    let rows = snap.docs.map(function (doc) {
      const d = doc.data() || {};
      const startMs = Number(d.createdAtMs) ||
        (d.startTime && d.startTime.toMillis ? d.startTime.toMillis() : 0);
      return {
        callId: d.call_id || doc.id,
        userA: d.userA || '',
        userB: d.userB || '',
        startMs: startMs,
        duration: Number(d.duration) || 0
      };
    });

    rows.sort(function (a, b) { return b.startMs - a.startMs; });
    if (before > 0) rows = rows.filter(function (r) { return r.startMs < before; });
    rows = rows.slice(0, limit);

    /* Resolve names for the visible page only (max 20 unique ids -> 2 chunks). */
    const ids = Array.from(new Set(
      rows.reduce(function (acc, r) {
        if (r.userA) acc.push(r.userA);
        if (r.userB) acc.push(r.userB);
        return acc;
      }, [])
    )).slice(0, 10);

    const names = {};
    if (ids.length) {
      try {
        const usersSnap = await handle.collection('users')
          .where('__name__', 'in', ids.map(function (id) { return handle.collection('users').doc(id); }))
          .get();
        usersSnap.docs.forEach(function (doc) { names[doc.id] = (doc.data() || {}).name || ''; });
      } catch (e) { /* cosmetic */ }
    }
    rows.forEach(function (r) {
      r.nameA = names[r.userA] || '';
      r.nameB = names[r.userB] || '';
    });

    send(res, 200, {
      ok: true,
      calls: rows,
      hasMore: rows.length === limit,
      nextBefore: rows.length ? rows[rows.length - 1].startMs : 0
    });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return send(res, 200, { ok: false, backend: 'offline', calls: [], hasMore: false, nextBefore: 0 });
    }
    fail(res, 500, 'Could not load call history.');
  }
};
