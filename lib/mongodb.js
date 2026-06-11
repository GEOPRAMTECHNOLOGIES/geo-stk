/**
 * lib/mongodb.js
 * ─────────────────────────────────────────────────────────────
 * Singleton MongoDB client for Vercel serverless functions.
 * Reuses the connection across warm invocations to avoid
 * exhausting the Atlas connection pool.
 */

import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'geopram';

if (!uri) {
  throw new Error(
    'Missing environment variable: MONGODB_URI. ' +
    'Add it to your .env file or Vercel project settings.'
  );
}

let client;
let clientPromise;

if (process.env.NODE_ENV === 'development') {
  // In dev, use a module-level cache to preserve the connection
  // across Hot Module Replacement reloads.
  if (!global._mongoClientPromise) {
    client = new MongoClient(uri);
    global._mongoClientPromise = client.connect();
  }
  clientPromise = global._mongoClientPromise;
} else {
  // In production each serverless function instance manages its own client.
  client = new MongoClient(uri);
  clientPromise = client.connect();
}

/**
 * Returns the connected MongoClient instance.
 * @returns {Promise<MongoClient>}
 */
export async function getMongoClient() {
  return clientPromise;
}

/**
 * Returns a handle to the Geopram database.
 * @returns {Promise<import('mongodb').Db>}
 */
export async function getDb() {
  const client = await getMongoClient();
  return client.db(dbName);
}

export default clientPromise;
