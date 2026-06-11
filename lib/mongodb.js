/**
 * lib/mongodb.js
 * ─────────────────────────────────────────────────────────────
 * Singleton MongoDB client for Vercel serverless functions.
 *
 * FIXES APPLIED:
 *  1. Changed ES module `import/export` → CommonJS `require/module.exports`
 */

const { MongoClient } = require('mongodb');

const uri    = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'geopram';

if (!uri) {
  throw new Error(
    'Missing environment variable: MONGODB_URI. ' +
    'Add it to your .env file or Vercel project settings.'
  );
}

let clientPromise;

if (process.env.NODE_ENV === 'development') {
  if (!global._mongoClientPromise) {
    const client = new MongoClient(uri);
    global._mongoClientPromise = client.connect();
  }
  clientPromise = global._mongoClientPromise;
} else {
  const client = new MongoClient(uri);
  clientPromise = client.connect();
}

async function getMongoClient() {
  return clientPromise;
}

async function getDb() {
  const client = await getMongoClient();
  return client.db(dbName);
}

module.exports = { getMongoClient, getDb };
