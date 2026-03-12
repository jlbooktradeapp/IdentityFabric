/**
 * Core API routes — search, user detail, reports, export, custom queries.
 */
const express = require('express');
const router = express.Router();
const mongo = require('../services/mongo');
const reports = require('../services/reports');
const { requireAuth, requireRole } = require('../middleware/auth');
const logger = require('../config/logger');

// ── Helper: Validate document ID format ───────────────────────────────────────
// IDs come from multiple sources: AD objectGUIDs (base64), LexisNexis (LN_*),
// MongoDB ObjectIds (24 hex), UUIDs, etc. Validate for safety without restricting format.
function isValidDocumentId(id) {
  if (!id || typeof id !== 'string') return false;
  if (id.length > 200) return false;
  // Allow alphanumeric, plus common ID characters: - _ + / = . @
  // Block anything that could be injection: spaces, quotes, braces, angle brackets, $
  return /^[A-Za-z0-9_\-+/=.@]+$/.test(id);
}

// All API routes require authentication
router.use(requireAuth);

// Validate ID format on any route with :id parameter
router.param('id', (req, res, next, value) => {
  if (!isValidDocumentId(value)) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }
  next();
});

// ── RBAC: Role-Based Access Control ─────────────────────────────────────────

// System/meta fields every user can always see (these aren't sensitive identity data)
const RBAC_SYSTEM_FIELDS = new Set([
  '_id', 'terminated', '_terminatedAt', '_terminatedReason', 'InternalExternal',
]);

// Default fields for users with no assigned role (basic directory info)
const RBAC_DEFAULT_FIELDS = [
  'displayname', 'samaccountname', 'mail', 'department', 'title',
  'employeeid', 'company', 'physicaldeliveryofficename', 'telephonenumber',
  'manager', 'givenname', 'sn', 'userprincipalname', 'whencreated',
];

/**
 * Load effective RBAC permissions for the current user.
 * Returns null for admins (unrestricted).
 * Caches on session to avoid repeated DB lookups.
 */
async function getUserPermissions(req) {
  if (req.user.roles && req.user.roles.includes('admin')) return null;

  // Session cache (cleared on role change)
  if (req.session._rbacPerms !== undefined) return req.session._rbacPerms;

  try {
    const col = await mongo.getFabricUsersCollection();
    const fabricUser = await col.findOne({ username: req.user.username });

    if (!fabricUser || !fabricUser.fabricRoleId) {
      // No role assigned — restrictive defaults
      const perms = {
        attributes: RBAC_DEFAULT_FIELDS,
        sources: [],
        reports: { builtIn: [], customReports: true, customQueries: false },
      };
      req.session._rbacPerms = perms;
      return perms;
    }

    const { ObjectId } = require('mongodb');
    const rolesCol = await mongo.getFabricRolesCollection();
    let role = null;
    try {
      role = await rolesCol.findOne({ _id: new ObjectId(fabricUser.fabricRoleId) });
    } catch { /* invalid ObjectId */ }

    if (!role || !role.permissions) {
      const perms = {
        attributes: RBAC_DEFAULT_FIELDS,
        sources: [],
        reports: { builtIn: [], customReports: true, customQueries: false },
      };
      req.session._rbacPerms = perms;
      return perms;
    }

    req.session._rbacPerms = role.permissions;
    return role.permissions;
  } catch (err) {
    logger.error(`RBAC load error: ${err.message}`);
    const perms = {
      attributes: RBAC_DEFAULT_FIELDS,
      sources: [],
      reports: { builtIn: [], customReports: true, customQueries: false },
    };
    return perms;
  }
}

/**
 * Strip restricted fields from a single document.
 * If permissions is null (admin) or attributes is empty, returns doc unchanged.
 */
function filterDocFields(doc, perms) {
  if (!perms || !perms.attributes || perms.attributes.length === 0) return doc;
  const allowed = new Set([...RBAC_SYSTEM_FIELDS, ...perms.attributes]);
  const out = {};
  for (const key of Object.keys(doc)) {
    if (allowed.has(key)) out[key] = doc[key];
  }
  return out;
}

/**
 * Strip restricted fields from an array of documents.
 */
function filterResultFields(results, perms) {
  if (!perms || !perms.attributes || perms.attributes.length === 0) return results;
  return results.map(doc => filterDocFields(doc, perms));
}

/**
 * Build a MongoDB source filter if the role restricts data sources.
 * Returns an object to merge into the query filter, or empty object.
 */
function getSourceFilter(perms) {
  if (!perms || !perms.sources || perms.sources.length === 0) return {};
  return { _sources: { $in: perms.sources } };
}

