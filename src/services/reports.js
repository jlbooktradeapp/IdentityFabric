/**
 * Report Service â€” pre-built and custom reports against the INTERNAL collection.
 */
const mongo = require('./mongo');
const logger = require('../config/logger');

// â”€â”€ Pre-built Report Definitions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const REPORTS = {
  // â”€â”€â”€ User Directory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'user-directory': {
    id: 'user-directory',
    name: 'User Directory',
    description: 'Complete searchable directory of all active users with contact info and department.',
    category: 'Directory',
    icon: 'users',
    run: async (params = {}) => {
      const { page = 1, limit = 50, search = '', department = '', title = '', fields = '', filters = '' } = params;
      const filter = { terminated: { $ne: true } };

      if (search) {
        const regex = { $regex: search, $options: 'i' };
        filter.$or = [
          { displayname: regex },
          { samaccountname: regex },
          { mail: regex },
          { employeeid: regex },
          { LAST_NAME_PRA: regex },
          { FIRST_NAME_PRA: regex },
          { npi: regex },
        ];
      }
      // Legacy single-field filters (backwards compat)
      if (department) filter.department = { $regex: department, $options: 'i' };
      if (title) filter.title = { $regex: title, $options: 'i' };

      // Generic field filters: JSON object like {"department":["Radiology","Cardiology"],"title":["Physician"]}
      if (filters) {
        try {
          const parsed = typeof filters === 'string' ? JSON.parse(filters) : filters;
          for (const [field, values] of Object.entries(parsed)) {
            // Safety: skip internal/meta fields
            if (field.startsWith('_')) continue;
            if (Array.isArray(values) && values.length > 0) {
              // For boolean-like values, handle stringâ†’boolean conversion
              const converted = values.map(v => {
                if (v === 'true') return true;
                if (v === 'false') return false;
                if (typeof v === 'string' && v !== '' && !isNaN(v)) return Number(v);
                return v;
              });
              filter[field] = { $in: converted };
            }
          }
        } catch (e) {
          logger.warn(`Invalid filters JSON: ${e.message}`);
        }
      }

      // Dynamic projection: if fields specified, use those; otherwise return all
      let projection = null;
      if (fields) {
        projection = { _id: 1, terminated: 1 };
        fields.split(',').forEach(f => {
          const field = f.trim();
          if (field && !field.startsWith('_')) {
            projection[field] = 1;
          }
        });
      }

      return mongo.searchUsers(filter, {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: { displayname: 1 },
        projection,
      });
    },
  },

  // â”€â”€â”€ Terminated Users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'terminated-users': {
    id: 'terminated-users',
    name: 'Terminated Users',
    description: 'Users no longer found in the Active Directory group, marked as terminated.',
    category: 'Compliance',
    icon: 'user-x',
    run: async (params = {}) => {
      const { page = 1, limit = 50, search = '', fields = '', filters = '' } = params;
      const filter = { terminated: true };

      if (search) {
        const regex = { $regex: search, $options: 'i' };
        filter.$or = [
          { displayname: regex },
          { samaccountname: regex },
          { mail: regex },
          { LAST_NAME_PRA: regex },
          { FIRST_NAME_PRA: regex },
          { npi: regex },
        ];
      }

      if (filters) {
        try {
          const parsed = typeof filters === 'string' ? JSON.parse(filters) : filters;
          for (const [field, values] of Object.entries(parsed)) {
            if (field.startsWith('_')) continue;
            if (Array.isArray(values) && values.length > 0) {
              const converted = values.map(v => {
                if (v === 'true') return true;
                if (v === 'false') return false;
                if (typeof v === 'string' && v !== '' && !isNaN(v)) return Number(v);
                return v;
              });
              filter[field] = { $in: converted };
            }
          }
        } catch (e) {
          logger.warn(`Invalid filters JSON: ${e.message}`);
        }
      }

      let projection = null;
      if (fields) {
        projection = { _id: 1, terminated: 1, _terminatedAt: 1, _terminatedReason: 1 };
        fields.split(',').forEach(f => {
          const field = f.trim();
          if (field) projection[field] = 1;
        });
      }

      return mongo.searchUsers(filter, {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: { '_terminatedAt': -1 },
        includeTerminated: true,
        projection,
      });
    },
  },

  // â”€â”€â”€ Department Breakdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'department-breakdown': {
    id: 'department-breakdown',
    name: 'Department Breakdown',
    description: 'User counts and details grouped by department.',
    category: 'Organization',
    icon: 'building',
    run: async (params = {}) => {
      const { sortBy = 'count', order = 'desc' } = params;
      const sortDir = order === 'asc' ? 1 : -1;
      const sortField = sortBy === 'name' ? '_id' : 'count';

      const pipeline = [
        { $match: { terminated: { $ne: true } } },
        { $group: {
          _id: { $ifNull: ['$department', '(No Department)'] },
          count: { $sum: 1 },
          titles: { $addToSet: '$title' },
          sampleUsers: { $push: { name: '$displayname', sam: '$samaccountname' } },
        }},
        { $sort: { [sortField]: sortDir } },
        { $project: {
          _id: 1, count: 1,
          uniqueTitles: { $size: '$titles' },
          sampleUsers: { $slice: ['$sampleUsers', 5] },
        }},
      ];

      const results = await mongo.aggregate(pipeline);
      const total = results.reduce((sum, r) => sum + r.count, 0);
      return { results, total, departmentCount: results.length };
    },
  },

  // â”€â”€â”€ Group Membership â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'group-membership': {
    id: 'group-membership',
    name: 'Group Membership Analysis',
    description: 'AD security group membership counts and most common groups.',
    category: 'Security',
    icon: 'shield',
    run: async (params = {}) => {
      const { minMembers = 1, search = '' } = params;

      const pipeline = [
        { $match: { terminated: { $ne: true }, memberof: { $exists: true } } },
        { $unwind: '$memberof' },
        { $group: { _id: '$memberof', count: { $sum: 1 } } },
        { $match: { count: { $gte: parseInt(minMembers) } } },
        { $sort: { count: -1 } },
        { $limit: 200 },
      ];

      let results = await mongo.aggregate(pipeline);

      // Extract CN from full DN for display
      results = results.map(r => {
        const cn = r._id.match(/^CN=([^,]+)/i)?.[1] || r._id;
        return { ...r, groupName: cn };
      });

      if (search) {
        const regex = new RegExp(search, 'i');
        results = results.filter(r => regex.test(r.groupName) || regex.test(r._id));
      }

      return { results, totalGroups: results.length };
    },
  },

  // â”€â”€â”€ Group Members Report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'group-members': {
    id: 'group-members',
    name: 'Group Members Report',
    description: 'Select one or more AD groups and view all members with full filtering and export.',
    category: 'Security',
    icon: 'users',
    run: async (params = {}) => {
      const { page = 1, limit = 50, search = '', fields = '', filters = '', groups = '' } = params;

      // Groups param is a JSON array of group DNs
      let groupDNs = [];
      if (groups) {
        try {
          groupDNs = typeof groups === 'string' ? JSON.parse(groups) : groups;
        } catch (e) {
          logger.warn(`Invalid groups JSON: ${e.message}`);
        }
      }

      // If no groups selected, return empty with a flag
      if (!groupDNs.length) {
        return { results: [], total: 0, page: 1, limit: 50, totalPages: 0, needsGroupSelection: true };
      }

      // Filter: users who are members of ANY of the selected groups
      const filter = {
        terminated: { $ne: true },
        memberof: { $in: groupDNs },
      };

      if (search) {
        const regex = { $regex: search, $options: 'i' };
        filter.$or = [
          { displayname: regex },
          { samaccountname: regex },
          { mail: regex },
          { employeeid: regex },
          { LAST_NAME_PRA: regex },
          { FIRST_NAME_PRA: regex },
          { npi: regex },
        ];
      }

      // Generic field filters (same as user-directory)
      if (filters) {
        try {
          const parsed = typeof filters === 'string' ? JSON.parse(filters) : filters;
          for (const [field, values] of Object.entries(parsed)) {
            if (field.startsWith('_')) continue;
            if (Array.isArray(values) && values.length > 0) {
              const converted = values.map(v => {
                if (v === 'true') return true;
                if (v === 'false') return false;
                if (typeof v === 'string' && v !== '' && !isNaN(v)) return Number(v);
                return v;
              });
              filter[field] = { $in: converted };
            }
          }
        } catch (e) {
          logger.warn(`Invalid filters JSON: ${e.message}`);
        }
      }

      // Dynamic projection
      let projection = null;
      if (fields) {
        projection = { _id: 1, terminated: 1 };
        fields.split(',').forEach(f => {
          const field = f.trim();
          if (field && !field.startsWith('_')) {
            projection[field] = 1;
          }
        });
      }

      return mongo.searchUsers(filter, {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: { displayname: 1 },
        projection,
      });
    },
  },

  // â”€â”€â”€ Department Members Report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'department-members': {
    id: 'department-members',
    name: 'Department Members Report',
    description: 'Select one or more departments and view all members with full filtering and export.',
    category: 'Organization',
    icon: 'building',
    run: async (params = {}) => {
      const { page = 1, limit = 50, search = '', fields = '', filters = '', departments = '' } = params;

      let deptList = [];
      if (departments) {
        try {
          deptList = typeof departments === 'string' ? JSON.parse(departments) : departments;
        } catch (e) {
          logger.warn(`Invalid departments JSON: ${e.message}`);
        }
      }

      if (!deptList.length) {
        return { results: [], total: 0, page: 1, limit: 50, totalPages: 0, needsDeptSelection: true };
      }

      const filter = {
        terminated: { $ne: true },
        department: { $in: deptList },
      };

      if (search) {
        const regex = { $regex: search, $options: 'i' };
        filter.$or = [
          { displayname: regex },
          { samaccountname: regex },
          { mail: regex },
          { employeeid: regex },
          { LAST_NAME_PRA: regex },
          { FIRST_NAME_PRA: regex },
          { npi: regex },
        ];
      }

      if (filters) {
        try {
          const parsed = typeof filters === 'string' ? JSON.parse(filters) : filters;
          for (const [field, values] of Object.entries(parsed)) {
            if (field.startsWith('_')) continue;
            if (Array.isArray(values) && values.length > 0) {
              const converted = values.map(v => {
                if (v === 'true') return true;
                if (v === 'false') return false;
                if (typeof v === 'string' && v !== '' && !isNaN(v)) return Number(v);
                return v;
              });
              filter[field] = { $in: converted };
            }
          }
        } catch (e) {
          logger.warn(`Invalid filters JSON: ${e.message}`);
        }
      }

      let projection = null;
      if (fields) {
        projection = { _id: 1, terminated: 1 };
        fields.split(',').forEach(f => {
          const field = f.trim();
          if (field && !field.startsWith('_')) {
            projection[field] = 1;
          }
        });
      }

      return mongo.searchUsers(filter, {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: { displayname: 1 },
        projection,
      });
    },
  },

  // â”€â”€â”€ Stale Accounts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'stale-accounts': {
    id: 'stale-accounts',
    name: 'Stale Accounts & Last Login',
    description: 'Active accounts that have not logged in recently â€” potential security risk.',
    category: 'Security',
    icon: 'clock',
    run: async (params = {}) => {
      const { days = 90, page = 1, limit = 50, fields = '', filters = '' } = params;
      const cutoff = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000).toISOString();

      const filter = {
        terminated: { $ne: true },
        $or: [
          { lastlogontimestamp: { $lt: cutoff } },
          { lastlogontimestamp: { $exists: false } },
        ],
      };

      if (filters) {
        try {
          const parsed = typeof filters === 'string' ? JSON.parse(filters) : filters;
          for (const [field, values] of Object.entries(parsed)) {
            if (field.startsWith('_')) continue;
            if (Array.isArray(values) && values.length > 0) {
              const converted = values.map(v => {
                if (v === 'true') return true;
                if (v === 'false') return false;
                if (typeof v === 'string' && v !== '' && !isNaN(v)) return Number(v);
                return v;
              });
              filter[field] = { $in: converted };
            }
          }
        } catch (e) {
          logger.warn(`Invalid filters JSON: ${e.message}`);
        }
      }

      let projection = null;
      if (fields) {
        projection = { _id: 1, terminated: 1 };
        fields.split(',').forEach(f => {
          const field = f.trim();
          if (field && !field.startsWith('_')) {
            projection[field] = 1;
          }
        });
      }

      return mongo.searchUsers(filter, {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: { lastlogontimestamp: 1 },
        projection,
      });
    },
  },

  // â”€â”€â”€ Inactive Users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'inactive-users': {
    id: 'inactive-users',
    name: 'Inactive Users',
    description: 'Users flagged as inactive via the carLicense attribute (INACTIVITY).',
    category: 'Security',
    icon: 'user-x',
    run: async (params = {}) => {
      const { page = 1, limit = 50, fields = '', filters = '' } = params;

      const filter = {
        terminated: { $ne: true },
        carlicense: 'INACTIVITY',
      };

      // Generic field filters
      if (filters) {
        try {
          const parsed = typeof filters === 'string' ? JSON.parse(filters) : filters;
          for (const [field, values] of Object.entries(parsed)) {
            if (field.startsWith('_')) continue;
            if (Array.isArray(values) && values.length > 0) {
              const converted = values.map(v => {
                if (v === 'true') return true;
                if (v === 'false') return false;
                if (typeof v === 'string' && v !== '' && !isNaN(v)) return Number(v);
                return v;
              });
              filter[field] = { $in: converted };
            }
          }
        } catch (e) {
          logger.warn(`Invalid filters JSON: ${e.message}`);
        }
      }

      let projection = null;
      if (fields) {
        projection = { _id: 1, terminated: 1 };
        fields.split(',').forEach(f => {
          const field = f.trim();
          if (field && !field.startsWith('_')) {
            projection[field] = 1;
          }
        });
      }

      return mongo.searchUsers(filter, {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: { displayname: 1 },
        projection,
      });
    },
  },

  // â”€â”€â”€ Disabled Users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'disabled-users': {
    id: 'disabled-users',
    name: 'Disabled Users',
    description: 'Users whose Active Directory accounts are disabled (UAC ACCOUNTDISABLE flag).',
    category: 'Security',
    icon: 'user-x',
    run: async (params = {}) => {
      const { page = 1, limit = 50, fields = '', filters = '' } = params;

      // UAC bit 0x2 (2) = ACCOUNTDISABLE
      const filter = {
        terminated: { $ne: true },
        useraccountcontrol: { $bitsAllSet: 2 },
      };

      if (filters) {
        try {
          const parsed = typeof filters === 'string' ? JSON.parse(filters) : filters;
          for (const [field, values] of Object.entries(parsed)) {
            if (field.startsWith('_')) continue;
            if (Array.isArray(values) && values.length > 0) {
              const converted = values.map(v => {
                if (v === 'true') return true;
                if (v === 'false') return false;
                if (typeof v === 'string' && v !== '' && !isNaN(v)) return Number(v);
                return v;
              });
              filter[field] = { $in: converted };
            }
          }
        } catch (e) {
          logger.warn(`Invalid filters JSON: ${e.message}`);
        }
      }

      let projection = null;
      if (fields) {
        projection = { _id: 1, terminated: 1 };
        fields.split(',').forEach(f => {
          const field = f.trim();
          if (field && !field.startsWith('_')) {
            projection[field] = 1;
          }
        });
      }

      return mongo.searchUsers(filter, {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: { displayname: 1 },
        projection,
      });
    },
  },

  // â”€â”€â”€ Locked Out Users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'locked-out-users': {
    id: 'locked-out-users',
    name: 'Locked Out Users',
    description: 'Users whose Active Directory accounts are currently locked out.',
    category: 'Security',
    icon: 'lock',
    run: async (params = {}) => {
      const { page = 1, limit = 50, fields = '', filters = '' } = params;

      // lockouttime is stored as 0 (not locked) or an ISO date string (locked)
      // The sync script converts non-zero file times to ISO strings
      const filter = {
        terminated: { $ne: true },
        lockouttime: { $type: 'string' },
      };

      if (filters) {
        try {
          const parsed = typeof filters === 'string' ? JSON.parse(filters) : filters;
          for (const [field, values] of Object.entries(parsed)) {
            if (field.startsWith('_')) continue;
            if (Array.isArray(values) && values.length > 0) {
              const converted = values.map(v => {
                if (v === 'true') return true;
                if (v === 'false') return false;
                if (typeof v === 'string' && v !== '' && !isNaN(v)) return Number(v);
                return v;
              });
              filter[field] = { $in: converted };
            }
          }
        } catch (e) {
          logger.warn(`Invalid filters JSON: ${e.message}`);
        }
      }

      let projection = null;
      if (fields) {
        projection = { _id: 1, terminated: 1 };
        fields.split(',').forEach(f => {
          const field = f.trim();
          if (field && !field.startsWith('_')) {
            projection[field] = 1;
          }
        });
      }

      return mongo.searchUsers(filter, {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: { lockouttime: -1 },
        projection,
      });
    },
  },

  'password-expiry': {
    id: 'password-expiry',
    name: 'Password Age & Expiry',
    description: 'Users with old passwords or passwords set to never expire.',
    category: 'Security',
    icon: 'key',
    run: async (params = {}) => {
      const { days = 90, page = 1, limit = 50, neverExpires = false, fields = '', filters = '' } = params;

      let filter;
      if (neverExpires === 'true' || neverExpires === true) {
        filter = {
          terminated: { $ne: true },
          $or: [
            { useraccountcontrol: { $bitsAllSet: 65536 } },
          ],
        };
      } else {
        const cutoff = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000).toISOString();
        filter = {
          terminated: { $ne: true },
          $or: [
            { pwdlastset: { $lt: cutoff } },
            { pwdlastset: { $exists: false } },
          ],
        };
      }

      if (filters) {
        try {
          const parsed = typeof filters === 'string' ? JSON.parse(filters) : filters;
          for (const [field, values] of Object.entries(parsed)) {
            if (field.startsWith('_')) continue;
            if (Array.isArray(values) && values.length > 0) {
              const converted = values.map(v => {
                if (v === 'true') return true;
                if (v === 'false') return false;
                if (typeof v === 'string' && v !== '' && !isNaN(v)) return Number(v);
                return v;
              });
              filter[field] = { $in: converted };
            }
          }
        } catch (e) {
          logger.warn(`Invalid filters JSON: ${e.message}`);
        }
      }

      let projection = null;
      if (fields) {
        projection = { _id: 1, terminated: 1 };
        fields.split(',').forEach(f => {
          const field = f.trim();
          if (field && !field.startsWith('_')) {
            projection[field] = 1;
          }
        });
      }

      return mongo.searchUsers(filter, {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: { pwdlastset: 1 },
        projection,
      });
    },
  },

  // â”€â”€â”€ Account Status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'account-status': {
    id: 'account-status',
    name: 'Account Status Overview',
    description: 'Breakdown of enabled, disabled, locked, and expired accounts.',
    category: 'Compliance',
    icon: 'toggle-left',
    run: async () => {
      const pipeline = [
        {
          $facet: {
            active: [{ $match: { terminated: { $ne: true } } }, { $count: 'count' }],
            terminated: [{ $match: { terminated: true } }, { $count: 'count' }],
            // UAC 0x2 = ACCOUNTDISABLE
            disabled: [
              { $match: { terminated: { $ne: true } } },
              { $match: { $expr: { $ne: [{ $mod: [{ $ifNull: ['$useraccountcontrol', 0] }, 2] }, 0] } } },
              // Simplified: just check if bit set via aggregation
              { $count: 'count' },
            ],
            recentlyCreated: [
              { $match: { terminated: { $ne: true } } },
              {
                $match: {
                  whencreated: {
                    $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
                  },
                },
              },
              { $count: 'count' },
            ],
            noEmail: [
              { $match: { terminated: { $ne: true }, $or: [{ mail: { $exists: false } }, { mail: '' }] } },
              { $count: 'count' },
            ],
            noManager: [
              { $match: { terminated: { $ne: true }, $or: [{ manager: { $exists: false } }, { manager: '' }] } },
              { $count: 'count' },
            ],
          },
        },
      ];

      const [result] = await mongo.aggregate(pipeline);

      return {
        active: result.active[0]?.count || 0,
        terminated: result.terminated[0]?.count || 0,
        disabled: result.disabled[0]?.count || 0,
        recentlyCreated: result.recentlyCreated[0]?.count || 0,
        noEmail: result.noEmail[0]?.count || 0,
        noManager: result.noManager[0]?.count || 0,
      };
    },
  },

  // â”€â”€â”€ New Accounts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'new-accounts': {
    id: 'new-accounts',
    name: 'Recently Created Accounts',
    description: 'User accounts created in the last N days.',
    category: 'Compliance',
    icon: 'user-plus',
    run: async (params = {}) => {
      const { days = 30, page = 1, limit = 50, fields = '', filters = '' } = params;
      const cutoff = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000).toISOString();

      const filter = {
        terminated: { $ne: true },
        whencreated: { $gte: cutoff },
      };

      if (filters) {
        try {
          const parsed = typeof filters === 'string' ? JSON.parse(filters) : filters;
          for (const [field, values] of Object.entries(parsed)) {
            if (field.startsWith('_')) continue;
            if (Array.isArray(values) && values.length > 0) {
              const converted = values.map(v => {
                if (v === 'true') return true;
                if (v === 'false') return false;
                if (typeof v === 'string' && v !== '' && !isNaN(v)) return Number(v);
                return v;
              });
              filter[field] = { $in: converted };
            }
          }
        } catch (e) {
          logger.warn(`Invalid filters JSON: ${e.message}`);
        }
      }

      let projection = null;
      if (fields) {
        projection = { _id: 1, terminated: 1 };
        fields.split(',').forEach(f => {
          const field = f.trim();
          if (field && !field.startsWith('_')) {
            projection[field] = 1;
          }
        });
      }

      return mongo.searchUsers(filter, {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: { whencreated: -1 },
        projection,
      });
    },
  },

  // â”€â”€â”€ Manager Hierarchy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'manager-hierarchy': {
    id: 'manager-hierarchy',
    name: 'Manager Direct Reports',
    description: 'Count of direct reports per manager.',
    category: 'Organization',
    icon: 'git-branch',
    run: async (params = {}) => {
      const { search = '' } = params;

      const pipeline = [
        { $match: { terminated: { $ne: true }, manager: { $exists: true, $ne: '' } } },
        { $group: {
          _id: '$manager',
          directReports: { $sum: 1 },
          departments: { $addToSet: '$department' },
          reports: { $push: { name: '$displayname', sam: '$samaccountname', title: '$title' } },
        }},
        { $sort: { directReports: -1 } },
        { $limit: 100 },
        { $project: {
          _id: 1,
          directReports: 1,
          departments: 1,
          sampleReports: { $slice: ['$reports', 10] },
          managerCN: 1,
        }},
      ];

      let results = await mongo.aggregate(pipeline);

      // Extract manager CN from DN
      results = results.map(r => ({
        ...r,
        managerName: r._id.match(/^CN=([^,]+)/i)?.[1] || r._id,
      }));

      if (search) {
        const regex = new RegExp(search, 'i');
        results = results.filter(r => regex.test(r.managerName));
      }

      return { results };
    },
  },

  // â”€â”€â”€ Title Distribution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'title-distribution': {
    id: 'title-distribution',
    name: 'Job Title Distribution',
    description: 'Most common job titles across the organization.',
    category: 'Organization',
    icon: 'briefcase',
    run: async (params = {}) => {
      const { search = '' } = params;
      const pipeline = [
        { $match: { terminated: { $ne: true } } },
        { $group: {
          _id: { $ifNull: ['$title', '(No Title)'] },
          count: { $sum: 1 },
          departments: { $addToSet: '$department' },
        }},
        { $sort: { count: -1 } },
        { $limit: 200 },
      ];

      let results = await mongo.aggregate(pipeline);

      if (search) {
        const regex = new RegExp(search, 'i');
        results = results.filter(r => regex.test(r._id));
      }

      return { results, totalTitles: results.length };
    },
  },

  // â”€â”€â”€ Data Quality â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'data-quality': {
    id: 'data-quality',
    name: 'Data Quality Audit',
    description: 'Identifies users with missing critical attributes (email, department, manager, title).',
    category: 'Compliance',
    icon: 'alert-triangle',
    run: async () => {
      const fields = [
        { field: 'mail', label: 'Email' },
        { field: 'department', label: 'Department' },
        { field: 'manager', label: 'Manager' },
        { field: 'title', label: 'Job Title' },
        { field: 'employeeid', label: 'Employee ID' },
        { field: 'telephonenumber', label: 'Phone Number' },
        { field: 'physicaldeliveryofficename', label: 'Office Location' },
        { field: 'company', label: 'Company' },
      ];

      const activeFilter = { terminated: { $ne: true } };
      const totalActive = await (await mongo.getCollection()).countDocuments(activeFilter);

      const results = [];
      for (const { field, label } of fields) {
        const missing = await (await mongo.getCollection()).countDocuments({
          ...activeFilter,
          $or: [{ [field]: { $exists: false } }, { [field]: '' }, { [field]: null }],
        });
        results.push({
          field,
          label,
          missing,
          populated: totalActive - missing,
          completeness: totalActive > 0 ? Math.round(((totalActive - missing) / totalActive) * 100 * 10) / 10 : 0,
        });
      }

      results.sort((a, b) => a.completeness - b.completeness);
      return { results, totalActive };
    },
  },

  // â”€â”€â”€ Sync Status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'sync-status': {
    id: 'sync-status',
    name: 'Sync Status & Sources',
    description: 'Shows data sources, last sync times, and source coverage.',
    category: 'System',
    icon: 'refresh-cw',
    run: async () => {
      const coll = await mongo.getCollection();

      const sources = await coll.distinct('_sources');
      const total = await coll.countDocuments();

      const sourceDetails = [];
      for (const source of sources) {
        const count = await coll.countDocuments({ _sources: source });
        const latest = await coll.findOne(
          { [`_lastUpdated.${source}`]: { $exists: true } },
          { sort: { [`_lastUpdated.${source}`]: -1 }, projection: { [`_lastUpdated.${source}`]: 1 } }
        );
        sourceDetails.push({
          source,
          documentCount: count,
          lastSync: latest?._lastUpdated?.[source] || null,
        });
      }

      return { sources: sourceDetails, totalDocuments: total };
    },
  },
};

