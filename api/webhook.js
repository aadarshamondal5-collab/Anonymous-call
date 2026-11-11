'use strict';
/* POST /api/webhook  — Telegram bot updates
 *
 * Two jobs:
 *   1) Verify the request really came from Telegram
 *      (X-Telegram-Bot-Api-Secret-Token header).
 *   2) Handle `pre_checkout_query` and `successful_payment` so the Stars payment
 *      for Gender Matching actually grants the unlocked flag.
 *
 * IMPORTANT: the bot token is read from BOT_TOKEN and never appears in the
 * client. The webhook URL must be registered with the same secret:
 *
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *        -d "url=https://YOUR-APP.vercel.app/api/webhook" \
 *        -d "secret_token=<WEBHOOK_SECRET>"
 *
 * Telegram retries a failed webhook, so every branch answers 200 quickly. A
 * non-200 makes Telegram re-deliver and can double-grant the unlock.
 */

const { send, fail, asText } = require('./_lib/fb');
const store = require('./_lib/store');
const { sameString } = require('./_lib/auth');

const PRICE_STARS = 50;
const PRODUCT = 'gender_filter';

/** Constant-time compare, so the secret cannot be guessed by timing. */
function safeEqual(a, b) {
  return sameString(a, b);
}

async function tgCall(method, payload) {
  const token = process.env.BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json().catch(function () { return null; });
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    return fail(res, 405, 'POST only.');
  }

  /* --- authenticity ------------------------------------------------------ */
  /* Fail CLOSED. Without the secret anyone can POST a forged
   * `successful_payment` and grant themselves the paid unlock for free — the
   * update body is entirely attacker-controlled. A missing secret is a setup
   * error, so we refuse to process anything instead of trusting the caller. */
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    return fail(res, 503, 'WEBHOOK_SECRET is not set — the webhook is disabled.');
  }
  const got = req.headers['x-telegram-bot-api-secret-token'];
  if (!got || !safeEqual(String(got), secret)) {
    /* 401 is correct here: Telegram sent it, but not with the right secret,
     * which means the URL leaked. Do not process the update. */
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
          await store.touchUser(uid, { paid: true, unlocked: true, paidAt: Date.now(), paidStars: stars });
        } catch (e) { /* Firestore down: still answer 200 so TG stops retrying */ }
        try {
          await store.logAdmin('payment', uid, stars + ' Stars, charge ' + asText(payment.telegram_payment_charge_id, 80));
        } catch (e) { /* ignore */ }
      }

      /* Best-effort receipt. A failed call here must not fail the webhook. */
      if (uid) {
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
};
