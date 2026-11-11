'use strict';
/* ===========================================================================
 * LinkCall — the ENTIRE backend in ONE serverless function.
 *
 * WHY ONE FILE
 * Vercel's Hobby plan creates a separate Lambda per file inside `api/`, and the
 * free tier caps how many functions a deployment may have. Collapsing every
 * route into `api/index.js` plus a single catch-all rewrite in vercel.json
 * "/api/(.*)" -> "/api" means the whole backend is ONE function. Vercel keeps
 * the original request URL on `req.url` across a rewrite, so the router below
 * still sees `/api/admin/stats` and not `/api`.
 *
 * NOTHING IS HARDCODED
 * The Firebase key, the bot token and the admin credentials come from Vercel
 * environment variables only. Firestore security rules should deny all direct
 * client access; the Admin SDK bypasses them, which is why the key must stay
 * server-side.
 *
 * ROUTES (see ROUTES at the bottom)
 *   GET  /api/config                     public  -> { paymentRequired, priceStars, channelUrl }
 *   GET  /api/payment-required           public  -> legacy alias for the paid flag
 *   GET  /api/check-access               public  -> { banned, unlocked, paid, paymentRequired }
 *   POST /api/heartbeat                  public  -> presence row for the admin live view
 *   POST /api/call-event                 public  -> start/end accounting
 *   POST /api/report                     public  -> user report
 *   POST /api/create-invoice             public  -> Telegram Stars invoice link
 *   POST /api/webhook                    secret  -> Telegram updates (payments, /start)
 *   POST /api/admin/login                public  -> JWT
 *   GET  /api/admin/stats                admin
 *   GET  /api/admin/live                 admin
 *   GET  /api/admin/users                admin
 *   GET  /api/admin/user/:telegram_id    admin
 *   GET  /api/admin/calls                admin
 *   GET  /api/admin/logs                 admin
 *   POST /api/admin/update-settings      admin   -> config/app { paymentRequired, priceStars, channelUrl }
 *   POST /api/admin/toggle-payment       admin   -> legacy alias for paymentRequired
 *   POST /api/admin/user-action          admin   -> ban/unban/unlock/lock/grant-paid/dismiss-reports
 *
 * COLLECTIONS
 *   config/app          { paymentRequired, priceStars, channelUrl, updatedAt }
 *   config/payment      { required }   legacy, read only when config/app is missing a field
 *   users/{id}          { name, firstSeen, lastSeen, paid, unlocked, banned,
 *                         totalCalls, totalMinutes, reportCount, reports[] }
 *   heartbeats/{id}     { name, avatar, gender, filter, status, peer_id, expiresAt }
 *   activeCalls/{id}    { call_id, userA, userB, startedAt }
 *   callHistory/{id}    { call_id, userA, userB, startTime, endTime, duration }
 *   adminLogs/{id}      { at, action, target, details }
 * ========================================================================= */

const crypto = require('crypto');
const admin = require('firebase-admin');

/* ---------------------------------------------------------------- constants */

const HEARTBEAT_TTL_MS = 20000;     // client beats every 3 s; 20 s = 6 chances
const HEARTBEAT_LIMIT = 500;        // safety cap for the live view
const MAX_REPORTS_KEPT = 50;        // older reports are counted but not stored
const MAX_BODY_BYTES = 200000;      // hard cap on a request body
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;   // 8 hours
const MIN_PASSWORD_LEN = 12;
const PRICE_MIN = 1;
const PRICE_MAX = 10000;
const PRODUCT = 'gender_filter';

/* Used only when Firestore has no config/app document. PAID + 50 Stars is the
 * safe default: a fresh deploy never gives the paid feature away by accident,
 * and never charges a price nobody chose. */
const DEFAULT_CONFIG = {
  paymentRequired: true,
  priceStars: 50,
  channelUrl: 'https://t.me/linkcallofficial'
};

/* =============================================================== 1. firebase */

let cachedApp = null;
let triedApp = false;

/* Vercel's env var UI keeps newlines as the two characters \ and n. Paste the
 * JSON exactly as downloaded and this normalisation makes it parse anyway. */
function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !String(raw).trim()) return null;
  try {
    return JSON.parse(String(raw).replace(/\\n/g, '\n'));
  } catch (e) {
    return null;
  }
}

function getApp() {
  if (triedApp) return cachedApp;
  triedApp = true;

  const creds = readServiceAccount();
  if (!creds) return null;

  try {
    const options = { credential: admin.credential.cert(creds) };
    const dbUrl = process.env.FIREBASE_DATABASE_URL;
    if (dbUrl) options.databaseURL = dbUrl;
    cachedApp = admin.apps.length ? admin.app() : admin.initializeApp(options);
  } catch (e) {
    cachedApp = null;
  }
  return cachedApp;
}

/** Firestore handle, or null when Firebase is not configured. */
function db() {
  const app = getApp();
  return app ? admin.firestore(app) : null;
}

const FieldValue = admin.firestore.FieldValue;

function nowMs() { return Date.now(); }

/** Start of the current UTC day. Deliberately UTC so the number is stable and
 *  does not jump around with per-instance timezones. */
function startOfDay(ms) {
  const d = new Date(ms || Date.now());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function asText(value, max) {
  return String(value === undefined || value === null ? '' : value).slice(0, max || 200);
}

/* =============================================================== 2. responses */

/** Every response is JSON, and never leaks a stack trace. */
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body === undefined ? {} : body));
}

function fail(res, status, message) {
  send(res, status, { ok: false, error: message });
}

/** Reads a JSON body whether Vercel already parsed it or handed us raw text. */
function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string' && req.body) {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  /* A GET has no body, and by the time we are called the stream may already be
   * consumed — attaching an 'end' listener to a finished stream never fires, so
   * awaiting it here would hang the request forever. */
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || req.readableEnded) {
    return Promise.resolve({});
  }
  return new Promise(function (resolve) {
    let raw = '';
    let done = false;
    const finish = function (value) { if (!done) { done = true; resolve(value); } };
    req.on('data', function (chunk) {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) req.destroy();
    });
    req.on('end', function () {
      if (!raw) return finish({});
      try { finish(JSON.parse(raw)); } catch (e) { finish({}); }
    });
    req.on('error', function () { finish({}); });
    req.on('close', function () { finish({}); });
  });
}

/* ============================================================ 3. rate limits */
/* Best-effort and per-instance: serverless instances are ephemeral and scaled
 * horizontally, so this is NOT a hard guarantee. It still stops one bored user
 * from hammering a public endpoint from a warm instance. Swap for Upstash Redis
 * if real protection is ever needed. */

