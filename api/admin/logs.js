'use strict';
/* GET /api/admin/logs?limit=50
 * The admin action log, newest first. Written by every mutating route. */

const { send, fail } = require('../_lib/fb');
const auth = require('../_lib/auth');
const store = require('../_lib/store');

module.exports = async function handler(req, res) {
  if (!auth.requireAdmin(req, res, fail)) return;

  const limit = Math.min(200, Math.max(1, Number((req.query && req.query.limit) || 50)));

  try {
    const handle = store.fs();
    let snap;
    try {
      snap = await handle.collection('adminLogs').orderBy('at', 'desc').limit(limit).get();
    } catch (e) {
      snap = await handle.collection('adminLogs').limit(limit).get();
    }

    const logs = snap.docs.map(function (doc) {
      const d = doc.data() || {};
      return {
        id: doc.id,
        at: Number(d.at) || (d.timestamp && d.timestamp.toMillis ? d.timestamp.toMillis() : 0),
        action: d.action || '',
        target: d.target || '',
        details: d.details || ''
      };
    }).sort(function (a, b) { return b.at - a.at; });

    send(res, 200, { ok: true, logs: logs });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return send(res, 200, { ok: false, backend: 'offline', logs: [] });
    }
    fail(res, 500, 'Could not load logs.');
  }
};
