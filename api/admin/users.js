'use strict';
/* GET /api/admin/users?sort=reports&order=desc&q=search&limit=200
 *
 * The user registry. Default sort is reportCount DESC — the whole point of the
 * table is "who is being reported the most".
 *
 * Sorting and searching happen here (not in Firestore) because the sort key
 * (reportCount) exists on every document but the filters are ad-hoc. For a few
 * hundred users that is instant; past ~5k a rollup or an index would be needed.
 */

const { send, fail } = require('../_lib/fb');
const auth = require('../_lib/auth');
const store = require('../_lib/store');

const SORTS = {
  reports: 'reportCount',
  status: 'banned',
  id: 'id',
  name: 'name',
  firstSeen: 'firstSeen',
  lastSeen: 'lastSeen',
  paid: 'paid',
  calls: 'totalCalls',
  minutes: 'totalMinutes'
};

function compare(a, b, key) {
  const av = a[key];
  const bv = b[key];
  if (typeof av === 'number' || typeof bv === 'number') {
    return (Number(av) || 0) - (Number(bv) || 0);
  }
  return String(av || '').localeCompare(String(bv || ''), 'en', { numeric: true });
}

module.exports = async function handler(req, res) {
  if (!auth.requireAdmin(req, res, fail)) return;

  const q = String((req.query && req.query.q) || '').trim().toLowerCase();
  const sortKey = SORTS[String((req.query && req.query.sort) || 'reports')] || 'reportCount';
  const order = String((req.query && req.query.order) || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  const limit = Math.min(1000, Math.max(1, Number((req.query && req.query.limit) || 300)));

  try {
    const handle = store.fs();
    const snap = await handle.collection('users').limit(2000).get();

    let rows = snap.docs.map(function (doc) {
      const d = doc.data() || {};
      const reports = Array.isArray(d.reports) ? d.reports : [];
      return {
        id: doc.id,
        name: d.name || '',
        paid: !!d.paid,
        unlocked: !!d.unlocked,
        banned: !!d.banned,
        totalCalls: Number(d.totalCalls) || 0,
        totalMinutes: Math.round((Number(d.totalMinutes) || 0) * 10) / 10,
        reportCount: Number(d.reportCount) || reports.length || 0,
        firstSeen: Number(d.firstSeen) || 0,
        lastSeen: Number(d.lastSeen) || 0,
        paidAt: Number(d.paidAt) || 0,
        paidStars: Number(d.paidStars) || 0,
        lastReason: reports.length ? String(reports[reports.length - 1].reason || '') : ''
      };
    });

    if (q) {
      rows = rows.filter(function (r) {
        return r.id.toLowerCase().indexOf(q) !== -1 ||
          String(r.name || '').toLowerCase().indexOf(q) !== -1;
      });
    }

    rows.sort(function (a, b) { return compare(a, b, sortKey) * order; });

    const total = rows.length;
    rows = rows.slice(0, limit);

    send(res, 200, {
      ok: true,
      total: total,
      shown: rows.length,
      sort: String((req.query && req.query.sort) || 'reports'),
      order: order === 1 ? 'asc' : 'desc',
      users: rows
    });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return send(res, 200, { ok: false, backend: 'offline', total: 0, users: [], error: 'Firebase is not configured.' });
    }
    fail(res, 500, 'Could not load users.');
  }
};