const buckets = new Map();
const MAX_KEYS = 5000;

function sweep(now) {
  if (buckets.size < MAX_KEYS) return;
  buckets.forEach(function (entry, key) {
    if (entry.reset < now) buckets.delete(key);
  });
}

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
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  if (Array.isArray(fwd) && fwd.length) return String(fwd[0]).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ================================================================= 4. auth */
/* NOTHING IS HARDCODED HERE.
 *
 * The admin ID and password come ONLY from Vercel environment variables:
 *   ADMIN_ID            e.g. "lc_ops_7f3a"   (never the guessable "admin")
 *   ADMIN_PASSWORD      long random string   (min 12 chars, enforced below)
 *   ADMIN_TOKEN_SECRET  optional; if absent it is derived from ADMIN_PASSWORD
 *
 * If either ADMIN_ID or ADMIN_PASSWORD is missing, admin login is DISABLED.
 * That is intentional: the safe failure mode for an auth endpoint is "closed",
 * never "open with a guessable default". The route answers 503 and names the
 * missing variable so a misconfigured deploy is obvious instead of insecure. */

function adminCredentials() {
  const id = (process.env.ADMIN_ID || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!id || !password) return null;
  return { id: id, password: password };
}

/** Human-readable reason the panel cannot log in, or '' when it is configured. */
function setupProblem() {
  const missing = [];
  if (!(process.env.ADMIN_ID || '').trim()) missing.push('ADMIN_ID');
  if (!(process.env.ADMIN_PASSWORD || '')) missing.push('ADMIN_PASSWORD');
  if (missing.length) {
    return 'Admin login is disabled: set ' + missing.join(' and ') +
      ' in the Vercel environment variables.';
  }
  if ((process.env.ADMIN_PASSWORD || '').length < MIN_PASSWORD_LEN) {
    return 'ADMIN_PASSWORD must be at least ' + MIN_PASSWORD_LEN + ' characters long.';
  }
  return '';
}

function tokenSecret() {
  /* ADMIN_TOKEN_SECRET is the right var. If the operator only set
   * ADMIN_PASSWORD we derive a secret from it so tokens still work — rotating
   * the password then also invalidates every existing session, which is fine. */
  const dedicated = process.env.ADMIN_TOKEN_SECRET;
  if (dedicated && dedicated.length >= 8) return dedicated;
  const pw = process.env.ADMIN_PASSWORD;
  if (pw && pw.length >= MIN_PASSWORD_LEN) return 'linkcall::' + pw;
  return null;
}

function sign(payload) {
  const key = tokenSecret();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

/** Constant-time compare so a wrong password cannot be brute-forced by timing. */
function sameString(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    /* Still run a compare of equal-length buffers so the timing does not leak
     * the length of the expected value. */
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/* A compact signed token: <base64url payload>.<hmac>.
 *
 * The payload is a real JWT-ish claims blob (sub/iat/exp/iss) so the operator
 * can paste it into jwt.io and read it, but the signature is the same
 * HMAC-SHA256 scheme this project already used — no new dependency, no key
 * files, works on serverless, and rotation is just ADMIN_TOKEN_SECRET. */
function b64url(input) {
  return Buffer.from(String(input), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input) {
  const padded = String(input).replace(/-/g, '+').replace(/_/g, '/');
  /* base64url drops the trailing '='; put back only what is missing. */
  const missing = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(missing), 'base64').toString('utf8');
}

function issueToken(id) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + Math.floor(TOKEN_TTL_MS / 1000);
  const payload = b64url(JSON.stringify({
    sub: String(id || 'admin').slice(0, 64),
    iat: iat,
    exp: exp,
    iss: 'linkcall'
  }));
  const sig = sign(payload);
  if (!sig) return null;
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const expected = sign(parts[0]);
  if (!expected) return false;
  if (!sameString(parts[1], expected)) return false;

  /* The signature is the real gate; the claims are only read after it passes,
   * so a tampered payload cannot extend its own expiry. */
  let claims = null;
  try { claims = JSON.parse(b64urlDecode(parts[0])); } catch (e) { return false; }
  if (!claims || typeof claims !== 'object') return false;
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  return true;
}

/** Pulls the bearer token from the Authorization header or an x-admin-token. */
function tokenFrom(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (header && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  const alt = req.headers && (req.headers['x-admin-token'] || req.headers['X-Admin-Token']);
  return alt ? String(alt).trim() : '';
}

/** Guard for admin routes. Returns true when the request may proceed. */
function requireAdmin(req, res) {
  if (verifyToken(tokenFrom(req))) return true;
  fail(res, 401, 'Admin token is invalid or expired. Please log in again.');
  return false;
}

/** Only allow POST — every mutating route is POST-only. */
function requirePost(req, res) {
  if (String(req.method || 'GET').toUpperCase() === 'POST') return true;
  fail(res, 405, 'POST only.');
  return false;
}

function requireGet(req, res) {
  if (String(req.method || 'GET').toUpperCase() === 'GET') return true;
  fail(res, 405, 'GET only.');
  return false;
}

/* ================================================================ 5. storage */

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

/* ------------------------------------------------------------ app settings */

/** Reads config/app. Every missing or invalid field falls back to
 *  DEFAULT_CONFIG, so a half-written document can never break the app.
 *  The legacy config/payment document is only consulted when config/app has no
 *  paymentRequired field — that keeps an older deploy's toggle working. */
async function getAppConfig() {
  let data = {};
  try {
    const snap = await fs().collection('config').doc('app').get();
    if (snap.exists) data = snap.data() || {};
  } catch (e) {
    /* Firebase not configured or down: defaults still answer the request. */
    return Object.assign({}, DEFAULT_CONFIG, { backend: isConfigured() ? 'live' : 'offline' });
  }

  let paymentRequired;
  if (typeof data.paymentRequired === 'boolean') {
    paymentRequired = data.paymentRequired;
  } else {
    paymentRequired = await getPaymentRequired();
  }

  const rawPrice = Number(data.priceStars);
  const priceStars = Number.isFinite(rawPrice) && rawPrice >= PRICE_MIN && rawPrice <= PRICE_MAX
    ? Math.round(rawPrice)
    : DEFAULT_CONFIG.priceStars;

  /* Only an http(s) or t.me link is echoed back to clients; anything else
   * (javascript:, data:, garbage) is dropped. This is the one field an admin can
   * type freely, so it is validated on the way out as well as on the way in.
   *
   * An ABSENT field and an EMPTY field mean different things:
   *   absent -> nobody has configured a channel yet, use the placeholder default
   *   ''     -> the admin deliberately cleared it, so hide the button
   * Collapsing the two would make "Save Link" with an empty box impossible to
   * express: the placeholder would come back on the next read. */
  const channelUrl = data.channelUrl === undefined || data.channelUrl === null
    ? DEFAULT_CONFIG.channelUrl
    : safeChannelUrl(data.channelUrl);

  return {
    paymentRequired: paymentRequired,
    priceStars: priceStars,
    channelUrl: channelUrl,
    backend: 'live'
  };
}

/** Accepts http(s):// and t.me/… links. Returns '' for anything else. */
function safeChannelUrl(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw || raw.length > 300) return '';
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw);
  } catch (e) {
    return '';
  }
  const proto = url.protocol.toLowerCase();
  if (proto !== 'https:' && proto !== 'http:') return '';
  if (url.protocol === 'http:' && !url.hostname) return '';
  /* A bare "t.me/name" becomes https://t.me/name via the prefix above. */
  if (!url.hostname || url.hostname.indexOf('.') === -1) return '';
  return url.toString().replace(/\/$/, '');
}

