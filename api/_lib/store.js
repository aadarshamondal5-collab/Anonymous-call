'use strict';
/* ---------------------------------------------------------------------------
 * Data access helpers shared by the API routes.
 *
 * Collections
 *   config/payment      { required: boolean, updatedAt }
 *   users/{telegramId}  { name, firstSeen, lastSeen, paid, unlocked, banned,
 *                         totalCalls, totalMinutes, reportCount, reports[] }
 *   heartbeats/{id}     { name, avatar, gender, filter, status, peer_id, expiresAt }
 *   activeCalls/{id}    { call_id, userA, userB, startedAt }
 *   callHistory/{id}    { call_id, userA, userB, startTime, endTime, duration }
 *   adminLogs/{id}      { timestamp, action, target, details }
 *
 * Firestore has no "expiresAt > now()" index requirement for a simple filter,
 * but a TTL policy on `heartbeats.expiresAt` is still recommended so dead rows
 * are deleted for free. Queries here filter by time as well, so the app is
 * correct even before the TTL policy is enabled.
 * ------------------------------------------------------------------------- */

const { db, FieldValue, nowMs, startOfDay } = require('./fb');

const HEARTBEAT_TTL_MS = 20000;   // client beats every 3 s; 20 s = 6 chances
const HEARTBEAT_LIMIT = 500;      // safety cap for the live view
const MAX_REPORTS_KEPT = 50;      // older reports are counted but not stored

function fs() {
  const handle = db();
  if (!handle) {
    const err = new Error('firebase_not_configured');
    err.code = 'firebase_not_configured';
    throw err;
  }
  return handle;
}

function isConfigured() { return !!db(); }

/* ------------------------------------------------------------------ config */

/** Reads the global payment switch. Defaults to PAID (the safe/earning state)
 *  when the document does not exist yet, so a fresh deploy never gives away
 *  the paid feature by accident. */
async function getPaymentRequired() {
  try {
    const snap = await fs().collection('config').doc('payment').get();
    if (!snap.exists) return true;
    const data = snap.data() || {};
    return data.required !== false;
  } catch (e) {
    if (e.code === 'firebase_not_configured') return true;
    return true;
  }
}

async function setPaymentRequired(required) {
  await fs().collection('config').doc('payment').set({
    required: !!required,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

/* -------------------------------------------------------------- admin logs */

async function logAdmin(action, target, details) {
  try {
    await fs().collection('adminLogs').add({
      timestamp: FieldValue.serverTimestamp(),
      at: nowMs(),
      action: String(action || ''),
      target: String(target === undefined || target === null ? '' : target),
      details: String(details || '')
    });
  } catch (e) {
    /* Logging must never break the operation it is describing. */
  }
}

/* ------------------------------------------------------------------- users */

/** Creates or refreshes the user row. `patch` is merged, never replaced. */
async function touchUser(telegramId, patch) {
  if (!telegramId) return;
  const ref = fs().collection('users').doc(String(telegramId));
  const update = Object.assign({ lastSeen: nowMs() }, patch || {});
  try {
    const snap = await ref.get();
    if (!snap.exists) {
      update.firstSeen = nowMs();
      update.paid = false;
      update.unlocked = false;
      update.banned = false;
      update.totalCalls = 0;
      update.totalMinutes = 0;
      update.reportCount = 0;
      update.reports = [];
      await ref.set(update, { merge: true });
    } else {
      await ref.set(update, { merge: true });
    }
  } catch (e) {
    /* A failed profile write must not reject a report or a heartbeat. */
  }
}

async function getUser(telegramId) {
  const snap = await fs().collection('users').doc(String(telegramId)).get();
  return snap.exists ? Object.assign({ id: snap.id }, snap.data()) : null;
}

/** Ban / unban / unlock / grant-paid. All four go through here. */
async function applyUserAction(telegramId, action) {
  const id = String(telegramId);
  const ref = fs().collection('users').doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      firstSeen: nowMs(), lastSeen: nowMs(), name: '',
      paid: false, unlocked: false, banned: false,
      totalCalls: 0, totalMinutes: 0, reportCount: 0, reports: []
    }, { merge: true });
  }

  const patch = { lastSeen: nowMs() };
  switch (action) {
    case 'ban':          patch.banned = true; break;
    case 'unban':        patch.banned = false; break;
    case 'unlock':       patch.unlocked = true; break;
    case 'lock':         patch.unlocked = false; break;
    case 'grant-paid':   patch.paid = true; break;
    case 'revoke-paid':  patch.paid = false; break;
    default: throw new Error('unknown_action');
  }
  await ref.set(patch, { merge: true });
  return patch;
}

/* -------------------------------------------------------------- heartbeats */

