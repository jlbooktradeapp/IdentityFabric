/**
 * MongoDB Service â€” manages connection, provides query helpers for the Identities collection.
 */
const { MongoClient } = require('mongodb');
const config = require('../config');
const logger = require('../config/logger');

let client = null;
let db = null;
let collection = null;

/**
 * Connect to MongoDB and cache the client, db, and collection references.
 */
async function connect() {
  if (client) return { client, db, collection };

  logger.info(`Connecting to MongoDB at ${config.mongo.uri}...`);
  client = new MongoClient(config.mongo.uri, {
    maxPoolSize: 20,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  await client.connect();
  db = client.db(config.mongo.database);
  collection = db.collection(config.mongo.collection);

  // Verify connectivity
  await db.command({ ping: 1 });
  const count = await collection.estimatedDocumentCount();
  logger.info(`MongoDB connected. Collection "${config.mongo.collection}" has ~${count} documents.`);

  return { client, db, collection };
}

/**
 * Get the Identities collection (connects if needed).
 */
async function getCollection() {
  if (!collection) await connect();
  return collection;
}

/**
 * Get the database reference.
 */
async function getDb() {
  if (!db) await connect();
  return db;
}

/**
 * Test connectivity â€” throws on failure.
 */
async function testConnection() {
  const { db } = await connect();
  const result = await db.command({ ping: 1 });
  return result;
}

/**
 * Get collection stats.
 * Optimized for large collections â€” avoids collStats command and $ne scans.
 */
async function getStats() {
  const coll = await getCollection();

  const [totalDocs, terminatedDocs, sources, latestADSync, latestLNSync] = await Promise.all([
    // estimatedDocumentCount reads from metadata â€” instant, no collection scan
    coll.estimatedDocumentCount(),
    // Positive match on indexed field â€” fast
    coll.countDocuments({ terminated: true }),
    // Uses _sources index
    coll.distinct('_sources'),
    // Latest AD sync timestamp
    coll.findOne(
      { '_lastUpdated.ActiveDirectory': { $exists: true } },
      { sort: { '_lastUpdated.ActiveDirectory': -1 }, projection: { '_lastUpdated.ActiveDirectory': 1 } }
    ),
    // Latest LexisNexis sync timestamp
    coll.findOne(
      { '_lastUpdated.LexisNexis': { $exists: true } },
      { sort: { '_lastUpdated.LexisNexis': -1 }, projection: { '_lastUpdated.LexisNexis': 1 } }
    ),
  ]);

  // Derive active count from total - terminated (avoids a $ne scan)
  const activeDocs = totalDocs - terminatedDocs;

  return {
    totalDocuments: totalDocs,
    activeUsers: activeDocs,
    terminatedUsers: terminatedDocs,
    sources,
    lastSyncTime: latestADSync?._lastUpdated?.ActiveDirectory || null,
    lastLexisNexisSyncTime: latestLNSync?._lastUpdated?.LexisNexis || null,
  };
}

/**
 * Search users with flexible criteria.
 */
async function searchUsers(query, options = {}) {
  const coll = await getCollection();
  const {
    page = 1,
    limit = 50,
    sort = { displayname: 1 },
    projection = null,
    includeTerminated = false,
    extraFilter = {},
  } = options;

  const filter = { ...query, ...extraFilter };
  if (!includeTerminated) {
    filter.terminated = { $ne: true };
  }

  // limit=0 means "all records" (used by CSV export)
  const effectiveLimit = parseInt(limit) || 0;

  let cursor = coll.find(filter, { projection }).sort(sort);
  if (effectiveLimit > 0) {
    const skip = (page - 1) * effectiveLimit;
    cursor = cursor.skip(skip).limit(effectiveLimit);
  }

  const [results, total] = await Promise.all([
    cursor.toArray(),
    coll.countDocuments(filter),
  ]);

  return {
    results,
    total,
    page: effectiveLimit > 0 ? page : 1,
    limit: effectiveLimit || total,
    totalPages: effectiveLimit > 0 ? Math.ceil(total / effectiveLimit) : 1,
  };
}

/**
 * Get a single user by _id (objectGUID).
 */
async function getUserById(id) {
  const coll = await getCollection();
  return coll.findOne({ _id: id });
}

/**
 * Flexible text search across multiple fields.
 */
async function textSearch(searchTerm, options = {}) {
  const coll = await getCollection();
  const { page = 1, limit = 50, includeTerminated = false, extraFilter = {} } = options;

  // Build regex for partial matching across common identity fields
  const regex = { $regex: searchTerm, $options: 'i' };

  const filter = {
    ...extraFilter,
    $or: [
      { samaccountname: regex },
      { displayname: regex },
      { mail: regex },
      { userprincipalname: regex },
      { employeeid: regex },
      { givenname: regex },
      { sn: regex },
      { department: regex },
      { title: regex },
      { cn: regex },
      // LexisNexis provider fields
      { LAST_NAME_PRA: regex },
      { FIRST_NAME_PRA: regex },
      { npi: regex },
    ],
  };

  if (!includeTerminated) {
    filter.terminated = { $ne: true };
  }

  const skip = (page - 1) * limit;

  const [results, total] = await Promise.all([
    coll.find(filter)
        .sort({ displayname: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
    coll.countDocuments(filter),
  ]);

  return { results, total, page, limit, totalPages: Math.ceil(total / limit) };
}

/**
 * Run a MongoDB aggregation pipeline.
 */
async function aggregate(pipeline) {
  const coll = await getCollection();
  return coll.aggregate(pipeline, { allowDiskUse: true }).toArray();
}

/**
 * Get all field names from the collection by sampling documents.
 * Returns sorted array of field name strings, excluding internal fields.
 */
async function getFieldNames(filter = {}) {
  const coll = await getCollection();

  // Use $sample for random coverage across both AD and LexisNexis documents
  const pipeline = [];
  if (Object.keys(filter).length) pipeline.push({ $match: filter });
  pipeline.push({ $sample: { size: 100 } });

  const samples = await coll.aggregate(pipeline).toArray();
  const fieldSet = new Set();

  for (const doc of samples) {
    for (const key of Object.keys(doc)) {
      if (key === '_id' || key === '_lastUpdated' || key === '_lastSeenBy' || key === '_meta' || key.startsWith('_meta.')) continue;
      fieldSet.add(key);
    }
  }

  return [...fieldSet].sort();
}

/**
 * Get distinct values for a field.
 */
async function getDistinctValues(field, filter = {}) {
  const coll = await getCollection();
  return coll.distinct(field, filter);
}

/**
 * Graceful shutdown.
 */
async function disconnect() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    collection = null;
    logger.info('MongoDB disconnected.');
  }
}

module.exports = {
  connect,
  getCollection,
  getDb,
  testConnection,
  getStats,
  searchUsers,
  getUserById,
  textSearch,
  aggregate,
  getDistinctValues,
  getFieldNames,
  disconnect,
  getCustomReportsCollection,
  getReportSchedulesCollection,
  getFabricUsersCollection,
  getAttributeLabelsCollection,
  getFabricRolesCollection,
};

/**
 * Get the custom_reports collection (creates index on first access).
 */
let customReportsCol = null;
async function getCustomReportsCollection() {
  if (customReportsCol) return customReportsCol;
  const database = await getDb();
  customReportsCol = database.collection('custom_reports');
  await customReportsCol.createIndex({ username: 1 });
  await customReportsCol.createIndex({ username: 1, createdAt: -1 });
  await customReportsCol.createIndex({ shared: 1 });
  return customReportsCol;
}

/**
 * Get the report_schedules collection (creates index on first access).
 */
let reportSchedulesCol = null;
async function getReportSchedulesCollection() {
  if (reportSchedulesCol) return reportSchedulesCol;
  const database = await getDb();
  reportSchedulesCol = database.collection('report_schedules');
  await reportSchedulesCol.createIndex({ createdBy: 1 });
  await reportSchedulesCol.createIndex({ enabled: 1, schedule: 1 });
  return reportSchedulesCol;
}

/**
 * Get the _fabricUsers collection â€” internal user accounts.
 * SSO logins JIT-provision into this collection; local accounts live here too.
 */
let fabricUsersCol = null;
async function getFabricUsersCollection() {
  if (fabricUsersCol) return fabricUsersCol;
  const database = await getDb();
  fabricUsersCol = database.collection('_fabricUsers');
  await fabricUsersCol.createIndex({ username: 1 }, { unique: true });
  await fabricUsersCol.createIndex({ email: 1 });
  await fabricUsersCol.createIndex({ role: 1 });
  await fabricUsersCol.createIndex({ enabled: 1 });
  return fabricUsersCol;
}
/**
 * Get the attribute_labels collection for managing friendly display names.
 */
let attributeLabelsCol = null;
async function getAttributeLabelsCollection() {
  if (attributeLabelsCol) return attributeLabelsCol;
  const database = await getDb();
  attributeLabelsCol = database.collection('attribute_labels');
  return attributeLabelsCol;
}

/**
 * Get the fabric_roles collection for RBAC role definitions.
 */
let fabricRolesCol = null;
async function getFabricRolesCollection() {
  if (fabricRolesCol) return fabricRolesCol;
  const database = await getDb();
  fabricRolesCol = database.collection('fabric_roles');
  await fabricRolesCol.createIndex({ name: 1 }, { unique: true });
  return fabricRolesCol;
}