/** Writes config/app. Only the keys that were passed are touched. */
async function setAppConfig(patch) {
  const update = { updatedAt: FieldValue.serverTimestamp() };
  if (patch && typeof patch.paymentRequired === 'boolean') {
    update.paymentRequired = patch.paymentRequired;
  }
  if (patch && patch.priceStars !== undefined) {
    update.priceStars = patch.priceStars;
  }
  if (patch && patch.channelUrl !== undefined) {
    update.channelUrl = patch.channelUrl;
  }
  await fs().collection('config').doc('app').set(update, { merge: true });
}

/** Legacy paid flag. Defaults to PAID (the safe/earning state) when the
 *  document does not exist yet. */
async function getPaymentRequired() {
  try {
    const snap = await fs().collection('config').doc('payment').get();
    if (!snap.exists) return true;
    const data = snap.data() || {};
    return data.required !== false;
  } catch (e) {
    return true;
  }
}

async function setPaymentRequired(required) {
  try {
    await fs().collection('config').doc('payment').set({
      required: !!required,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) { /* the caller reports the failure; config/app is the new home */ }
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
    }
    await ref.set(update, { merge: true });
  } catch (e) {
    /* A failed profile write must not reject a report or a heartbeat. */
  }
}

async function getUser(telegramId) {
  const snap = await fs().collection('users').doc(String(telegramId)).get();
  return snap.exists ? Object.assign({ id: snap.id }, snap.data()) : null;
}

/** Ban / unban / unlock / lock / grant-paid / revoke-paid. One code path. */
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

/** Deletes beams that already expired. Keeps the live counters honest even if
 *  the TTL policy was never enabled. */
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
 *  "report" five times, or by replaying the request. */
async function addReport(opts) {
  const ref = fs().collection('users').doc(String(opts.reportedId));
  const snap = await ref.get();
  const existing = snap.exists ? (snap.data().reports || []) : [];

  const duplicate = existing.some(function (r) {
    return r && String(r.reporter_id) === String(opts.reporterId) &&
      String(r.call_id || '') === String(opts.callId || '');
  });
  if (duplicate) {
    return { duplicate: true, count: Number(snap.data().reportCount) || 0 };
  }

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

/* ========================================================= 6. public routes */

/* GET /api/config — the ONE document the frontend reads on load.
 * Everything the admin can change lives here: the paid/free switch, the Stars
 * price and the broadcast channel link. Public and never 500: a broken or
 * missing backend still answers the defaults so the page boots. */
async function routeConfig(req, res) {
  if (!requireGet(req, res)) return;
  if (tooMany('cfg:' + clientKey(req), 120, 60000)) {
    return fail(res, 429, 'Too many requests — please try again in a moment.');
  }
  try {
    const cfg = await getAppConfig();
    send(res, 200, {
      ok: true,
      paymentRequired: cfg.paymentRequired,
      priceStars: cfg.priceStars,
      channelUrl: cfg.channelUrl,
      backend: cfg.backend,
      serverTime: Date.now()
    });
  } catch (e) {
    send(res, 200, Object.assign({ ok: true, backend: 'offline' }, DEFAULT_CONFIG));
  }
}

/* GET /api/payment-required — legacy alias, kept for old cached clients. */
async function routePaymentRequired(req, res) {
  if (!requireGet(req, res)) return;
  try {
    const cfg = await getAppConfig();
    send(res, 200, {
      ok: true,
      required: cfg.paymentRequired,
      price: cfg.priceStars,
      backend: isConfigured() ? 'live' : 'offline'
    });
  } catch (e) {
    send(res, 200, { ok: true, required: true, price: DEFAULT_CONFIG.priceStars, backend: 'offline' });
  }
}

/* GET /api/check-access?telegram_id=...
 *
 * Called once on load. Three possible answers:
 *   banned   -> blocking screen, everything disabled
 *   unlocked -> Gender filter available even when payment is required
 *   paid     -> same as unlocked, bought with Stars
 *
 * Advisory only: matching happens peer-to-peer over MQTT, so a determined user
 * can always edit their own card. Documented as a known limitation rather than
 * pretended away. */
async function routeCheckAccess(req, res, query) {
  if (!requireGet(req, res)) return;

  if (tooMany('access:' + clientKey(req), 90, 60000)) {
    return fail(res, 429, 'Too many requests — please try again in a moment.');
  }

  const id = asText(query.get('telegram_id') || '', 64).trim();
  if (!id) return fail(res, 400, 'telegram_id is required.');

  let cfg;
  try { cfg = await getAppConfig(); } catch (e) { cfg = Object.assign({}, DEFAULT_CONFIG); }
  const required = cfg.paymentRequired !== false;

  try {
    const user = await getUser(id);
    if (!user) {
      return send(res, 200, {
        ok: true, banned: false, unlocked: false, paid: false,
        paymentRequired: required, priceStars: cfg.priceStars,
        known: false, reportCount: 0
      });
    }
    return send(res, 200, {
      ok: true,
      banned: !!user.banned,
      unlocked: !!user.unlocked,
      paid: !!user.paid,
      paymentRequired: required,
      priceStars: cfg.priceStars,
      known: true,
      reportCount: Number(user.reportCount) || 0,
      name: user.name || ''
    });
  } catch (e) {
    /* Fail OPEN on ban checks: a Firestore outage must not lock everybody out
     * of a chat app. Fail CLOSED on payment by keeping `required` as it was. */
    return send(res, 200, {
      ok: true, banned: false, unlocked: false, paid: false,
      paymentRequired: required, priceStars: cfg.priceStars,
      known: false, reportCount: 0, backend: 'offline'
    });
  }
}

/* POST /api/heartbeat
 * body: { telegram_id, name, avatar, gender, filter, status, peer_id, since }
 * status: 'idle' | 'waiting' | 'calling'
 *
 * Public and called every 3 s by every open tab. Writes ONE document per user
 * (doc id = telegram_id) so the collection cannot grow per-session. `expiresAt`
 * is a real Date so a Firestore TTL policy can delete the row automatically. */
const STATUSES = { idle: 1, waiting: 1, calling: 1 };

async function routeHeartbeat(req, res) {
  if (!requirePost(req, res)) return;

  /* 3 s cadence = 20 requests per minute per tab. 60 gives headroom for
   * flapping networks and multiple tabs without allowing a flood. */
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = asText(body.telegram_id, 64).trim();
  if (tooMany('hb:' + (id || clientKey(req)), 60, 60000)) {
    return fail(res, 429, 'Heartbeat too fast — slow down and try again.');
  }
  if (!id) return fail(res, 400, 'telegram_id is required.');

  const status = STATUSES[asText(body.status, 16)] ? asText(body.status, 16) : 'idle';
  const now = Date.now();

  try {
    const handle = fs();

    /* `gone: true` is sent once from pagehide via sendBeacon. Deleting the row
     * there makes "Online now" honest within a second instead of waiting for
     * the TTL. */
    if (body.gone === true) {
      await dropHeartbeat(id);
      return send(res, 200, { ok: true, gone: true });
    }

    /* Read the user FIRST: this is both the ban fast-path and the "is the
     * registry row stale" check, so the common case is one read and one write
     * per beat. Returning the flag here disconnects a banned user within 3 s
     * without the server needing its own MQTT client — the banned client's own
     * endCall() publishes the MQTT `bye`, so the partner drops immediately. */
    let user = null;
    try { user = await getUser(id); } catch (e) { user = null; }

    if (user && user.banned) {
      /* Never write a heartbeat for a banned user: drop the existing one so the
       * admin table stops showing them immediately. */
      await dropHeartbeat(id);
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
      updatedAtMs: now,
      expiresAt: new Date(now + HEARTBEAT_TTL_MS)
    }, { merge: true });

    /* Keep the registry names fresh, but only once a minute. Beating every 3 s
     * would otherwise mean 20 profile writes per minute per user for nothing. */
    if (!user || (now - (Number(user.lastSeen) || 0)) > 60000) {
      await touchUser(id, { name: asText(body.name, 32) });
    }

    send(res, 200, { ok: true, banned: false });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return send(res, 200, { ok: true, backend: 'offline', banned: false });
    }
    fail(res, 500, 'Could not save the heartbeat.');
  }
}

