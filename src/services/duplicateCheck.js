/**
 * duplicateCheck.js
 * Identity Fabric — Duplicate Identity Detection Service
 *
 * Scans the entire Identities collection and flags records where a non-empty
 * otherMailbox (personal email) OR otherMobile (personal phone) value appears
 * on more than one document. All matching documents — regardless of their
 * InternalExternal classification — are set { Duplicate: true }. All others
 * are set { Duplicate: false }.
 *
 * Blank / null values are excluded from matching: a missing personal email or
 * phone is a data-completeness problem, not a duplicate-identity problem, and
 * should be surfaced via a separate report rather than conflated with this flag.
 *
 * Called by:
 *   - scheduler.js  (automatic, configurable interval)
 *   - api.js        (manual admin trigger via POST /api/admin/run-duplicate-check)
 */

'use strict';

const mongo  = require('./mongo');
const logger = require('../config/logger');

// ── Field name constants ─────────────────────────────────────────────────────
const FIELD_EMAIL = 'othermailbox';   // AD: personal / alternate email (lowercase — ADSync stores all LDAP names lowercase)
const FIELD_PHONE = 'othermobile';    // AD: personal / alternate phone (lowercase — ADSync stores all LDAP names lowercase)
const FIELD_FLAG  = 'Duplicate';

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasValue(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

function normaliseEmail(v) {
  return String(v).trim().toLowerCase();
}

function normalisePhone(v) {
  // Strip all non-digit characters so formatting differences don't prevent matches
  return String(v).replace(/\D/g, '');
}

// ── Core logic ───────────────────────────────────────────────────────────────

/**
 * Run the full duplicate-detection pass.
 * Returns a summary: { checked, duplicates, duration, timestamp }
 */
async function checkDuplicates() {
  const start = Date.now();
  logger.info('[DuplicateCheck] Starting duplicate identity scan...');

  const col = await mongo.getCollection();

  // Fetch only the fields we need — keep memory footprint small
  const allDocs = await col
    .find({}, { projection: { _id: 1, [FIELD_EMAIL]: 1, [FIELD_PHONE]: 1 } })
    .toArray();

  const totalDocs = allDocs.length;
  logger.info(`[DuplicateCheck] Loaded ${totalDocs} identity documents.`);

  // ── Build frequency maps ─────────────────────────────────────────────────
  // normalisedValue → Set of _id strings
  const emailMap = new Map();
  const phoneMap = new Map();

  for (const doc of allDocs) {
    const id = String(doc._id);

    if (hasValue(doc[FIELD_EMAIL])) {
      const key = normaliseEmail(doc[FIELD_EMAIL]);
      if (!emailMap.has(key)) emailMap.set(key, new Set());
      emailMap.get(key).add(id);
    }

    if (hasValue(doc[FIELD_PHONE])) {
      const key = normalisePhone(doc[FIELD_PHONE]);
      if (key.length > 0) {
        if (!phoneMap.has(key)) phoneMap.set(key, new Set());
        phoneMap.get(key).add(id);
      }
    }
  }

  // ── Collect duplicate IDs ────────────────────────────────────────────────
  const duplicateIds = new Set();

  for (const [, ids] of emailMap) {
    if (ids.size > 1) ids.forEach(id => duplicateIds.add(id));
  }
  for (const [, ids] of phoneMap) {
    if (ids.size > 1) ids.forEach(id => duplicateIds.add(id));
  }

  logger.info(`[DuplicateCheck] ${duplicateIds.size} documents identified as duplicates.`);

  // ── Bulk-write the Duplicate flag ────────────────────────────────────────
  // Two updateMany calls: one for duplicates, one to clear the flag on clean records.
  // Using _id arrays keeps both operations index-bound and avoids full scans.
  const duplicateIdList = [...duplicateIds];
  const cleanIdList     = allDocs
    .map(d => d._id)
    .filter(id => !duplicateIds.has(String(id)));

  const bulkOps = [];

  if (duplicateIdList.length > 0) {
    bulkOps.push({
      updateMany: {
        filter: { _id: { $in: duplicateIdList } },
        update: { $set: { [FIELD_FLAG]: true } },
      },
    });
  }

  if (cleanIdList.length > 0) {
    bulkOps.push({
      updateMany: {
        filter: { _id: { $in: cleanIdList } },
        update: { $set: { [FIELD_FLAG]: false } },
      },
    });
  }

  if (bulkOps.length > 0) {
    await col.bulkWrite(bulkOps, { ordered: false });
  }

  const duration = ((Date.now() - start) / 1000).toFixed(2);
  const summary  = {
    checked:    totalDocs,
    duplicates: duplicateIds.size,
    duration:   `${duration}s`,
    timestamp:  new Date().toISOString(),
  };

  logger.info(`[DuplicateCheck] Complete — ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { checkDuplicates };