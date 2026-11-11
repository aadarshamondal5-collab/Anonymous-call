'use strict';
/* POST /api/heartbeat
 * body: { telegram_id, name, avatar, gender, filter, status, peer_id }
 *
 * Public and called every 3 seconds by every open tab. Writes ONE document per
 * user (doc id = telegram_id) so the collection cannot grow per-session.
 *
 * `expiresAt` is a real Date so a Firestore TTL policy can delete the row
 * automatically. Queries in lib/store.js also filter on it, so the live view is
 * correct even if the TTL policy was never enabled.
 *
 * status: 'idle' | 'waiting' | 'calling'
 */

const { send, fail, asText } = require('./_lib/fb');
const store = require('./_lib/store');
const { tooMany, clientKey } = require('./_lib/ratelimit');

const STATUSES = { idle: 1, waiting: 1, calling: 1 };

module.exports = async function handler(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    return fail(res, 405, 'POST only.');
  }

  /* 3 s cadence = 20 requests per minute per tab. 60 gives headroom for
   * flapping networks and multiple tabs without allowing a flood. */
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = asText(body.telegram_id, 64).trim();
  const bucketKey = 'hb:' + (id || clientKey(req));
  if (tooMany(bucketKey, 60, 60000)) {
    return fail(res, 429, 'Heartbeat too fast — slow down and try again.');
  }
  if (!id) return fail(res, 400, 'telegram_id is required.');

  const status = STATUSES[asText(body.status, 16)] ? asText(body.status, 16) : 'idle';
  const nowMs = Date.now();

  try {
    const handle = store.fs();

    /* `gone: true` is sent once from pagehide via sendBeacon. Deleting the row
     * there makes "Online now" honest within a second instead of waiting for the
     * TTL, which on a chat app is the difference between a useful table and a
     * table full of ghosts. */
    if (body.gone === true) {
      await store.dropHeartbeat(id);
      return send(res, 200, { ok: true, gone: true });
    }

    /* Read the user FIRST: this is both the ban fast-path and the "is the
     * registry row stale" check, so the common case is exactly one read and one
     * write per beat. Returning the flag here disconnects a banned user within
     * 3 s instead of on their next reload, without the server needing its own
     * MQTT client — the banned client's own endCall() publishes the MQTT `bye`,
     * so the partner drops immediately. */
    let user = null;
    try { user = await store.getUser(id); } catch (e) { user = null; }

    if (user && user.banned) {
      /* Never write a heartbeat for a banned user: drop the existing one so the
       * admin table stops showing them immediately. */
      await store.dropHeartbeat(id);
      return send(res, 200, { ok: true, banned: true });
    }

    await handle.collection('heartbeats').doc(id).set({
      name: asText(body.name, 32),
      avatar: asText(body.avatar, 8),
      gender: body.gender === 'male' || body.gender === 'female' ? body.gender : null,
      filter: body.filter === 'male' || body.filter === 'female' ? body.filter : null,
      status: status,
      peer_id: asText(body.peer_id, 64) || null,
      since: Number(body.since) || 0,
      updatedAtMs: nowMs,
      expiresAt: new Date(nowMs + store.HEARTBEAT_TTL_MS)
    }, { merge: true });

    /* Keep the registry names fresh, but only once a minute. Beating every 3 s
     * would otherwise mean 20 profile writes per minute per user for nothing. */
    if (!user || (nowMs - (Number(user.lastSeen) || 0)) > 60000) {
      await store.touchUser(id, { name: asText(body.name, 32) });
    }

    send(res, 200, { ok: true, banned: false });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return send(res, 200, { ok: true, backend: 'offline', banned: false });
    }
    fail(res, 500, 'Could not save the heartbeat.');
  }
};
