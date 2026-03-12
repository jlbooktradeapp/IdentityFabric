#!/usr/bin/env node

/**
 * standardize-attributes.js
 *
 * Ensures every document in the Identities collection has every attribute
 * that exists anywhere in the collection. Missing attributes get
 * type-appropriate defaults (empty string, empty array, or false).
 *
 * Safe to run repeatedly — only updates documents that are missing fields.
 *
 * Usage:
 *   node standardize-attributes.js
 *
 * Chain after syncs:
 *   powershell ./ADSync.ps1 && node standardize-attributes.js
 *   node LNSync.js && node standardize-attributes.js
 *
 * Or call from a scheduled task to run periodically.
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const MONGO_DB = process.env.MONGO_DB || 'IdentityFabric';
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || 'Identities';

// Fields to never standardize
const EXCLUDE = new Set(['_id']);

async function run() {
  const startTime = Date.now();
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const coll = client.db(MONGO_DB).collection(MONGO_COLLECTION);

  // Phase 1: Scan all documents for the full attribute superset
  console.log('[Standardize] Scanning all documents for attribute superset...');
  const attrTypes = {};
  let totalDocs = 0;

  const scanCursor = coll.find({}, { batchSize: 5000 });
  while (await scanCursor.hasNext()) {
    const doc = await scanCursor.next();
    totalDocs++;

    for (const [k, v] of Object.entries(doc)) {
      if (EXCLUDE.has(k)) continue;
      if (!attrTypes[k]) attrTypes[k] = { array: 0, boolean: 0, number: 0, string: 0, other: 0 };

      if (Array.isArray(v)) attrTypes[k].array++;
      else if (typeof v === 'boolean') attrTypes[k].boolean++;
      else if (typeof v === 'number') attrTypes[k].number++;
      else if (typeof v === 'string') attrTypes[k].string++;
      else attrTypes[k].other++;
    }

    if (totalDocs % 25000 === 0) {
      process.stdout.write(`  Scanned ${totalDocs.toLocaleString()} documents...\r`);
    }
  }

  // Phase 2: Determine defaults
  const allAttrs = Object.keys(attrTypes).filter(k => !EXCLUDE.has(k));
  const defaults = {};
  for (const attr of allAttrs) {
    const t = attrTypes[attr];
    if (t.array > 0 && t.array >= t.string && t.array >= t.number) {
      defaults[attr] = [];
    } else if (t.boolean > 0 && t.boolean >= t.string && t.boolean >= t.number && t.boolean >= t.array) {
      defaults[attr] = false;
    } else {
      defaults[attr] = '';
    }
  }

  console.log(`\n[Standardize] ${allAttrs.length} unique attributes across ${totalDocs.toLocaleString()} documents.`);

  // Phase 3: Bulk update
  console.log('[Standardize] Applying missing attributes...');
  let documentsUpdated = 0;
  let fieldsAdded = 0;
  let docsScanned = 0;

  const BATCH_SIZE = 500;
  let bulkOps = [];

  const updateCursor = coll.find({}, { batchSize: 5000 });
  while (await updateCursor.hasNext()) {
    const doc = await updateCursor.next();
    docsScanned++;
    const docKeys = new Set(Object.keys(doc));
    const $set = {};

    for (const attr of allAttrs) {
      if (!docKeys.has(attr)) {
        $set[attr] = defaults[attr];
      }
    }

    if (Object.keys($set).length > 0) {
      bulkOps.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set },
        },
      });
      fieldsAdded += Object.keys($set).length;
    }

    if (bulkOps.length >= BATCH_SIZE) {
      const result = await coll.bulkWrite(bulkOps, { ordered: false });
      documentsUpdated += result.modifiedCount;
      bulkOps = [];
      process.stdout.write(`  Processed ${docsScanned.toLocaleString()} / ${totalDocs.toLocaleString()} docs...\r`);
    }
  }

  if (bulkOps.length > 0) {
    const result = await coll.bulkWrite(bulkOps, { ordered: false });
    documentsUpdated += result.modifiedCount;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  ATTRIBUTE STANDARDIZATION COMPLETE');
  console.log(`  Total documents:      ${totalDocs.toLocaleString()}`);
  console.log(`  Total attributes:     ${allAttrs.length}`);
  console.log(`  Documents updated:    ${documentsUpdated.toLocaleString()}`);
  console.log(`  Fields added:         ${fieldsAdded.toLocaleString()}`);
  console.log(`  Already standardized: ${(totalDocs - documentsUpdated).toLocaleString()}`);
  console.log(`  Elapsed:              ${elapsed}s`);
  console.log('═══════════════════════════════════════════════════════');

  await client.close();
}

run().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});