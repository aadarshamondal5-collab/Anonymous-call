'use strict';
/* POST /api/create-invoice   body: { telegram_id }
 *
 * Creates a Telegram Stars invoice LINK for the Gender Matching unlock, and
 * returns it. The Mini App then calls tg.openInvoice(link).
 *
 * Why a link instead of `sendInvoice`: a bot cannot push an invoice into a Mini
 * App session; the documented path for Stars inside a Mini App is
 * createInvoiceLink + WebApp.openInvoice. Currency MUST be "XTR" (Stars) and
 * provider_token must be an EMPTY string for Stars.
 *
 * Validation of the returned payment happens in /api/webhook
 * (successful_payment) — never trust the client's "I paid" message.
 */

const { send, fail, asText } = require('./_lib/fb');
const store = require('./_lib/store');
const { tooMany, clientKey } = require('./_lib/ratelimit');

const PRICE_STARS = 50;
const PRODUCT = 'gender_filter';

async function tgCall(method, payload) {
  const token = process.env.BOT_TOKEN;
  if (!token) return { ok: false, description: 'BOT_TOKEN missing' };
  try {
    const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    return { ok: false, description: 'network' };
  }
}

module.exports = async function handler(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    return fail(res, 405, 'POST only.');
  }
  if (tooMany('inv:' + clientKey(req), 10, 300000)) {
    return fail(res, 429, 'Too many attempts — please try again in a moment.');
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = asText(body.telegram_id, 64).trim();

  if (!id || !/^\d+$/.test(id)) {
    /* Stars invoices are tied to a real Telegram account. A `web_xxx` visitor
     * cannot pay, so tell them plainly instead of returning a broken link. */
    return fail(res, 400, 'Stars payments only work inside Telegram. Please open the app from Telegram.');
  }

  /* Already unlocked? Do not charge twice. */
  try {
    const existing = await store.getUser(id);
    if (existing && (existing.paid || existing.unlocked)) {
      return send(res, 200, { ok: true, already: true, unlocked: true });
    }
  } catch (e) { /* Firestore down: fall through and let them try to pay */ }

  const payload = PRODUCT + ':' + id + ':' + Date.now();

  const result = await tgCall('createInvoiceLink', {
    title: 'LinkCall — Gender Matching',
    description: 'Unlock the gender filter forever. One payment, permanent.',
    payload: payload,
    provider_token: '',                 // MUST be empty for Stars (XTR)
    currency: 'XTR',
    prices: [{ label: 'Gender Matching', amount: PRICE_STARS }]
  });

  if (!result || !result.ok || !result.result) {
    return fail(res, 502, 'Could not create the invoice. Check BOT_TOKEN.');
  }

  send(res, 200, { ok: true, link: result.result, price: PRICE_STARS });
};