/* POST /api/call-event
 * body: { event: 'start'|'end', call_id, userA, userB, duration }
 *
 * start -> creates activeCalls/{call_id}
 * end   -> deletes the active row, appends callHistory, bumps user totals
 *
 * Idempotent enough to survive the double-fire that happens when a user taps
 * "Next person" while the peer also hangs up. */
async function endCallRecord(handle, id, body) {
  const activeRef = handle.collection('activeCalls').doc(id);
  const activeSnap = await activeRef.get();
  const active = activeSnap.exists ? activeSnap.data() : null;

  const startedAtMs = Number(body.startedAt) || (active && Number(active.startedAtMs)) || 0;
  const endMs = Date.now();
  const duration = Math.max(0, Number(body.duration) ||
    (startedAtMs ? Math.round((endMs - startedAtMs) / 1000) : 0));

  if (activeSnap.exists) await activeRef.delete();

  /* Dedupe: the FIRST `end` for a call still sees the active row, deletes it
   * and writes the history entry. Both clients post `end`, so the second one
   * finds nothing and records nothing — that is also why the per-user totals
   * below are only bumped inside this branch. */
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

  const pair = isFirstEnd ? [active.userA, active.userB] : [];
  const minutes = Math.round((duration / 60) * 10) / 10;

  for (const uid of pair) {
    if (!uid) continue;
    try {
      await touchUser(uid, {});
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

async function routeCallEvent(req, res) {
  if (!requirePost(req, res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = asText(body.call_id, 80).trim();
  if (!id) return fail(res, 400, 'call_id is required.');
  if (tooMany('ce:' + id, 40, 60000)) return fail(res, 429, 'Too many call events.');

  const event = asText(body.event, 16) || 'end';

  try {
    const handle = fs();
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

    const result = await endCallRecord(handle, id, body);
    return send(res, 200, { ok: true, duration: result.duration });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return send(res, 200, { ok: true, backend: 'offline' });
    }
    fail(res, 500, 'Could not save the call event.');
  }
}

/* POST /api/report
 * body: { reporter_id, reported_id, reported_mqtt_id, call_id, reason, note }
 *
 * Public, because a report has to be filed from inside a live call with no
 * login. Rate limited per reporter (10 per 10 minutes) and deduped server-side
 * on reporter_id + call_id. reason: abusive | spam | fake | other */
const REASONS = { abusive: 1, spam: 1, fake: 1, other: 1 };

async function routeReport(req, res) {
  if (!requirePost(req, res)) return;

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
    const result = await addReport({
      reporterId: reporterId,
      reporterName: asText(body.reporter_name, 64),
      reportedId: reportedId || reportedMqtt,
      callId: callId,
      reason: reason,
      note: note
    });

    await logAdmin('report', reportedId || reportedMqtt,
      (result.duplicate ? 'duplicate ignored, ' : '') + 'by ' + reporterId +
      ' (' + reason + ')' + (reportedMqtt ? ' mqtt:' + reportedMqtt : ''));

    return send(res, 200, {
      ok: true,
      duplicate: !!result.duplicate,
      count: result.count || 0
    });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      /* Do not lose the user's intent silently. The UI still shows its toast. */
      return send(res, 200, { ok: true, duplicate: false, backend: 'offline' });
    }
    fail(res, 500, 'Could not save the report. Please try again.');
  }
}

/* POST /api/create-invoice   body: { telegram_id }
 *
 * Creates a Telegram Stars invoice LINK for the Gender Matching unlock. The
 * Mini App then calls tg.openInvoice(link).
 *
 * Why a link instead of `sendInvoice`: a bot cannot push an invoice into a Mini
 * App session; the documented path for Stars inside a Mini App is
 * createInvoiceLink + WebApp.openInvoice. Currency MUST be "XTR" (Stars) and
 * provider_token must be an EMPTY string for Stars.
 *
 * The price is read from config/app at call time, so the admin panel can change
 * it without a redeploy. Validation of the returned payment happens in
 * /api/webhook (successful_payment) — never trust the client's "I paid". */
async function tgCall(method, payload) {
  const token = process.env.BOT_TOKEN;
  if (!token) return { ok: false, description: 'BOT_TOKEN missing' };
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: 'network' };
  }
}

