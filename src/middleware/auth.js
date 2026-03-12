/**
 * Authentication middleware — two strategies:
 *   1. Local accounts (bcrypt-hashed passwords in _fabricUsers)
 *   2. SAML SSO via Entra ID (passport-saml)
 *
 * JIT Provisioning:
 *   On SAML login, the app upserts an internal _fabricUsers record from SAML assertions.
 *   Username, Email, Title, and Role are extracted from SAML Attributes & Claims.
 *   Role is dynamically assigned based on AD group → Entra App Role mapping.
 *   The session always runs off the internal Fabric user record.
 */

const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const { Strategy: SamlStrategy } = require('@node-saml/passport-saml');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const config = require('../config');
const logger = require('../config/logger');
const mongo = require('../services/mongo');

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

let samlStrategy = null;

// ── Init ────────────────────────────────────────────────────────────────────────

async function initAuth(db) {
  const col = await mongo.getFabricUsersCollection();
  const count = await col.countDocuments();
  if (count === 0) {
    logger.warn('═══════════════════════════════════════════════════════');
    logger.warn('  No Fabric user accounts exist!');
    logger.warn('  Run this command to create your first admin:');
    logger.warn('    npm run create-admin');
    logger.warn('  The application will not be usable until an account');
    logger.warn('  is created. SAML SSO users will be auto-provisioned.');
    logger.warn('═══════════════════════════════════════════════════════');
  }
  logger.info(`Auth subsystem initialized. ${count} Fabric user(s) in database.`);
}

// ── Passport Serialization ──────────────────────────────────────────────────────

passport.serializeUser((user, done) => {
  const sessionUser = {
    id: user.id || user.username,
    username: user.username,
    displayName: user.displayName,
    email: user.email || '',
    title: user.title || '',
    role: user.role,
    authMethod: user.authMethod,
    roles: user.role === 'admin' ? ['admin', 'viewer'] : ['viewer'],
  };
  done(null, JSON.stringify(sessionUser));
});

passport.deserializeUser((data, done) => {
  try { done(null, JSON.parse(data)); }
  catch (err) { done(err, null); }
});

// ── Strategy 1: Local Accounts ──────────────────────────────────────────────────

passport.use('local', new LocalStrategy(
  { usernameField: 'username', passwordField: 'password' },
  async (username, password, done) => {
    try {
      const user = await authenticateLocal(username, password);
      return done(null, user);
    } catch (err) {
      logger.warn(`Local auth failed for "${username}": ${err.message}`);
      return done(null, false, { message: err.message });
    }
  }
));

async function authenticateLocal(username, password) {
  const col = await mongo.getFabricUsersCollection();
  const normalizedUsername = username.toLowerCase().trim();
  const userDoc = await col.findOne({ username: normalizedUsername });

  if (!userDoc) {
    await bcrypt.hash(password, 12);
    throw new Error('Invalid credentials');
  }
  if (userDoc.authMethod !== 'local') {
    throw new Error('This account uses SSO. Please sign in with TUHS SSO.');
  }
  if (userDoc.enabled === false) {
    throw new Error('Account is disabled. Contact your administrator.');
  }
  if (userDoc.lockedUntil && new Date(userDoc.lockedUntil) > new Date()) {
    const remaining = Math.ceil((new Date(userDoc.lockedUntil) - new Date()) / 60000);
    throw new Error(`Account locked. Try again in ${remaining} minute(s)`);
  }
  if (!userDoc.passwordHash) {
    throw new Error('Invalid credentials');
  }

  const valid = await bcrypt.compare(password, userDoc.passwordHash);
  if (!valid) {
    const failedAttempts = (userDoc.failedAttempts || 0) + 1;
    const update = { $set: { failedAttempts } };
    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      update.$set.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
      logger.warn(`Account "${normalizedUsername}" locked after ${failedAttempts} failed attempts`);
    }
    await col.updateOne({ username: normalizedUsername }, update);
    throw new Error('Invalid credentials');
  }

  const now = new Date().toISOString();
  await col.updateOne(
    { username: normalizedUsername },
    {
      $set: { failedAttempts: 0, lockedUntil: null, lastLogin: now, updatedAt: now },
      $inc: { loginCount: 1 },
    }
  );

  logger.info(`Local auth success: ${normalizedUsername} (role: ${userDoc.role})`);
  return {
    id: normalizedUsername,
    username: normalizedUsername,
    displayName: userDoc.displayName || normalizedUsername,
    email: userDoc.email || '',
    title: userDoc.title || '',
    role: userDoc.role || 'user',
    authMethod: 'local',
    roles: userDoc.role === 'admin' ? ['admin', 'viewer'] : ['viewer'],
  };
}

// ── Strategy 2: SAML SSO (Entra ID) ────────────────────────────────────────────

