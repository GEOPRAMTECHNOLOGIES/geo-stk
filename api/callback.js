/**
 * api/callback.js
 * ─────────────────────────────────────────────────────────────
 * Vercel serverless function — public webhook that receives
 * Safaricom's asynchronous STK Push payment result and
 * persists the transaction to MongoDB.
 *
 * POST /api/callback  (called by Safaricom servers, not the frontend)
 */

import { getDb } from '../lib/mongodb.js';

// ── Helpers ───────────────────────────────────────────────────

/**
 * Safely pulls a value from the CallbackMetadata.Item array by name.
 * @param {Array}  items  - stkCallback.CallbackMetadata.Item
 * @param {string} name   - e.g. "MpesaReceiptNumber"
 * @returns {string|number|null}
 */
function getMetaItem(items = [], name) {
  const item = items.find((i) => i.Name === name);
  return item ? item.Value : null;
}

// ── Handler ───────────────────────────────────────────────────

export default async function handler(req, res) {
  // Safaricom always POSTs; reject anything else quietly.
  if (req.method !== 'POST') {
    return res.status(405).json({ ResultCode: 1, ResultDescription: 'Method not allowed.' });
  }

  let body = req.body;

  // Vercel parses JSON automatically; guard against edge cases.
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      console.error('[callback] Failed to parse request body as JSON.');
      return res.status(200).json({ ResultCode: 0, ResultDescription: 'Success' });
    }
  }

  // ── Extract stkCallback ─────────────────────────────────────
  const stkCallback = body?.Body?.stkCallback;

  if (!stkCallback) {
    console.error('[callback] Malformed payload — missing Body.stkCallback.');
    // Still return 200 so Safaricom does not retry endlessly.
    return res.status(200).json({ ResultCode: 0, ResultDescription: 'Success' });
  }

  const {
    MerchantRequestID,
    CheckoutRequestID,
    ResultCode,
    ResultDesc,
    CallbackMetadata,
  } = stkCallback;

  const isSuccess = ResultCode === 0;

  // ── Build transaction record ────────────────────────────────
  const transaction = {
    merchantRequestId:  MerchantRequestID  || null,
    checkoutRequestId:  CheckoutRequestID  || null,
    resultCode:         ResultCode,
    resultDesc:         ResultDesc,
    status:             isSuccess ? 'SUCCESS' : 'FAILED',
    createdAt:          new Date(),
  };

  if (isSuccess && CallbackMetadata?.Item) {
    const items = CallbackMetadata.Item;

    transaction.mpesaReceiptNumber = getMetaItem(items, 'MpesaReceiptNumber');
    transaction.amount             = getMetaItem(items, 'Amount');
    transaction.phoneNumber        = String(getMetaItem(items, 'PhoneNumber') || '');
    transaction.transactionDate    = getMetaItem(items, 'TransactionDate');
    transaction.balance            = getMetaItem(items, 'Balance');   // may be null

    console.log(
      `[callback] ✅ PAYMENT SUCCESS` +
      ` | Receipt: ${transaction.mpesaReceiptNumber}` +
      ` | Amount: KES ${transaction.amount}` +
      ` | Phone: ${transaction.phoneNumber}` +
      ` | Date: ${transaction.transactionDate}` +
      ` | CheckoutID: ${CheckoutRequestID}`
    );
  } else {
    console.warn(
      `[callback] ❌ PAYMENT FAILED` +
      ` | Code: ${ResultCode}` +
      ` | Desc: ${ResultDesc}` +
      ` | CheckoutID: ${CheckoutRequestID}`
    );
  }

  // ── Persist to MongoDB ──────────────────────────────────────
  try {
    const db         = await getDb();
    const collection = db.collection('transactions');

    // Upsert by CheckoutRequestID so duplicate callbacks don't create duplicates.
    const result = await collection.updateOne(
      { checkoutRequestId: CheckoutRequestID },
      {
        $set:         transaction,
        $setOnInsert: { firstSeenAt: new Date() },
      },
      { upsert: true }
    );

    console.log(
      `[callback] MongoDB upsert — matched: ${result.matchedCount}, ` +
      `modified: ${result.modifiedCount}, upserted: ${result.upsertedCount}`
    );
  } catch (dbErr) {
    // Log but do NOT return an error to Safaricom — they would retry infinitely.
    console.error('[callback] MongoDB write error:', dbErr.message);
  }

  // ── Acknowledge to Safaricom ────────────────────────────────
  // Must always be 200 with this exact shape, or Safaricom retries.
  return res.status(200).json({
    ResultCode:        0,
    ResultDescription: 'Success',
  });
}
