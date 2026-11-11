'use strict';
/* ---------------------------------------------------------------------------
 * Firebase Admin bootstrap — shared by every API route.
 *
 * SECURITY: the service account JSON lives ONLY in the env var
 * `FIREBASE_SERVICE_ACCOUNT`. It is never written to a file, never logged, and
 * never shipped to the browser. Firestore security rules should deny all
 * client access; the Admin SDK bypasses rules, which is exactly why the key
 * must stay server-side.
 *
 * `admin.initializeApp()` is called at most once per cold start. On a warm
 * lambda the module is reused, so the cached handle is returned instead.
 * ------------------------------------------------------------------------- */

const admin = require('firebase-admin');

let cachedApp = null;
let tried = false;

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
  if (tried) return cachedApp;
  tried = true;

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

/** Realtime Database handle, or null. Used only for optional mirroring. */
function rtdb() {
  const app = getApp();
  if (!app || !process.env.FIREBASE_DATABASE_URL) return null;
  try {
    return admin.database(app);
  } catch (e) {
    return null;
  }
}

const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

/* ---------------------------------------------------------------- helpers */

/** Firestore does not keep array order, so we stamp every report ourselves. */
function nowMs() { return Date.now(); }

/** Start of the current UTC day. Deliberately UTC so the number is stable and
 *  does not jump around with per-instance timezones. */
function startOfDay(ms) {
  const d = new Date(ms || Date.now());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : (fallback || 0);
}

function asText(value, max) {
  return String(value === undefined || value === null ? '' : value).slice(0, max || 200);
}

/** Every API route answers JSON, and never leaks a stack trace. */
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
  // Vercel parses application/json into req.body automatically.
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string' && req.body) {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise(function (resolve) {
    let raw = '';
    req.on('data', function (chunk) {
      raw += chunk;
      if (raw.length > 200000) req.destroy();   // hard cap: 200 KB
    });
    req.on('end', function () {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); }
    });
    req.on('error', function () { resolve({}); });
  });
}

module.exports = {
  admin, db, rtdb, getApp,
  FieldValue, Timestamp,
  nowMs, startOfDay, asNumber, asText, send, fail, readBody
};