/**
 * Get all report definitions (metadata only, for the report picker).
 */
function getReportList() {
  return Object.values(REPORTS).map(({ id, name, description, category, icon }) => ({
    id, name, description, category, icon,
  }));
}

/**
 * Run a specific report.
 */
async function runReport(reportId, params = {}) {
  const report = REPORTS[reportId];
  if (!report) {
    throw new Error(`Unknown report: ${reportId}`);
  }

  const startTime = Date.now();
  const data = await report.run(params);
  const elapsed = Date.now() - startTime;

  logger.info(`Report "${reportId}" executed in ${elapsed}ms`);

  return {
    reportId: report.id,
    reportName: report.name,
    category: report.category,
    executedAt: new Date().toISOString(),
    elapsedMs: elapsed,
    data,
  };
}

/**
 * Run a custom aggregation pipeline (admin only).
 */
async function runCustomQuery(pipeline) {
  if (!Array.isArray(pipeline)) {
    throw new Error('Pipeline must be an array of aggregation stages.');
  }

  // Security: block dangerous aggregation stages that could modify data,
  // access other collections (including _fabricUsers), or execute arbitrary JS
  const BLOCKED_STAGES = [
    '$merge', '$out',           // Can overwrite/create collections
    '$lookup', '$unionWith',    // Can read other collections (e.g. _fabricUsers with password hashes)
    '$function', '$accumulator', // Execute arbitrary server-side JavaScript
    '$currentOp', '$collStats',  // Expose server internals
    '$listSessions', '$listLocalSessions', // Expose session data
    '$planCacheStats',           // Expose query plan internals
  ];

  for (const stage of pipeline) {
    const stageKeys = Object.keys(stage);
    const blocked = stageKeys.filter(k => BLOCKED_STAGES.includes(k));
    if (blocked.length > 0) {
      throw new Error(`Blocked aggregation stage(s): ${blocked.join(', ')}. These stages are not permitted in custom queries.`);
    }
  }

  // Safety: add a $limit if not present to prevent runaway queries
  const hasLimit = pipeline.some(stage => '$limit' in stage);
  if (!hasLimit) {
    pipeline.push({ $limit: 1000 });
  }

  const startTime = Date.now();
  const results = await mongo.aggregate(pipeline);
  const elapsed = Date.now() - startTime;

  return { results, count: results.length, elapsedMs: elapsed };
}

module.exports = {
  getReportList,
  runReport,
  runCustomQuery,
  REPORTS,
};