async function routeCreateInvoice(req, res) {
  if (!requirePost(req, res)) return;

  if (tooMany('inv:' + clientKey(req), 10, 300000)) {
    return fail(res, 429, 'Too many attempts — please try again in a moment.');
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = asText(body.telegram_id, 64).trim();

  if (!id || !/^\d+$/.test(id)) {
    /* Stars invoices are tied to a real Telegram account. A `web_xxx` visitor
     * cannot pay, so say so plainly instead of returning a broken link. */
    return fail(res, 400, 'Stars payments only work inside Telegram. Please open the app from Telegram.');
  }

  /* Already unlocked? Do not charge twice. */
  try {
    const existing = await getUser(id);
    if (existing && (existing.paid || existing.unlocked)) {
      return send(res, 200, { ok: true, already: true, unlocked: true });
    }
  } catch (e) { /* Firestore down: fall through and let them try to pay */ }

  let price = DEFAULT_CONFIG.priceStars;
  try {
    const cfg = await getAppConfig();
    price = cfg.priceStars;
  } catch (e) { /* defaults are fine */ }

  const payload = PRODUCT + ':' + id + ':' + Date.now();

  const result = await tgCall('createInvoiceLink', {
    title: 'LinkCall — Gender Matching',
    description: 'Unlock the gender filter forever. One payment, permanent.',
    payload: payload,
    provider_token: '',                 // MUST be empty for Stars (XTR)
    currency: 'XTR',
    prices: [{ label: 'Gender Matching', amount: price }]
  });

  if (!result || !result.ok || !result.result) {
    return fail(res, 502, 'Could not create the invoice. Check BOT_TOKEN.');
  }

  send(res, 200, { ok: true, link: result.result, price: price });
}

/* POST /api/webhook — Telegram bot updates.
 *
 * Two jobs: verify the request really came from Telegram (X-Telegram-Bot-Api-
 * Secret-Token), and handle pre_checkout_query / successful_payment so the
 * Stars payment actually grants the unlock.
 *
 * IMPORTANT: the bot token is read from BOT_TOKEN and never appears in the
 * client. The webhook URL must be registered with the same secret.
 *
 * Telegram retries a failed webhook, so every branch answers 200 quickly. A
 * non-200 makes Telegram re-deliver and can double-grant the unlock. */
async function routeWebhook(req, res) {
  if (!requirePost(req, res)) return;

  /* Fail CLOSED. Without the secret anyone can POST a forged
   * `successful_payment` and grant themselves the paid unlock for free — the
   * update body is entirely attacker-controlled. A missing secret is a setup
   * error, so refuse to process anything instead of trusting the caller. */
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    return fail(res, 503, 'WEBHOOK_SECRET is not set — the webhook is disabled.');
  }
  const got = req.headers && req.headers['x-telegram-bot-api-secret-token'];
  if (!got || !sameString(String(got), secret)) {
    /* 401 is correct: Telegram sent it, but not with the right secret, which
     * means the URL leaked. Do not process the update. */
    return fail(res, 401, 'Bad secret token.');
  }

  const update = req.body && typeof req.body === 'object' ? req.body : {};

  try {
    /* --- pre-checkout: Telegram asks "may this user pay?" ---------------- */
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      if (q.invoice_payload && String(q.invoice_payload).indexOf(PRODUCT) === 0) {
        await tgCall('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: true });
      } else {
        await tgCall('answerPreCheckoutQuery', {
          pre_checkout_query_id: q.id,
          ok: false,
          error_message: 'This product is not available.'
        });
      }
      return send(res, 200, { ok: true });
    }

    /* --- successful payment: grant the unlock ---------------------------- */
    const msg = update.message;
    const payment = msg && msg.successful_payment;
    if (payment) {
      const uid = msg.from && msg.from.id ? String(msg.from.id) : '';
      const stars = Number(payment.total_amount) || 0;

      if (uid) {
        try {
          await touchUser(uid, { paid: true, unlocked: true, paidAt: Date.now(), paidStars: stars });
        } catch (e) { /* Firestore down: still answer 200 so Telegram stops retrying */ }
        try {
          await logAdmin('payment', uid, stars + ' Stars, charge ' +
            asText(payment.telegram_payment_charge_id, 80));
        } catch (e) { /* ignore */ }
        await tgCall('sendMessage', {
          chat_id: uid,
          text: '✅ Payment received! The gender filter is now unlocked for you (' + stars + ' Stars).'
        });
      }
      return send(res, 200, { ok: true });
    }

    /* --- /start: reply with the Mini App button ------------------------- */
    if (msg && msg.text && String(msg.text).indexOf('/start') === 0) {
      const url = process.env.PUBLIC_URL || '';
      if (url) {
        await tgCall('sendMessage', {
          chat_id: msg.chat.id,
          text: 'LinkCall — random audio-only chat. Tap the button below to open it.',
          reply_markup: {
            inline_keyboard: [[{ text: '🎧 Open LinkCall', web_app: { url: url } }]]
          }
        });
      }
    }

    return send(res, 200, { ok: true });
  } catch (e) {
    /* Always 200: a 5xx makes Telegram retry and can double-credit a payment. */
    return send(res, 200, { ok: true, handled: false });
  }
}

/* ========================================================== 7. admin routes */

/* POST /api/admin/login  body: { id, password }
 *
 * The password is checked HERE, server-side, against Vercel env vars only.
 * There is no hardcoded fallback anywhere in this project — if ADMIN_ID or
 * ADMIN_PASSWORD is not set, this answers 503 and admin login is simply
 * disabled. Closed is the safe failure mode for an auth endpoint. */
