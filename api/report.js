'use strict';
/* POST /api/report
 * body: { reporter_id, reported_id, call_id, reason, note }
 *
 * Public, because a report has to be filed from inside a live call with no
 * login. Rate limited per reporter (10 per 10 minutes) and deduped server-side
 * on reporter_id + call_id, so the same person cannot inflate a victim's count.
 *
 * reason: abusive | spam | fake | other
 */

const { send, fail, asText } = require('./_lib/fb');
const store = require('./_lib/store');
const { tooMany, clientKey } = require('./_lib/ratelimit');

const REASONS = { abusive: 1, spam: 1, fake: 1, other: 1 };

module.exports = async function handler(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    return fail(res, 405, 'POST only.');
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const reporterId = asText(body.reporter_id, 64).trim();
  const reportedId = asText(body.reported_id, 64).trim();
  const reportedMqtt = asText(body.reported_mqtt_id, 64).trim();
  const callId = asText(body.call_id, 80).trim();
  const reasonRaw = asText(body.reason, 32).trim().toLowerCase();
  const reason = REASONS[reasonRaw] ? reasonRaw : 'other';
  const note = asText(body.note, 300);

  if (!reporterId) return fail(res, 400, 'reporter_id is required.');
  if (!reportedId && !reportedMqtt) return fail(res, 400, 'reported_id is required.');
  if (reporterId === reportedId) return fail(res, 400, 'You cannot report yourself.');

  if (tooMany('rpt:' + reporterId, 10, 600000)) {
    return fail(res, 429, 'Too many reports. Please try again later.');
  }
  if (tooMany('rptip:' + clientKey(req), 30, 600000)) {
    return fail(res, 429, 'Too many reports from this network.');
  }

  try {
    const result = await store.addReport({
      reporterId: reporterId,
      reporterName: asText(body.reporter_name, 64),
      reportedId: reportedId || reportedMqtt,
      callId: callId,
      reason: reason,
      note: note
    });

    await store.logAdmin('report', reportedId || reportedMqtt,
      (result.duplicate ? 'duplicate ignored, ' : '') + 'by ' + reporterId + ' (' + reason + ')' + (reportedMqtt ? ' mqtt:' + reportedMqtt : ''));

    return send(res, 200, {
      ok: true,
      duplicate: !!result.duplicate,
      count: result.count || 0
    });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      /* Do not lose the user's intent silently: tell the client it was queued
       * in the sense that nothing was stored. The UI still shows its toast. */
      return send(res, 200, { ok: true, duplicate: false, backend: 'offline' });
    }
    fail(res, 500, 'Could not save the report. Please try again.');
  }
};
