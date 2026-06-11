/**
 * api/callback.js
 * ─────────────────────────────────────────────────────────────
 * Vercel serverless function — public webhook listener for
 * Safaricom's async STK Push payment result. Persists to MongoDB.
 *
 * FIXES APPLIED:
 *  1. Changed `export default` + `import` → CommonJS `module.exports` + `require()`
 *     (Vercel Node runtime requires CommonJS unless "type":"module" is in package.json)
 *
 * POST /api/callback  (called by Safaricom servers, not the frontend)
 */

const { getDb } = require('../lib/mongodb');

// ── Helper ────────────────────────────────────────────────────
function getMetaItem(items = [], name) {
  const item = items.find((i) => i.Name === name);
  return item ? item.Value : null;
}

// ── Handler ───────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ResultCode: 1, ResultDescription: 'Method not allowed.' });
  }

  let body = req.body;

  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      console.error('[callback] Failed to parse request body as JSON.');
      return res.status(200).json({ ResultCode: 0, ResultDescription: 'Success' });
    }
  }

  const stkCallback = body?.Body?.stkCallback;

  if (!stkCallback) {
    console.error('[callback] Malformed payload — missing Body.stkCallback.');
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

  const transaction = {
    merchantRequestId: MerchantRequestID || null,
    checkoutRequestId: CheckoutRequestID || null,
    resultCode:        ResultCode,
    resultDesc:        ResultDesc,
    status:            isSuccess ? 'SUCCESS' : 'FAILED',
    createdAt:         new Date(),
  };

  if (isSuccess && CallbackMetadata?.Item) {
    const items = CallbackMetadata.Item;
    transaction.mpesaReceiptNumber = getMetaItem(items, 'MpesaReceiptNumber');
    transaction.amount             = getMetaItem(items, 'Amount');
    transaction.phoneNumber        = String(getMetaItem(items, 'PhoneNumber') || '');
    transaction.transactionDate    = getMetaItem(items, 'TransactionDate');
    transaction.balance            = getMetaItem(items, 'Balance');

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
    console.error('[callback] MongoDB write error:', dbErr.message);
  }

  return res.status(200).json({
    ResultCode:        0,
    ResultDescription: 'Success',
  });
};