async function routeAdminLogin(req, res) {
  if (!requirePost(req, res)) return;

  /* A missing env var is a setup problem, not a wrong password. Name the
   * missing variable so a fresh deploy is debuggable from the login screen. */
  const problem = setupProblem();
  if (problem) return fail(res, 503, problem);

  const expected = adminCredentials();
  if (!expected) return fail(res, 503, 'Admin login is disabled: environment variables are missing.');

  /* 8 attempts per 10 minutes per IP. Generous enough for a typo, tight enough
   * to make online guessing pointless. */
  if (tooMany('login:' + clientKey(req), 8, 600000)) {
    return fail(res, 429, 'Too many login attempts. Try again in 10 minutes.');
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = asText(body.id, 64).trim();
  const password = String(body.password === undefined ? '' : body.password);

  /* A second, looser bucket keyed on the submitted id: catches an attacker who
   * rotates IPs but keeps hammering the same account name. */
  if (id && tooMany('login-id:' + id.toLowerCase(), 20, 600000)) {
    return fail(res, 429, 'Too many attempts for this ID. Wait 10 minutes.');
  }

  /* Both compares always run, so a wrong id and a wrong password take the same
   * time — the response must not reveal which half was wrong. */
  const okId = sameString(id, expected.id);
  const okPass = sameString(password, expected.password);

  if (!okId || !okPass) {
    /* Log the failure without the attempted password. */
    await logAdmin('login-failed', clientKey(req), 'admin id: ' + id.slice(0, 32));
    return fail(res, 401, 'Wrong admin ID or password.');
  }

  const token = issueToken(expected.id);
  if (!token) {
    return fail(res, 500,
      'Could not create a token — set ADMIN_PASSWORD (min ' + MIN_PASSWORD_LEN +
      ' chars) and/or ADMIN_TOKEN_SECRET.');
  }

  await logAdmin('login', expected.id, 'source: env');

  send(res, 200, {
    ok: true,
    token: token,
    tokenType: 'Bearer',
    expiresInMs: TOKEN_TTL_MS,
    mode: 'env'
  });
}

/* GET /api/admin/stats — one round-trip for the whole header strip.
 * "Today" is UTC. Documented so nobody wonders why it rolls over at an odd hour. */
async function countCollection(handle, name, limit) {
  try {
    const snap = await handle.collection(name).limit(limit || 5000).get();
    return { size: snap.size, docs: snap.docs };
  } catch (e) {
    return { size: 0, docs: [] };
  }
}

async function routeAdminStats(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    const handle = fs();

    /* Expired rows are excluded by the query itself, so the numbers are right
     * even if the TTL policy is off. The prune keeps storage tidy. */
    await pruneHeartbeats();
    const live = await listLiveHeartbeats();

    const users = await countCollection(handle, 'users', 5000);
    const calls = await countCollection(handle, 'activeCalls', 500);

    const waiting = live.filter(function (h) { return h.status === 'waiting'; }).length;
    const calling = live.filter(function (h) { return h.status === 'calling'; }).length;
    const inCall = Math.max(calling, calls.size * 2);

    const agg = await getTodayAggregates();

    /* Revenue today: sum of paidStars on users whose paidAt is today. Small app,
     * so a scan is fine; a real product would keep a daily rollup document. */
    let revenue = 0;
    const dayStartMs = startOfDay(Date.now());
    users.docs.forEach(function (doc) {
      const d = doc.data() || {};
      if (d.paid && Number(d.paidAt) >= dayStartMs) revenue += Number(d.paidStars) || 0;
    });

    const cfg = await getAppConfig();

    send(res, 200, {
      ok: true,
      totalUsers: users.size,
      onlineNow: live.length,
      waiting: waiting,
      inCall: inCall,
      callsToday: agg.callsToday,
      revenueToday: revenue,
      reportsToday: agg.reportsToday,
      paymentRequired: cfg.paymentRequired,
      priceStars: cfg.priceStars,
      channelUrl: cfg.channelUrl,
      serverTime: Date.now(),
      backend: 'live'
    });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return send(res, 200, {
        ok: false, backend: 'offline',
        totalUsers: 0, onlineNow: 0, waiting: 0, inCall: 0,
        callsToday: 0, revenueToday: 0, reportsToday: 0,
        paymentRequired: DEFAULT_CONFIG.paymentRequired,
        priceStars: DEFAULT_CONFIG.priceStars,
        channelUrl: DEFAULT_CONFIG.channelUrl,
        serverTime: Date.now(),
        error: 'Firebase is not configured (FIREBASE_SERVICE_ACCOUNT).'
      });
    }
    fail(res, 500, 'Could not load stats.');
  }
}

/* GET /api/admin/live — polled every 5 s. Both live tables plus a small map of
 * reportCount per id, so the waiting table can show "Reports" without a second
 * query per row. */
async function routeAdminLive(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    const handle = fs();

    /* Pruning first keeps "online now" honest even without a TTL policy. */
    await pruneHeartbeats();
    const live = await listLiveHeartbeats();

    const now = Date.now();
    const waiting = live
      .filter(function (h) { return h.status === 'waiting'; })
      .map(function (h) {
        return {
          id: h.id,
          name: h.name,
          gender: h.gender,
          filter: h.filter,
          waitingSec: h.since ? Math.max(0, Math.round((now - h.since) / 1000)) : 0,
          reportCount: 0
        };
      })
      .sort(function (a, b) { return b.waitingSec - a.waitingSec; });

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
        durationSec: startMs ? Math.max(0, Math.round((now - startMs) / 1000)) : 0
      };
    }).sort(function (a, b) { return b.durationSec - a.durationSec; });

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
      serverTime: now
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
}

/* GET /api/admin/users?sort=reports&order=desc&q=search&limit=200
 *
 * The user registry. Default sort is reportCount DESC — the whole point of the
 * table is "who is being reported the most". Sorting and searching happen here
 * (not in Firestore) because the sort key exists on every document but the
 * filters are ad-hoc. For a few hundred users that is instant. */