if (config.saml.enabled) {
  let idpCert = config.saml.idpCert || '';
  if (config.saml.idpCertPath && fs.existsSync(config.saml.idpCertPath)) {
    idpCert = fs.readFileSync(config.saml.idpCertPath, 'utf8');
  }
  idpCert = idpCert
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\r?\n/g, '')
    .trim();

  if (!idpCert) {
    logger.warn('SAML_ENABLED=true but no IdP certificate configured. SAML SSO will not be available.');
    logger.warn('Set SAML_IDP_CERT_PATH to the Entra signing certificate (.cer) and restart.');
  } else if (!config.saml.entryPoint) {
    logger.warn('SAML_ENABLED=true but no SAML_ENTRY_POINT configured. SAML SSO will not be available.');
  } else {
    logger.info(`SAML IdP cert loaded (${idpCert.length} chars from ${config.saml.idpCertPath || 'env var'})`);

  const samlConfig = {
    entryPoint: config.saml.entryPoint,
    issuer: config.saml.issuer,
    callbackUrl: config.saml.callbackUrl,
    idpCert: idpCert,
    cert: idpCert,          // alias — some versions use cert, some use idpCert
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,   // Entra ID does not sign the outer Response envelope for this app
    acceptedClockSkewMs: 5 * 60 * 1000,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    disableRequestedAuthnContext: true,
  };

  samlStrategy = new SamlStrategy(samlConfig, async (profile, done) => {
    try {
      const user = await handleSamlLogin(profile);
      return done(null, user);
    } catch (err) {
      logger.error(`SAML verify error: ${err.message}`);
      return done(err, null);
    }
  });

  passport.use('saml', samlStrategy);
  logger.info(`SAML SSO configured: issuer=${config.saml.issuer}, entryPoint=${config.saml.entryPoint}`);

  } // end cert + entryPoint guard
} else {
  logger.info('SAML SSO: Disabled');
}

/**
 * Handle SAML login — extract claims and JIT-provision internal user.
 */
async function handleSamlLogin(profile) {
  logger.info(`SAML profile keys: ${JSON.stringify(Object.keys(profile))}`);
  logger.info(`SAML nameID: ${profile.nameID}`);

  const claimMap = config.saml.claims;

  const rawUsername = getClaimValue(profile, claimMap.username) || profile.nameID || '';
  const username = rawUsername.split('@')[0].toLowerCase().trim();
  const email = getClaimValue(profile, claimMap.email) || profile.nameID || '';
  const displayName = getClaimValue(profile, claimMap.displayName) || username;
  const title = getClaimValue(profile, claimMap.title) || '';
  const rawRole = getClaimValue(profile, claimMap.role) || '';

  if (!username) {
    throw new Error('No username found in SAML assertions');
  }

  let role = 'user';
  if (rawRole) {
    const roleLower = rawRole.toLowerCase();
    if (roleLower === 'admin' || config.auth.adminGroups.some(g => g.toLowerCase() === roleLower)) {
      role = 'admin';
    }
  }

  logger.info(`SAML claims: username=${username}, email=${email}, title=${title}, role=${rawRole} -> ${role}`);

  const col = await mongo.getFabricUsersCollection();
  const now = new Date().toISOString();

  const updateResult = await col.findOneAndUpdate(
    { username },
    {
      $set: {
        email, displayName, title, role,
        authMethod: 'saml',
        lastLogin: now,
        updatedAt: now,
      },
      $inc: { loginCount: 1 },
      $setOnInsert: {
        username,
        enabled: true,
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  const fabricUser = updateResult.value || updateResult;

  if (fabricUser.enabled === false) {
    logger.warn(`SAML login blocked: ${username} account is disabled`);
    throw new Error('Your account has been disabled. Contact your administrator.');
  }

  const isNew = fabricUser.loginCount <= 1;
  logger.info(`SAML SSO ${isNew ? 'provisioned new' : 'updated'} user: ${username} (role: ${role})`);

  return {
    id: username,
    username,
    displayName: fabricUser.displayName,
    email: fabricUser.email,
    title: fabricUser.title,
    role: fabricUser.role,
    authMethod: 'saml',
    roles: fabricUser.role === 'admin' ? ['admin', 'viewer'] : ['viewer'],
  };
}

function getClaimValue(profile, claimUri) {
  if (!claimUri) return '';
  if (profile[claimUri] !== undefined) return String(profile[claimUri]);
  if (profile.attributes && profile.attributes[claimUri] !== undefined) {
    return String(profile.attributes[claimUri]);
  }
  return '';
}

function getSamlMetadata() {
  if (!samlStrategy) return null;
  try {
    return samlStrategy.generateServiceProviderMetadata(null, null);
  } catch (err) {
    logger.error(`SAML metadata generation error: ${err.message}`);
    return null;
  }
}

// ── Authorization Middleware ─────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required' });
  res.redirect('/login');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const userRoles = req.user.roles || [];
    const hasRole = roles.some(r => userRoles.includes(r));
    if (!hasRole) {
      logger.warn(`Access denied: ${req.user.username} needs [${roles}] but has [${userRoles}]`);
      return res.status(403).json({ error: 'Insufficient permissions', required: roles });
    }
    next();
  };
}

module.exports = {
  passport,
  initAuth,
  requireAuth,
  requireRole,
  getSamlMetadata,
};