'use strict';
/* POST /api/call-event
 * body: { event: 'start'|'end', call_id, userA, userB, peer_id, duration }
 *
 * start -> creates activeCalls/{call_id}
 * end   -> deletes the active row, appends callHistory, bumps user totals
 *
 * Idempotent enough to survive the double-fire that happens when a user taps
 * "Next person" while the peer also hangs up: the second `end` finds no active
 * row, records nothing, and returns ok.
 */

const { send, fail, asText, FieldValue } = require('./_lib/fb');
const store = require('./_lib/store');
const { tooMany } = require('./_lib/ratelimit');

async function endCall(handle, id, body) {
  const activeRef = handle.collection('activeCalls').doc(id);
  const activeSnap = await activeRef.get();
  const active = activeSnap.exists ? activeSnap.data() : null;

  const startedAtMs = Number(body.startedAt) || (active && Number(active.startedAtMs)) || 0;
  const endMs = Date.now();
  const duration = Math.max(0, Number(body.duration) ||
    (startedAtMs ? Math.round((endMs - startedAtMs) / 1000) : 0));

  if (activeSnap.exists) await activeRef.delete();

  /* Dedupe: the FIRST `end` for a call still sees the active row, deletes it and
   * writes the history entry. Both clients post `end`, so the second one finds
   * nothing and records nothing. That is also why the per-user totals below are
   * only bumped inside this branch. */
  const isFirstEnd = !!active && activeSnap.exists;

  if (isFirstEnd && duration >= 1) {
    await handle.collection('callHistory').add({
      call_id: id,
      userA: active.userA || '',
      userB: active.userB || '',
      startTime: startedAtMs ? new Date(startedAtMs) : new Date(endMs - duration * 1000),
      endTime: new Date(endMs),
      duration: duration,
      createdAtMs: endMs
    });
  }

  /* Totals per participant, so the registry table has real numbers.
   * increment() is atomic and safe to call concurrently. */
  const pair = isFirstEnd
    ? [active.userA, active.userB]
    : [];

  const minutes = Math.round((duration / 60) * 10) / 10;

  for (const uid of pair) {
    if (!uid) continue;
    try {
      await store.touchUser(uid, {});
      if (duration >= 1) {
        await handle.collection('users').doc(uid).set({
          totalCalls: FieldValue.increment(1),
          totalMinutes: FieldValue.increment(minutes)
        }, { merge: true });
      }
    } catch (e) { /* one bad user row must not fail the whole history write */ }
  }

  return { duration: duration };
}

module.exports = async function handler(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    return fail(res, 405, 'POST only.');
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = asText(body.call_id, 80).trim();
  if (!id) return fail(res, 400, 'call_id is required.');
  if (tooMany('ce:' + id, 40, 60000)) return fail(res, 429, 'Too many call events.');

  const event = asText(body.event, 16) || 'end';

  try {
    const handle = store.fs();
    if (event === 'start') {
      await handle.collection('activeCalls').doc(id).set({
        call_id: id,
        userA: asText(body.userA, 64),
        userB: asText(body.userB, 64),
        startedAt: new Date(),
        startedAtMs: Date.now()
      }, { merge: true });
      return send(res, 200, { ok: true });
    }

    const result = await endCall(handle, id, body);
    return send(res, 200, { ok: true, duration: result.duration });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return send(res, 200, { ok: true, backend: 'offline' });
    }
    fail(res, 500, 'Could not save the call event.');
  }
};