const USER_SORTS = {
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

function compareRows(a, b, key) {
  const av = a[key];
  const bv = b[key];
  if (typeof av === 'number' || typeof bv === 'number') {
    return (Number(av) || 0) - (Number(bv) || 0);
  }
  return String(av || '').localeCompare(String(bv || ''), 'en', { numeric: true });
}

async function routeAdminUsers(req, res, query) {
  if (!requireAdmin(req, res)) return;

  const q = String(query.get('q') || '').trim().toLowerCase();
  const sortRaw = String(query.get('sort') || 'reports');
  const sortKey = USER_SORTS[sortRaw] || 'reportCount';
  const order = String(query.get('order') || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  const limit = Math.min(1000, Math.max(1, Number(query.get('limit') || 300)));

  try {
    const handle = fs();
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

    rows.sort(function (a, b) { return compareRows(a, b, sortKey) * order; });

    const total = rows.length;
    rows = rows.slice(0, limit);

    send(res, 200, {
      ok: true,
      total: total,
      shown: rows.length,
      sort: sortRaw,
      order: order === 1 ? 'asc' : 'desc',
      users: rows
    });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return send(res, 200, {
        ok: false, backend: 'offline', total: 0, users: [],
        error: 'Firebase is not configured.'
      });
    }
    fail(res, 500, 'Could not load users.');
  }
}

/* GET /api/admin/user/:telegram_id — everything about one user, for the detail
 * sheet: profile, full report list (newest first) and their last calls. */
async function loadUserDetail(handle, id) {
  const user = await getUser(id);
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
    const pair = await Promise.all([
      handle.collection('callHistory').where('userA', '==', id).limit(50).get(),
      handle.collection('callHistory').where('userB', '==', id).limit(50).get()
    ]);
    const seen = {};
    pair[0].docs.concat(pair[1].docs).forEach(function (doc) {
      if (seen[doc.id]) return;
      seen[doc.id] = true;
      const d = doc.data() || {};
      const startMs = Number(d.createdAtMs) ||
        (d.startTime && d.startTime.toMillis ? d.startTime.toMillis() : 0);
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

  const partnerIds = Array.from(new Set(calls.map(function (c) { return c.partner; })
    .filter(Boolean))).slice(0, 10);
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

async function routeAdminUserDetail(req, res, rawId) {
  if (!requireAdmin(req, res)) return;

  const id = String(rawId || '').trim();
  if (!id) return fail(res, 400, 'telegram_id is required.');

  try {
    const payload = await loadUserDetail(fs(), id);
    send(res, 200, payload);
  } catch (e) {
    if (e.code === 'not_found') return fail(res, 404, 'User not found.');
    if (e.code === 'firebase_not_configured') {
      return send(res, 200, { ok: false, backend: 'offline', user: null, reports: [], calls: [] });
    }
    fail(res, 500, 'Could not load user details.');
  }
}

/* GET /api/admin/calls?before=<ms>&limit=50 — paged history, newest first. */
async function routeAdminCalls(req, res, query) {
  if (!requireAdmin(req, res)) return;

  const before = Number(query.get('before') || 0);
  const limit = Math.min(100, Math.max(1, Number(query.get('limit') || 50)));

  try {
    const handle = fs();

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
}

/* GET /api/admin/logs?limit=50 — the admin action log, newest first. */
async function routeAdminLogs(req, res, query) {
  if (!requireAdmin(req, res)) return;

  const limit = Math.min(200, Math.max(1, Number(query.get('limit') || 50)));

  try {
    const handle = fs();
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
}

/* POST /api/admin/update-settings
 * body: { paymentRequired?: boolean, priceStars?: number, channelUrl?: string }
 *
 * THE ONE WRITE PATH for everything the admin panel can change without a
 * redeploy. Fields are optional and independent: the Settings tab sends one at
 * a time so "Save price" cannot accidentally flip the payment switch.
 *
 * Validation is server-side and strict, because this is the only place a value
 * from a text box reaches every user's screen. */
async function routeAdminUpdateSettings(req, res) {
  if (!requireAdmin(req, res)) return;
  if (!requirePost(req, res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = {};
  const notes = [];

  if (body.paymentRequired !== undefined) {
    if (typeof body.paymentRequired !== 'boolean') {
      return fail(res, 400, 'paymentRequired must be true or false.');
    }
    patch.paymentRequired = body.paymentRequired;
    notes.push(body.paymentRequired ? 'paid (Stars)' : 'free');
  }

  if (body.priceStars !== undefined) {
    /* Accept a number or a numeric string only. Number(true) is 1 and Number('')
     * is 0, so a bare type check keeps nonsense from arriving as a price. */
    const rawType = typeof body.priceStars;
    if (rawType !== 'number' && rawType !== 'string') {
      return fail(res, 400, 'priceStars must be a whole number.');
    }
    const raw = Number(body.priceStars);
    if (!Number.isFinite(raw) || Math.floor(raw) !== raw) {
      return fail(res, 400, 'priceStars must be a whole number.');
    }
    if (raw < PRICE_MIN || raw > PRICE_MAX) {
      return fail(res, 400, 'priceStars must be between ' + PRICE_MIN + ' and ' + PRICE_MAX + '.');
    }
    patch.priceStars = raw;
    notes.push(raw + ' Stars');
  }

  if (body.channelUrl !== undefined) {
    /* An empty string is allowed and simply clears the button. */
    const rawUrl = String(body.channelUrl === null ? '' : body.channelUrl).trim();
    if (!rawUrl) {
      patch.channelUrl = '';
      notes.push('channel cleared');
    } else {
      const clean = safeChannelUrl(rawUrl);
      if (!clean) {
        return fail(res, 400, 'channelUrl must be a valid http(s) or t.me link.');
      }
      patch.channelUrl = clean;
      notes.push('channel ' + clean);
    }
  }

  if (!notes.length) {
    return fail(res, 400, 'Nothing to update — send paymentRequired, priceStars or channelUrl.');
  }

  try {
    await setAppConfig(patch);

    /* The legacy config/payment row stays in step so an old cached client that
     * still calls /api/payment-required sees the same answer. */
    if (patch.paymentRequired !== undefined) {
      await setPaymentRequired(patch.paymentRequired);
    }

    await logAdmin('update-settings', 'config/app', notes.join(', '));

    /* Read back, so the UI never shows a state Firestore rejected. */
    const cfg = await getAppConfig();
    send(res, 200, {
      ok: true,
      paymentRequired: cfg.paymentRequired,
      priceStars: cfg.priceStars,
      channelUrl: cfg.channelUrl
    });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return fail(res, 503, 'Firebase is not configured — the settings cannot be saved.');
    }
    fail(res, 500, 'Could not save the settings.');
  }
}

/* POST /api/admin/toggle-payment  body: { required: true|false }
 * Legacy alias for update-settings. Kept so an older cached admin page (and the
 * documented curl in Readme.txt) keeps working. */
async function routeAdminTogglePayment(req, res) {
  if (!requireAdmin(req, res)) return;
  if (!requirePost(req, res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof body.required !== 'boolean') {
    return fail(res, 400, 'required must be true or false.');
  }

  try {
    await setAppConfig({ paymentRequired: body.required });
    await setPaymentRequired(body.required);
    await logAdmin('toggle-payment', 'config/app', body.required ? 'paid (Stars)' : 'free');

    const cfg = await getAppConfig();
    send(res, 200, { ok: true, required: cfg.paymentRequired });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return fail(res, 503, 'Firebase is not configured — the toggle cannot be saved.');
    }
    fail(res, 500, 'Could not save the toggle.');
  }
}

/* POST /api/admin/user-action
 * body: { telegram_id, action, note }
 * action: ban | unban | unlock | lock | grant-paid | revoke-paid | dismiss-reports
 *
 * On ban we also delete the heartbeat (they vanish from "waiting") and any
 * active call they are in (so the live table is not stale). The banned client
 * is told on its very next heartbeat (<= 3 s): the heartbeat answers
 * `banned: true`, the client hangs up and shows the blocking screen. That
 * client's own endCall() publishes the MQTT `bye` to the partner, so the other
 * side drops immediately — no server-side MQTT client needed. */
const USER_ACTIONS = {
  ban: 1, unban: 1, unlock: 1, lock: 1,
  'grant-paid': 1, 'revoke-paid': 1, 'dismiss-reports': 1
};

async function clearActiveCalls(handle, telegramId) {
  try {
    const asA = await handle.collection('activeCalls')
      .where('userA', '==', telegramId).limit(20).get();
    const asB = await handle.collection('activeCalls')
      .where('userB', '==', telegramId).limit(20).get();
    const batch = handle.batch();
    let n = 0;
    asA.docs.concat(asB.docs).forEach(function (doc) { batch.delete(doc.ref); n += 1; });
    if (n) await batch.commit();
    return n;
  } catch (e) {
    return 0;
  }
}

async function routeAdminUserAction(req, res) {
  if (!requireAdmin(req, res)) return;
  if (!requirePost(req, res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = asText(body.telegram_id, 64).trim();
  const action = asText(body.action, 24).trim();
  const note = asText(body.note, 200);

  if (!id) return fail(res, 400, 'telegram_id is required.');
  if (!USER_ACTIONS[action]) return fail(res, 400, 'Unknown action.');

  try {
    const handle = fs();

    if (action === 'dismiss-reports') {
      await clearReports(id);
      await logAdmin('dismiss-reports', id, note || 'cleared all reports');
      return send(res, 200, { ok: true, action: action, reportCount: 0 });
    }

    const patch = await applyUserAction(id, action);

    let cleared = 0;
    if (action === 'ban') {
      await dropHeartbeat(id);
      cleared = await clearActiveCalls(handle, id);
    }

    await logAdmin(action, id,
      (note ? note + ' — ' : '') + (cleared ? 'cleared ' + cleared + ' active call(s)' : 'ok'));

    send(res, 200, {
      ok: true,
      action: action,
      banned: !!patch.banned,
      unlocked: !!patch.unlocked,
      paid: !!patch.paid
    });
  } catch (e) {
    if (e.code === 'firebase_not_configured') {
      return fail(res, 503, 'Firebase is not configured.');
    }
    fail(res, 500, 'Could not apply the action.');
  }
}

/* ================================================================ 8. router */
/* Vercel preserves the ORIGINAL url across the "/api/(.*)" -> "/api" rewrite,
 * so req.url is still "/api/admin/users?sort=reports". Never rely on req.query
 * here: for nested paths Vercel has no reason to populate it, so every route
 * gets a URL object built from req.url and reads its own params. */

function splitPath(url) {
  const raw = String(url || '/');
  const qIndex = raw.indexOf('?');
  const pathOnly = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const search = qIndex === -1 ? '' : raw.slice(qIndex);
  /* Trailing slashes must not fork the routing table. */
  const clean = pathOnly.replace(/\/+$/, '') || '/';
  return { path: clean, query: new URLSearchParams(search) };
}

/** "/api/admin/user/123" -> "123"; anything else -> ''. */
function tailAfter(path, prefix) {
  if (path.indexOf(prefix) !== 0) return '';
  const rest = path.slice(prefix.length);
  if (rest.indexOf('/') !== -1) return '';
  try {
    /* decodeURIComponent throws on a malformed escape ("%E0%A4%A"), which would
     * turn a bad URL into a 500. A garbage id is simply not a user. */
    return decodeURIComponent(rest);
  } catch (e) {
    return '';
  }
}

module.exports = async function handler(req, res) {
  let parsed;
  try {
    parsed = splitPath(req.url || '/');
  } catch (e) {
    parsed = { path: '/api', query: new URLSearchParams('') };
  }
  const path = parsed.path;
  const query = parsed.query;

  /* Bodies are read once, up front, so every route handler looks the same. */
  try {
    req.body = await readBody(req);
  } catch (e) {
    req.body = {};
  }

  const method = String(req.method || 'GET').toUpperCase();

  try {
    /* ---- public ------------------------------------------------------- */
    if (path === '/api/config') return await routeConfig(req, res);
    if (path === '/api/payment-required') return await routePaymentRequired(req, res);
    if (path === '/api/check-access') return await routeCheckAccess(req, res, query);
    if (path === '/api/heartbeat') return await routeHeartbeat(req, res);
    if (path === '/api/call-event') return await routeCallEvent(req, res);
    if (path === '/api/report') return await routeReport(req, res);
    if (path === '/api/create-invoice') return await routeCreateInvoice(req, res);
    if (path === '/api/webhook') return await routeWebhook(req, res);

    /* ---- admin -------------------------------------------------------- */
    if (path === '/api/admin/login') return await routeAdminLogin(req, res);
    if (path === '/api/admin/stats') return await routeAdminStats(req, res);
    if (path === '/api/admin/live') return await routeAdminLive(req, res);
    if (path === '/api/admin/users') return await routeAdminUsers(req, res, query);
    if (path === '/api/admin/calls') return await routeAdminCalls(req, res, query);
    if (path === '/api/admin/logs') return await routeAdminLogs(req, res, query);
    if (path === '/api/admin/update-settings') return await routeAdminUpdateSettings(req, res);
    if (path === '/api/admin/toggle-payment') return await routeAdminTogglePayment(req, res);
    if (path === '/api/admin/user-action') return await routeAdminUserAction(req, res);

    const wantedId = tailAfter(path, '/api/admin/user/');
    if (wantedId) return await routeAdminUserDetail(req, res, wantedId);

    /* Anything else under /api is a 404, not the app's index.html. */
    return fail(res, 404, 'No such endpoint: ' + method + ' ' + path);
  } catch (e) {
    /* A route that throws past its own try/catch must still answer JSON. */
    if (!res.headersSent && !res.writableEnded) {
      return fail(res, 500, 'Unexpected server error.');
    }
  }
};

/* Exported for tests / future reuse; nothing in the running app imports them. */
module.exports._internal = {
  DEFAULT_CONFIG, PRICE_MIN, PRICE_MAX, PRODUCT, HEARTBEAT_TTL_MS,
  safeChannelUrl, splitPath, tailAfter, issueToken, verifyToken, sameString,
  getAppConfig, setAppConfig
};
