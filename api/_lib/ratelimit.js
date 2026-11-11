'use strict';
/* ---------------------------------------------------------------------------
 * Best-effort, per-instance rate limiting.
 *
 * Serverless functions are ephemeral and horizontally scaled, so this is NOT a
 * hard guarantee — each instance keeps its own counters and a cold start
 * resets them. It is still worth having: it stops one bored user from hammering
 * a public endpoint (heartbeat, report) hundreds of times a second from a single
 * warm instance, which is the realistic abuse pattern here.
 *
 * If real protection is needed, swap this for Upstash Redis or Firestore-based
 * counters keyed by telegram_id.
 * ------------------------------------------------------------------------- */

const buckets = new Map();
const MAX_KEYS = 5000;

function sweep(nowMs) {
  if (buckets.size < MAX_KEYS) return;
  buckets.forEach(function (entry, key) {
    if (entry.reset < nowMs) buckets.delete(key);
  });
}

/**
 * @param {string} key      unique bucket name, e.g. "heartbeat:12345"
 * @param {number} limit    max requests inside the window
 * @param {number} windowMs window length
 * @returns {boolean}       true when the caller is over budget
 */
function tooMany(key, limit, windowMs) {
  const now = Date.now();
  sweep(now);

  let entry = buckets.get(key);
  if (!entry || entry.reset < now) {
    entry = { count: 0, reset: now + windowMs };
    buckets.set(key, entry);
  }
  entry.count += 1;
  return entry.count > limit;
}

/** Client IP as seen by Vercel. Used when we have no telegram_id yet. */
function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  if (Array.isArray(fwd) && fwd.length) return String(fwd[0]).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { tooMany, clientKey };