/** Deletes beams that are already expired. Cheap on a small app, and it keeps
 *  the live counters honest even if the TTL policy was never enabled. */
async function pruneHeartbeats() {
  const cutoff = new Date(nowMs() - HEARTBEAT_TTL_MS);
  try {
    const dead = await fs().collection('heartbeats')
      .where('expiresAt', '<', cutoff)
      .limit(120)
      .get();
    if (dead.empty) return 0;
    const batch = fs().batch();
    dead.docs.forEach(function (doc) { batch.delete(doc.ref); });
    await batch.commit();
    return dead.size;
  } catch (e) {
    return 0;
  }
}

async function listLiveHeartbeats() {
  const cutoff = new Date(nowMs() - HEARTBEAT_TTL_MS);
  const snap = await fs().collection('heartbeats')
    .where('expiresAt', '>', cutoff)
    .limit(HEARTBEAT_LIMIT)
    .get();
  return snap.docs.map(function (doc) {
    const d = doc.data() || {};
    return {
      id: doc.id,
      name: d.name || '',
      avatar: d.avatar || '🙂',
      gender: d.gender || null,
      filter: d.filter || null,
      status: d.status || 'idle',
      peerId: d.peer_id || null,
      since: Number(d.since) || Number(d.updatedAtMs) || 0,
      updatedAtMs: Number(d.updatedAtMs) || 0
    };
  });
}

async function dropHeartbeat(telegramId) {
  try {
    await fs().collection('heartbeats').doc(String(telegramId)).delete();
  } catch (e) { /* nothing to do */ }
}

/* -------------------------------------------------------------- call stats */

async function getTodayAggregates() {
  const dayStart = new Date(startOfDay(nowMs()));
  let callsToday = 0;
  let reportsToday = 0;

  try {
    const calls = await fs().collection('callHistory')
      .where('startTime', '>=', dayStart)
      .limit(2000)
      .get();
    callsToday = calls.size;
  } catch (e) { callsToday = 0; }

  /* Reports live inside the user document, so counting today's reports means
   * reading the (small) user set rather than a dedicated collection. */
  try {
    const users = await fs().collection('users').limit(1000).get();
    const dayStartMs = startOfDay(nowMs());
    users.docs.forEach(function (doc) {
      const list = (doc.data() || {}).reports;
      if (!Array.isArray(list)) return;
      list.forEach(function (r) {
        if (Number(r && r.timestamp) >= dayStartMs) reportsToday += 1;
      });
    });
  } catch (e) { reportsToday = 0; }

  return { callsToday, reportsToday };
}

/* ----------------------------------------------------------------- reports */

/** Adds a report to the reported user's document. Duplicate-protected by
 *  reporter_id + call_id so a user cannot inflate someone's count by tapping
 *  "report" five times (or by replaying the request). */
async function addReport(opts) {
  const ref = fs().collection('users').doc(String(opts.reportedId));
  const snap = await ref.get();
  const existing = snap.exists ? (snap.data().reports || []) : [];

  const duplicate = existing.some(function (r) {
    return r && String(r.reporter_id) === String(opts.reporterId) &&
      String(r.call_id || '') === String(opts.callId || '');
  });
  if (duplicate) return { duplicate: true, count: Number(snap.data().reportCount) || 0 };

  const entry = {
    reporter_id: String(opts.reporterId),
    reporter_name: String(opts.reporterName || '').slice(0, 64),
    reason: String(opts.reason || 'other').slice(0, 32),
    note: String(opts.note || '').slice(0, 300),
    call_id: String(opts.callId || ''),
    timestamp: nowMs()
  };

  /* Keep only the newest N entries in the array but never lose the counter. */
  const nextReports = existing.concat([entry]).slice(-MAX_REPORTS_KEPT);
  const patch = {
    reports: nextReports,
    reportCount: FieldValue.increment(1),
    lastSeen: nowMs()
  };
  if (!snap.exists) {
    patch.firstSeen = nowMs();
    patch.paid = false;
    patch.unlocked = false;
    patch.banned = false;
    patch.totalCalls = 0;
    patch.totalMinutes = 0;
  }
  await ref.set(patch, { merge: true });
  return { duplicate: false, count: existing.length + 1 };
}

/** "Dismiss all reports" clears the array and resets the counter. */
async function clearReports(telegramId) {
  await fs().collection('users').doc(String(telegramId)).set({
    reports: [],
    reportCount: 0
  }, { merge: true });
}

module.exports = {
  HEARTBEAT_TTL_MS, MAX_REPORTS_KEPT,
  isConfigured, fs,
  getPaymentRequired, setPaymentRequired,
  logAdmin, touchUser, getUser, applyUserAction,
  pruneHeartbeats, listLiveHeartbeats, dropHeartbeat,
  getTodayAggregates, addReport, clearReports
};
