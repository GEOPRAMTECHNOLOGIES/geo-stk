/**
 * api/stk_push.js
 * ─────────────────────────────────────────────────────────────
 * Vercel serverless function — initiates a Safaricom Lipa Na
 * M-Pesa STK Push (PIN pop-up) on the customer's handset.
 *
 * POST /api/stk_push
 * Body: { phone: "2547XXXXXXXX", amount: "100" }
 */

// ── Environment ───────────────────────────────────────────────
const CONSUMER_KEY    = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const PASSKEY         = process.env.MPESA_PASSKEY;
const SHORTCODE       = process.env.MPESA_SHORTCODE || '4574727';
const TILL            = process.env.MPESA_TILL      || '5367886';
const MPESA_ENV       = process.env.MPESA_ENV       || 'sandbox';

// Daraja base URLs
const BASE_URL =
  MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

// ── Helpers ───────────────────────────────────────────────────

/**
 * Fetches a short-lived OAuth bearer token from Safaricom.
 * @returns {Promise<string>} access_token
 */
async function getAccessToken() {
  const credentials = Buffer.from(
    `${CONSUMER_KEY}:${CONSUMER_SECRET}`
  ).toString('base64');

  const res = await fetch(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      method: 'GET',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  if (!data.access_token) {
    throw new Error('No access_token in Safaricom OAuth response.');
  }

  return data.access_token;
}

/**
 * Generates a 14-digit EAT timestamp: YYYYMMDDHHmmss
 * @returns {string}
 */
function getEATTimestamp() {
  // EAT = UTC+3
  const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');

  const YYYY = now.getUTCFullYear();
  const MM   = pad(now.getUTCMonth() + 1);
  const DD   = pad(now.getUTCDate());
  const HH   = pad(now.getUTCHours());
  const mm   = pad(now.getUTCMinutes());
  const ss   = pad(now.getUTCSeconds());

  return `${YYYY}${MM}${DD}${HH}${mm}${ss}`;
}

// ── Handler ───────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS pre-flight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed.' });
  }

  // ── Validate env vars ───────────────────────────────────────
  if (!CONSUMER_KEY || !CONSUMER_SECRET || !PASSKEY) {
    console.error('[stk_push] Missing required environment variables.');
    return res.status(500).json({
      success: false,
      message: 'Server misconfiguration: M-Pesa credentials not set.',
    });
  }

  // ── Parse & validate body ───────────────────────────────────
  const { phone, amount } = req.body || {};

  if (!phone || !amount) {
    return res.status(400).json({
      success: false,
      message: 'Both "phone" and "amount" are required.',
    });
  }

  const parsedAmount = parseInt(amount, 10);
  if (isNaN(parsedAmount) || parsedAmount < 1) {
    return res.status(400).json({
      success: false,
      message: 'Amount must be a positive integer (minimum KES 1).',
    });
  }

  // Validate phone is in 2547XXXXXXXX or 2541XXXXXXXX format
  if (!/^254[71]\d{8}$/.test(phone)) {
    return res.status(400).json({
      success: false,
      message: 'Phone must be in international format: 2547XXXXXXXX or 2541XXXXXXXX.',
    });
  }

  // ── STK Push ────────────────────────────────────────────────
  try {
    const accessToken = await getAccessToken();
    const timestamp   = getEATTimestamp();
    const password    = Buffer.from(
      `${SHORTCODE}${PASSKEY}${timestamp}`
    ).toString('base64');

    const callbackURL = `https://${req.headers.host}/api/callback`;

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   'CustomerBuyGoodsOnline',
      Amount:            parsedAmount,
      PartyA:            phone,
      PartyB:            TILL,
      PhoneNumber:       phone,
      CallBackURL:       callbackURL,
      AccountReference:  'Geopram',
      TransactionDesc:   'Geopram Payment',
    };

    console.log(`[stk_push] Initiating STK Push → phone=${phone}, amount=${parsedAmount}, env=${MPESA_ENV}`);

    const stkRes = await fetch(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        method:  'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );

    const stkData = await stkRes.json();

    if (!stkRes.ok || stkData.ResponseCode !== '0') {
      console.error('[stk_push] Daraja error:', JSON.stringify(stkData));
      return res.status(502).json({
        success: false,
        message:
          stkData.errorMessage ||
          stkData.ResponseDescription ||
          'STK Push request failed. Please try again.',
        daraja: stkData,
      });
    }

    console.log(`[stk_push] STK Push sent. CheckoutRequestID=${stkData.CheckoutRequestID}`);

    return res.status(200).json({
      success:            true,
      message:            'STK Push sent. Check your phone and enter your M-Pesa PIN.',
      checkoutRequestId:  stkData.CheckoutRequestID,
      merchantRequestId:  stkData.MerchantRequestID,
      responseDescription: stkData.CustomerMessage || stkData.ResponseDescription,
    });

  } catch (err) {
    console.error('[stk_push] Unexpected error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'An internal error occurred. Please try again later.',
    });
  }
}