/**
 * Check if the user can access a specific report.
 */
function canAccessReport(reportId, perms) {
  if (!perms) return true; // admin
  if (!perms.reports) return true;
  if (!perms.reports.builtIn || perms.reports.builtIn.length === 0) return true; // empty = all
  return perms.reports.builtIn.includes(reportId);
}

/**
 * Check if the user can access a specific field.
 */
function canAccessField(field, perms) {
  if (!perms) return true;
  if (!perms.attributes || perms.attributes.length === 0) return true;
  return RBAC_SYSTEM_FIELDS.has(field) || perms.attributes.includes(field);
}

// ── Dashboard Stats ────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const stats = await mongo.getStats();
    res.json(stats);
  } catch (err) {
    logger.error(`Stats error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── Global Search ──────────────────────────────────────────────────────────────
router.get('/search', async (req, res) => {
  try {
    const { q, page = 1, limit = 50, includeTerminated = false } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const perms = await getUserPermissions(req);
    const results = await mongo.textSearch(q.trim(), {
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 200),
      includeTerminated: includeTerminated === 'true',
      extraFilter: getSourceFilter(perms),
    });

    // Strip restricted fields
    if (results.results) results.results = filterResultFields(results.results, perms);

    res.json(results);
  } catch (err) {
    logger.error(`Search error: ${err.message}`);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── User Detail ────────────────────────────────────────────────────────────────
router.get('/users/:id', async (req, res) => {
  try {
    const perms = await getUserPermissions(req);
    const user = await mongo.getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Source restriction: if user's doc doesn't match allowed sources, deny
    if (perms && perms.sources && perms.sources.length > 0) {
      const docSources = user._sources || [];
      if (!docSources.some(s => perms.sources.includes(s))) {
        return res.status(404).json({ error: 'User not found' });
      }
    }
    res.json(filterDocFields(user, perms));
  } catch (err) {
    logger.error(`User detail error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── Advanced User Query ────────────────────────────────────────────────────────
router.post('/users/query', async (req, res) => {
  try {
    const { filter = {}, page = 1, limit = 50, sort = { displayname: 1 }, includeTerminated = false } = req.body;
    const perms = await getUserPermissions(req);

    const results = await mongo.searchUsers(filter, {
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 200),
      sort,
      includeTerminated,
      extraFilter: getSourceFilter(perms),
    });

    if (results.results) results.results = filterResultFields(results.results, perms);
    res.json(results);
  } catch (err) {
    logger.error(`User query error: ${err.message}`);
    res.status(500).json({ error: 'Query failed' });
  }
});

// ── Report List ────────────────────────────────────────────────────────────────
router.get('/reports', async (req, res) => {
  const perms = await getUserPermissions(req);
  let list = reports.getReportList();
  // Filter reports based on role permissions
  if (perms && perms.reports && perms.reports.builtIn && perms.reports.builtIn.length > 0) {
    list = list.filter(r => perms.reports.builtIn.includes(r.id));
  }
  res.json(list);
});

// ── Run Pre-built Report ───────────────────────────────────────────────────────
router.get('/reports/:reportId', async (req, res) => {
  try {
    const perms = await getUserPermissions(req);
    // Check report access
    if (!canAccessReport(req.params.reportId, perms)) {
      return res.status(403).json({ error: 'You do not have access to this report' });
    }

    const result = await reports.runReport(req.params.reportId, req.query);

    // Strip restricted fields from tabular results
    if (result.data && result.data.results && Array.isArray(result.data.results)) {
      result.data.results = filterResultFields(result.data.results, perms);
    }

    res.json(result);
  } catch (err) {
    if (err.message.startsWith('Unknown report')) {
      return res.status(404).json({ error: err.message });
    }
    logger.error(`Report error (${req.params.reportId}): ${err.message}`);
    res.status(500).json({ error: 'Report execution failed' });
  }
});

// ── Custom Aggregation Pipeline (Admin only) ───────────────────────────────────
router.post('/query/custom', requireRole('admin'), async (req, res) => {
  try {
    const { pipeline } = req.body;
    if (!pipeline) {
      return res.status(400).json({ error: 'Pipeline is required' });
    }

    // Block dangerous aggregation stages that could read/write other collections
    const BLOCKED_STAGES = ['$out', '$merge', '$lookup', '$graphLookup', '$unionWith', '$collStats', '$indexStats', '$planCacheStats', '$currentOp', '$listSessions'];
    if (Array.isArray(pipeline)) {
      for (const stage of pipeline) {
        const stageKey = Object.keys(stage)[0];
        if (BLOCKED_STAGES.includes(stageKey)) {
          return res.status(403).json({ error: `Aggregation stage "${stageKey}" is not permitted` });
        }
      }
    }

    logger.info(`Custom query by ${req.user.username}: ${JSON.stringify(pipeline).substring(0, 200)}...`);
    const result = await reports.runCustomQuery(pipeline);
    res.json(result);
  } catch (err) {
    logger.error(`Custom query error: ${err.message}`);
    // Don't expose raw MongoDB error details to client
    const safeMessage = err.message?.startsWith('Aggregation stage')
      ? err.message
      : 'Query execution failed. Check pipeline syntax.';
    res.status(500).json({ error: safeMessage });
  }
});

// ── Export Report to CSV ───────────────────────────────────────────────────────
router.get('/export/:reportId', async (req, res) => {
  try {
    const perms = await getUserPermissions(req);
    if (!canAccessReport(req.params.reportId, perms)) {
      return res.status(403).json({ error: 'You do not have access to this report' });
    }

    const result = await reports.runReport(req.params.reportId, req.query);
    let rows = result.data.results || result.data;

    if (!rows || (Array.isArray(rows) && rows.length === 0)) {
      return res.status(404).json({ error: 'No data to export' });
    }

    // Flatten data for CSV
    let dataArray = Array.isArray(rows) ? rows : [rows];

    // RBAC: strip restricted fields before export
    dataArray = filterResultFields(dataArray, perms);

    // Get all unique keys across all rows
    const keys = new Set();
    dataArray.forEach(row => {
      Object.keys(row).forEach(k => {
        if (!k.startsWith('_meta') && k !== '_sources') keys.add(k);
      });
    });

    // Build CSV
    const headers = [...keys];
    const csvRows = [headers.join(',')];

    for (const row of dataArray) {
      const values = headers.map(h => {
        let val = row[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') val = JSON.stringify(val);
        val = String(val);

        // Prevent CSV formula injection — prefix dangerous chars so Excel won't execute them
        if (/^[=+\-@\t\r]/.test(val)) {
          val = "'" + val;
        }

        // Escape CSV special characters
        val = val.replace(/"/g, '""');
        if (val.includes(',') || val.includes('"') || val.includes('\n')) {
          val = `"${val}"`;
        }
        return val;
      });
      csvRows.push(values.join(','));
    }

    const csv = csvRows.join('\n');
    const filename = `${req.params.reportId}_${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    logger.error(`Export error (${req.params.reportId}): ${err.message}`);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── Available Field Names (for column picker) ────────────────────────────────
router.get('/fields', async (req, res) => {
  try {
    let fields = await mongo.getFieldNames({ terminated: { $ne: true } });
    // RBAC: filter to only allowed fields
    const perms = await getUserPermissions(req);
    if (perms && perms.attributes && perms.attributes.length > 0) {
      const allowed = new Set([...RBAC_SYSTEM_FIELDS, ...perms.attributes]);
      fields = fields.filter(f => allowed.has(f));
    }
    res.json(fields);
  } catch (err) {
    logger.error(`Fields error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch field names' });
  }
});

// ── Group List (for group picker) ──────────────────────────────────────────────
router.get('/groups', async (req, res) => {
  try {
    const { search = '' } = req.query;
    const pipeline = [
      { $match: { terminated: { $ne: true }, memberof: { $exists: true, $ne: [] } } },
      { $unwind: '$memberof' },
      { $group: { _id: '$memberof', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ];

    let results = await mongo.aggregate(pipeline);

    // Extract CN from DN for display
    results = results.map(r => {
      const cn = r._id.match(/^CN=([^,]+)/i)?.[1] || r._id;
      return { dn: r._id, name: cn, count: r.count };
    });

    // Filter by search if provided (escape special regex chars to prevent ReDoS)
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      results = results.filter(r => regex.test(r.name) || regex.test(r.dn));
    }

    res.json({ groups: results, total: results.length });
  } catch (err) {
    logger.error(`Groups error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// ── Department List (for department picker) ─────────────────────────────────────
router.get('/departments', async (req, res) => {
  try {
    const { search = '' } = req.query;
    const pipeline = [
      { $match: { terminated: { $ne: true }, department: { $exists: true, $ne: '' } } },
      { $group: { _id: '$department', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ];

    let results = await mongo.aggregate(pipeline);
    results = results.map(r => ({ name: r._id, count: r.count }));

    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      results = results.filter(r => regex.test(r.name));
    }

    res.json({ departments: results, total: results.length });
  } catch (err) {
    logger.error(`Departments error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch departments' });
  }
});

// ── Distinct Values (for filter dropdowns) ─────────────────────────────────────
router.get('/distinct/:field', async (req, res) => {
  try {
    const field = req.params.field;
    const search = req.query.search || '';

    // Block internal/meta fields
    if (field.startsWith('_')) {
      return res.status(400).json({ error: 'Cannot query internal fields' });
    }

    // RBAC: check if user can access this field
    const perms = await getUserPermissions(req);
    if (!canAccessField(field, perms)) {
      return res.status(403).json({ error: 'Access to this field is restricted' });
    }

    // Build base filter — non-terminated users + source restrictions
    const baseFilter = { terminated: { $ne: true }, ...getSourceFilter(perms) };

    // If a search term is provided, use aggregation with regex filter for performance
    if (search.length >= 1) {
      const col = await mongo.getCollection();
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pipeline = [
        { $match: { ...baseFilter, [field]: { $exists: true, $nin: [null, ''] } } },
        { $group: { _id: '$' + field } },
        { $match: { _id: { $regex: escapedSearch, $options: 'i' } } },
        { $sort: { _id: 1 } },
        { $limit: 200 },
      ];
      const results = await col.aggregate(pipeline).toArray();
      const values = results.map(r => r._id).filter(v => v !== null && v !== undefined && v !== '');
      return res.json({ values, total: values.length, capped: false, searched: true });
    }

    // No search — return distinct values capped at 1000
    const values = await mongo.getDistinctValues(field, baseFilter);
    const cleaned = values.filter(v => v !== null && v !== undefined && v !== '').sort();
    res.json({ values: cleaned.slice(0, 1000), total: cleaned.length, capped: cleaned.length > 1000 });
  } catch (err) {
    logger.error(`Distinct values error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch distinct values' });
  }
});

// ── Custom Reports ─────────────────────────────────────────────────────────────

// List user's own custom reports + reports shared by others
router.get('/custom-reports', async (req, res) => {
  try {
    const col = await mongo.getCustomReportsCollection();
    const results = await col.find({
      $or: [
        { username: req.user.username },
        { shared: true },
      ],
    }).sort({ createdAt: -1 }).toArray();

    // Tag each report with isOwner flag and createdBy display name
    const tagged = results.map(r => ({
      ...r,
      isOwner: r.username === req.user.username,
    }));

    res.json({ reports: tagged });
  } catch (err) {
    logger.error(`Custom reports list error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch custom reports' });
  }
});

// Save a new custom report
router.post('/custom-reports', async (req, res) => {
  try {
    const { name, description, baseReportId, columns, filters, groups, departments, shared } = req.body;
    if (!name || !baseReportId) {
      return res.status(400).json({ error: 'Name and base report are required' });
    }

    const col = await mongo.getCustomReportsCollection();

    // Cap at 100 custom reports per user
    const count = await col.countDocuments({ username: req.user.username });
    if (count >= 100) {
      return res.status(400).json({ error: 'Maximum of 100 custom reports reached' });
    }

    const doc = {
      username: req.user.username,
      createdBy: req.user.displayName || req.user.username,
      name: name.trim(),
      description: (description || '').trim(),
      baseReportId,
      columns: columns || [],
      filters: filters || {},
      groups: groups || [],
      departments: departments || [],
      shared: shared === true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await col.insertOne(doc);
    doc._id = result.insertedId;
    logger.info(`Custom report saved: "${doc.name}" by ${req.user.username}`);
    res.json({ report: doc });
  } catch (err) {
    logger.error(`Custom report save error: ${err.message}`);
    res.status(500).json({ error: 'Failed to save custom report' });
  }
});

// Toggle share on a custom report (owner only)
router.patch('/custom-reports/:id/share', async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const col = await mongo.getCustomReportsCollection();
    const { shared } = req.body;
    const result = await col.updateOne(
      { _id: new ObjectId(req.params.id), username: req.user.username },
      { $set: { shared: shared === true, updatedAt: new Date().toISOString() } }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Report not found or not owned by you' });
    }
    logger.info(`Custom report ${shared ? 'shared' : 'unshared'}: ${req.params.id} by ${req.user.username}`);
    res.json({ success: true, shared: shared === true });
  } catch (err) {
    logger.error(`Custom report share toggle error: ${err.message}`);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

// Delete a custom report
router.delete('/custom-reports/:id', async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const col = await mongo.getCustomReportsCollection();
    const result = await col.deleteOne({
      _id: new ObjectId(req.params.id),
      username: req.user.username,
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }
    logger.info(`Custom report deleted: ${req.params.id} by ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Custom report delete error: ${err.message}`);
    res.status(500).json({ error: 'Failed to delete custom report' });
  }
});

// ── Report Schedules ───────────────────────────────────────────────────────────

// List ALL schedules (visible to all authenticated users)
router.get('/report-schedules', async (req, res) => {
  try {
    const col = await mongo.getReportSchedulesCollection();
    const results = await col.find({}).sort({ createdAt: -1 }).toArray();
    res.json({ schedules: results });
  } catch (err) {
    logger.error(`Report schedules list error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch report schedules' });
  }
});

// Create a new schedule
router.post('/report-schedules', async (req, res) => {
  try {
    const { name, reportId, reportName, description, deliverTo, schedule, runTime, reportParams } = req.body;
    if (!name || !reportId || !deliverTo || !schedule) {
      return res.status(400).json({ error: 'Name, report, email, and schedule are required' });
    }

    // Input length limits
    if (name.length > 200) return res.status(400).json({ error: 'Schedule name must be under 200 characters' });
    if ((description || '').length > 1000) return res.status(400).json({ error: 'Description must be under 1000 characters' });
    if (deliverTo.length > 500) return res.status(400).json({ error: 'Email address must be under 500 characters' });

    // Email domain restriction — only allow delivery to approved organizational domains
    const config = require('../config');
    const allowedDomains = config.smtp.allowedDomains || [];
    if (allowedDomains.length > 0) {
      const emails = deliverTo.split(/[,;\s]+/).map(e => e.trim()).filter(Boolean);
      for (const email of emails) {
        const domain = email.split('@')[1]?.toLowerCase();
        if (!domain || !allowedDomains.includes(domain)) {
          return res.status(400).json({ error: `Email domain "${domain || ''}" is not permitted. Allowed: ${allowedDomains.join(', ')}` });
        }
      }
    }

    // Validate runTime
    if (!runTime || !runTime.hour || !runTime.ampm) {
      return res.status(400).json({ error: 'Run time is required' });
    }

    const col = await mongo.getReportSchedulesCollection();

    const doc = {
      name: name.trim(),
      reportId,
      reportName: (reportName || reportId).trim(),
      description: (description || '').trim(),
      deliverTo: deliverTo.trim(),
      schedule,
      runTime: {
        hour: parseInt(runTime.hour, 10),
        minute: parseInt(runTime.minute || 0, 10),
        ampm: runTime.ampm,
      },
      reportParams: reportParams || {},
      enabled: true,
      createdBy: req.user.displayName || req.user.username,
      createdByUsername: req.user.username,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastRun: null,
      nextRun: null,
    };

    const result = await col.insertOne(doc);
    doc._id = result.insertedId;
    logger.info(`Report schedule created: "${doc.name}" by ${req.user.username}`);
    res.json({ schedule: doc });
  } catch (err) {
    logger.error(`Report schedule create error: ${err.message}`);
    res.status(500).json({ error: 'Failed to create report schedule' });
  }
});

// Toggle schedule enabled/disabled (creator or admin only)
router.patch('/report-schedules/:id', async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const col = await mongo.getReportSchedulesCollection();
    const existing = await col.findOne({ _id: new ObjectId(req.params.id) });
    if (!existing) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    // Only creator or admin can toggle
    const isCreator = existing.createdByUsername === req.user.username;
    const isAdmin = req.user.roles && req.user.roles.includes('admin');
    if (!isCreator && !isAdmin) {
      return res.status(403).json({ error: 'Only the creator or an admin can toggle this schedule' });
    }
    const newEnabled = !existing.enabled;
    await col.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { enabled: newEnabled, updatedAt: new Date().toISOString() } }
    );
    logger.info(`Report schedule ${newEnabled ? 'enabled' : 'disabled'}: ${req.params.id} by ${req.user.username}`);
    res.json({ success: true, enabled: newEnabled });
  } catch (err) {
    logger.error(`Report schedule toggle error: ${err.message}`);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// Edit a schedule (creator or admin only)
router.put('/report-schedules/:id', async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const col = await mongo.getReportSchedulesCollection();
    const existing = await col.findOne({ _id: new ObjectId(req.params.id) });
    if (!existing) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    // Allow edit by creator or admin
    const isCreator = existing.createdByUsername === req.user.username;
    const isAdmin = req.user.roles && req.user.roles.includes('admin');
    if (!isCreator && !isAdmin) {
      return res.status(403).json({ error: 'Only the creator or an admin can edit this schedule' });
    }

    const { name, reportId, reportName, description, deliverTo, schedule, runTime, reportParams } = req.body;
    if (!name || !reportId || !deliverTo || !schedule) {
      return res.status(400).json({ error: 'Name, report, email, and schedule are required' });
    }

    // Input length limits
    if (name.length > 200) return res.status(400).json({ error: 'Schedule name must be under 200 characters' });
    if ((description || '').length > 1000) return res.status(400).json({ error: 'Description must be under 1000 characters' });
    if (deliverTo.length > 500) return res.status(400).json({ error: 'Email address must be under 500 characters' });

    // Email domain restriction
    const config = require('../config');
    const allowedDomains = config.smtp.allowedDomains || [];
    if (allowedDomains.length > 0) {
      const emails = deliverTo.split(/[,;\s]+/).map(e => e.trim()).filter(Boolean);
      for (const email of emails) {
        const domain = email.split('@')[1]?.toLowerCase();
        if (!domain || !allowedDomains.includes(domain)) {
          return res.status(400).json({ error: `Email domain "${domain || ''}" is not permitted. Allowed: ${allowedDomains.join(', ')}` });
        }
      }
    }

    if (!runTime || !runTime.hour || !runTime.ampm) {
      return res.status(400).json({ error: 'Run time is required' });
    }

    const update = {
      $set: {
        name: name.trim(),
        reportId,
        reportName: (reportName || reportId).trim(),
        description: (description || '').trim(),
        deliverTo: deliverTo.trim(),
        schedule,
        runTime: {
          hour: parseInt(runTime.hour, 10),
          minute: parseInt(runTime.minute || 0, 10),
          ampm: runTime.ampm,
        },
        reportParams: reportParams || {},
        updatedAt: new Date().toISOString(),
      },
    };

    await col.updateOne({ _id: new ObjectId(req.params.id) }, update);
    logger.info(`Report schedule updated: "${name}" (${req.params.id}) by ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Report schedule edit error: ${err.message}`);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// Delete a schedule (only creator or admin)
router.delete('/report-schedules/:id', async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const col = await mongo.getReportSchedulesCollection();
    const existing = await col.findOne({ _id: new ObjectId(req.params.id) });
    if (!existing) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    // Allow deletion by creator or admin
    const isCreator = existing.createdByUsername === req.user.username;
    const isAdmin = req.user.roles && req.user.roles.includes('admin');
    if (!isCreator && !isAdmin) {
      return res.status(403).json({ error: 'Only the creator or an admin can delete this schedule' });
    }
    await col.deleteOne({ _id: new ObjectId(req.params.id) });
    logger.info(`Report schedule deleted: ${req.params.id} by ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Report schedule delete error: ${err.message}`);
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
});

// ── Fabric Users (Admin) ──────────────────────────────────────────────────────

// List all internal Fabric users
router.get('/fabric-users', requireRole('admin'), async (req, res) => {
  try {
    const col = await mongo.getFabricUsersCollection();
    const users = await col.find({}, {
      projection: {
        passwordHash: 0, // never expose
      },
    }).sort({ username: 1 }).toArray();
    res.json({ users });
  } catch (err) {
    logger.error(`Fabric users list error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Update a Fabric user (role, enabled, fabricRoleId)
router.patch('/fabric-users/:username', requireRole('admin'), async (req, res) => {
  try {
    const { role, enabled, fabricRoleId } = req.body;
    const target = req.params.username.toLowerCase();
    const col = await mongo.getFabricUsersCollection();

    const update = { $set: { updatedAt: new Date().toISOString() } };
    if (role !== undefined) {
      if (!['admin', 'user'].includes(role)) {
        return res.status(400).json({ error: 'Role must be "admin" or "user"' });
      }
      // Prevent removing your own admin role
      if (target === req.user.username && role !== 'admin') {
        return res.status(400).json({ error: 'You cannot remove your own admin role' });
      }
      update.$set.role = role;
    }
    if (enabled !== undefined) {
      // Prevent disabling yourself
      if (target === req.user.username && enabled === false) {
        return res.status(400).json({ error: 'You cannot disable your own account' });
      }
      update.$set.enabled = enabled === true;
    }
    // RBAC role assignment
    if (fabricRoleId !== undefined) {
      if (fabricRoleId === '' || fabricRoleId === null) {
        // Unassign role
        if (!update.$unset) update.$unset = {};
        update.$unset.fabricRoleId = '';
      } else {
        // Validate role exists
        const rolesCol = await mongo.getFabricRolesCollection();
        const { ObjectId } = require('mongodb');
        try {
          const roleDoc = await rolesCol.findOne({ _id: new ObjectId(fabricRoleId) });
          if (!roleDoc) return res.status(400).json({ error: 'RBAC role not found' });
        } catch { return res.status(400).json({ error: 'Invalid role ID' }); }
        update.$set.fabricRoleId = fabricRoleId;
      }
    }

    const result = await col.updateOne({ username: target }, update);
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    logger.info(`Fabric user updated: ${target} by ${req.user.username} (changes: ${JSON.stringify(req.body)})`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Fabric user update error: ${err.message}`);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Create a local Fabric user (admin only)
router.post('/fabric-users', requireRole('admin'), async (req, res) => {
  try {
    const { username, password, displayName, email, title, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (role && !['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "admin" or "user"' });
    }

    // Enforce password complexity: 12+ chars, uppercase, lowercase, number, special char
    if (password.length < 12) {
      return res.status(400).json({ error: 'Password must be at least 12 characters' });
    }
    if (!/[A-Z]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one uppercase letter' });
    }
    if (!/[a-z]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one lowercase letter' });
    }
    if (!/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one number' });
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one special character' });
    }

    const bcrypt = require('bcryptjs');
    const col = await mongo.getFabricUsersCollection();

    // Check for duplicates
    const existing = await col.findOne({ username: username.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ error: 'A user with this username already exists' });
    }

    const now = new Date().toISOString();
    const doc = {
      username: username.toLowerCase().trim(),
      email: (email || '').trim(),
      displayName: (displayName || username).trim(),
      title: (title || '').trim(),
      role: role || 'user',
      authMethod: 'local',
      enabled: true,
      lastLogin: null,
      loginCount: 0,
      createdAt: now,
      updatedAt: now,
      passwordHash: await bcrypt.hash(password, 12),
      failedAttempts: 0,
      lockedUntil: null,
    };

    await col.insertOne(doc);
    logger.info(`Fabric user created: ${doc.username} by ${req.user.username}`);

    // Return without sensitive fields
    delete doc.passwordHash;
    res.json({ user: doc });
  } catch (err) {
    logger.error(`Fabric user create error: ${err.message}`);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Delete a Fabric user (admin only)
router.delete('/fabric-users/:username', requireRole('admin'), async (req, res) => {
  try {
    const target = req.params.username.toLowerCase();

    // Prevent self-deletion
    if (target === req.user.username) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    const col = await mongo.getFabricUsersCollection();
    const result = await col.deleteOne({ username: target });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    logger.info(`Fabric user deleted: ${target} by ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Fabric user delete error: ${err.message}`);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ── Attribute Labels (Admin) ─────────────────────────────────────────────────

router.get('/attribute-labels', async (req, res) => {
  try {
    const col = await mongo.getAttributeLabelsCollection();
    const doc = await col.findOne({ _id: 'labels' });
    res.json({ labels: doc?.labels || {} });
  } catch (err) {
    logger.error(`Attribute labels get error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch attribute labels' });
  }
});

router.put('/attribute-labels', requireRole('admin'), async (req, res) => {
  try {
    const { labels } = req.body;
    if (!labels || typeof labels !== 'object') {
      return res.status(400).json({ error: 'Labels object is required' });
    }
    const cleaned = {};
    for (const [key, val] of Object.entries(labels)) {
      const trimmed = (val || '').trim();
      if (trimmed) cleaned[key] = trimmed;
    }
    const col = await mongo.getAttributeLabelsCollection();
    await col.updateOne(
      { _id: 'labels' },
      { $set: { labels: cleaned, updatedAt: new Date().toISOString(), updatedBy: req.user.username } },
      { upsert: true }
    );
    logger.info(`Attribute labels updated by ${req.user.username} (${Object.keys(cleaned).length} labels)`);
    res.json({ success: true, count: Object.keys(cleaned).length });
  } catch (err) {
    logger.error(`Attribute labels save error: ${err.message}`);
    res.status(500).json({ error: 'Failed to save attribute labels' });
  }
});

// ── RBAC Roles Management (Admin only) ──────────────────────────────────────

// List all roles
router.get('/roles', requireRole('admin'), async (req, res) => {
  try {
    const col = await mongo.getFabricRolesCollection();
    const roles = await col.find({}).sort({ name: 1 }).toArray();

    // Count users per role
    const usersCol = await mongo.getFabricUsersCollection();
    for (const role of roles) {
      role.userCount = await usersCol.countDocuments({ fabricRoleId: role._id.toString() });
    }

    res.json({ roles });
  } catch (err) {
    logger.error(`Roles list error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch roles' });
  }
});

// Get a single role
router.get('/roles/:id', requireRole('admin'), async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const col = await mongo.getFabricRolesCollection();
    const role = await col.findOne({ _id: new ObjectId(req.params.id) });
    if (!role) return res.status(404).json({ error: 'Role not found' });
    res.json(role);
  } catch (err) {
    logger.error(`Role get error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch role' });
  }
});

// Create a role
router.post('/roles', requireRole('admin'), async (req, res) => {
  try {
    const { name, description, permissions } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Role name is required' });
    }
    if (name.trim().length > 100) {
      return res.status(400).json({ error: 'Role name must be under 100 characters' });
    }

    const col = await mongo.getFabricRolesCollection();

    // Check for duplicate name
    const existing = await col.findOne({ name: name.trim() });
    if (existing) {
      return res.status(409).json({ error: 'A role with this name already exists' });
    }

    const now = new Date().toISOString();
    const doc = {
      name: name.trim(),
      description: (description || '').trim().substring(0, 500),
      permissions: {
        attributes: Array.isArray(permissions?.attributes) ? permissions.attributes : [],
        sources: Array.isArray(permissions?.sources) ? permissions.sources : [],
        reports: {
          builtIn: Array.isArray(permissions?.reports?.builtIn) ? permissions.reports.builtIn : [],
          customReports: permissions?.reports?.customReports !== false,
          customQueries: permissions?.reports?.customQueries === true,
        },
      },
      createdBy: req.user.username,
      createdAt: now,
      updatedAt: now,
    };

    await col.insertOne(doc);
    logger.info(`Role created: "${doc.name}" by ${req.user.username}`);
    res.json({ role: doc });
  } catch (err) {
    logger.error(`Role create error: ${err.message}`);
    res.status(500).json({ error: 'Failed to create role' });
  }
});

// Update a role
router.put('/roles/:id', requireRole('admin'), async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const { name, description, permissions } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Role name is required' });
    }

    const col = await mongo.getFabricRolesCollection();
    const roleId = new ObjectId(req.params.id);

    // Check for duplicate name (excluding self)
    const existing = await col.findOne({ name: name.trim(), _id: { $ne: roleId } });
    if (existing) {
      return res.status(409).json({ error: 'A role with this name already exists' });
    }

    const update = {
      $set: {
        name: name.trim(),
        description: (description || '').trim().substring(0, 500),
        permissions: {
          attributes: Array.isArray(permissions?.attributes) ? permissions.attributes : [],
          sources: Array.isArray(permissions?.sources) ? permissions.sources : [],
          reports: {
            builtIn: Array.isArray(permissions?.reports?.builtIn) ? permissions.reports.builtIn : [],
            customReports: permissions?.reports?.customReports !== false,
            customQueries: permissions?.reports?.customQueries === true,
          },
        },
        updatedAt: new Date().toISOString(),
      },
    };

    const result = await col.updateOne({ _id: roleId }, update);
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }

    // Invalidate cached permissions for all users with this role
    // (they'll re-fetch on next request)
    logger.info(`Role updated: "${name}" (${req.params.id}) by ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Role update error: ${err.message}`);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// Delete a role
router.delete('/roles/:id', requireRole('admin'), async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const col = await mongo.getFabricRolesCollection();
    const roleId = req.params.id;

    // Unassign all users from this role
    const usersCol = await mongo.getFabricUsersCollection();
    const unassigned = await usersCol.updateMany(
      { fabricRoleId: roleId },
      { $unset: { fabricRoleId: '' } }
    );

    const result = await col.deleteOne({ _id: new ObjectId(roleId) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }

    logger.info(`Role deleted: ${roleId} by ${req.user.username} (${unassigned.modifiedCount} users unassigned)`);
    res.json({ success: true, unassignedUsers: unassigned.modifiedCount });
  } catch (err) {
    logger.error(`Role delete error: ${err.message}`);
    res.status(500).json({ error: 'Failed to delete role' });
  }
});

// ── User Permissions Endpoint (returns effective permissions for current user) ──
router.get('/my-permissions', async (req, res) => {
  try {
    const perms = await getUserPermissions(req);
    res.json({ admin: perms === null, permissions: perms });
  } catch (err) {
    logger.error(`Permissions fetch error: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
});

// ── Duplicate Identity Check (Admin) ─────────────────────────────────────────

// POST /api/admin/run-duplicate-check
// Manually triggers a full duplicate scan. Returns a summary of results.
router.post('/admin/run-duplicate-check', requireRole('admin'), async (req, res) => {
  try {
    const { checkDuplicates } = require('../services/duplicateCheck');
    logger.info(`[DuplicateCheck] Manual trigger by ${req.user.username}`);
    const summary = await checkDuplicates();
    res.json({ success: true, summary });
  } catch (err) {
    logger.error(`[DuplicateCheck] Manual trigger error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Duplicate check failed.' });
  }
});

module.exports = router;