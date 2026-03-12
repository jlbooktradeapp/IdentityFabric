/**
 * Authentication routes — local login, SAML SSO (Entra ID), logout.
 * Login endpoints are rate-limited separately from the global rate limiter.
 *
 * NOTE: Passport 0.7+ automatically calls session.regenerate() inside req.logIn()
 * to prevent session fixation. We do NOT call it manually — doing so would
 * create a new empty session AFTER Passport already stored the login, effectively
 * wiping the authenticated state.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { passport, requireAuth, getSamlMetadata } = require('../middleware/auth');
const config = require('../config');
const logger = require('../config/logger');
const mongo = require('../services/mongo');

// ── Account Lockout Constants ────────────────────────────────────────────────
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// ── Rate Limiter for Login Endpoints ───────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  keyGenerator: (req) => {
    const username = req.body?.username || 'unknown';
    return `${req.ip}:${username}`;
  },
});

// ── Auth Info (what methods are available — unauthenticated) ───────────────────
router.get('/auth/methods', (req, res) => {
  res.json({
    local: true,
    saml: config.saml.enabled,
    // Legacy compat — frontend checks 'entra'
    entra: config.saml.enabled,
  });
});

// ── Current User ───────────────────────────────────────────────────────────────
router.get('/auth/me', async (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    const userPayload = {
      authenticated: true,
      user: {
        username: req.user.username,
        displayName: req.user.displayName,
        email: req.user.email,
        authMethod: req.user.authMethod,
        role: req.user.role,
        roles: req.user.roles,
      },
    };

    // Load RBAC permissions for non-admins
    if (!(req.user.roles && req.user.roles.includes('admin'))) {
      try {
        const col = await mongo.getFabricUsersCollection();
        const fabricUser = await col.findOne({ username: req.user.username });
        if (fabricUser && fabricUser.fabricRoleId) {
          const { ObjectId } = require('mongodb');
          const rolesCol = await mongo.getFabricRolesCollection();
          try {
            const role = await rolesCol.findOne({ _id: new ObjectId(fabricUser.fabricRoleId) });
            if (role) {
              userPayload.user.fabricRole = { id: role._id, name: role.name };
              userPayload.user.permissions = role.permissions;
            }
          } catch { /* invalid ObjectId */ }
        }
        // If no role assigned, send default permissions
        if (!userPayload.user.permissions) {
          userPayload.user.permissions = {
            attributes: ['displayname','samaccountname','mail','department','title','employeeid','company','physicaldeliveryofficename','telephonenumber','manager','givenname','sn','userprincipalname','whencreated'],
            sources: [],
            reports: { builtIn: [], customReports: true, customQueries: false },
          };
        }
      } catch (err) {
        logger.error(`Auth/me RBAC error: ${err.message}`);
      }
    }

    return res.json(userPayload);
  }
  res.json({ authenticated: false });
});

// ── Local Account Login ────────────────────────────────────────────────────────
router.post('/auth/login/local', loginLimiter, async (req, res, next) => {
  const username = (req.body?.username || '').toLowerCase().trim();
  if (!username || !req.body?.password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  // ── Account Lockout Check ──
  try {
    const col = await mongo.getFabricUsersCollection();
    const account = await col.findOne({ username });
    if (account && account.lockedUntil && new Date(account.lockedUntil) > new Date()) {
      const remainingMin = Math.ceil((new Date(account.lockedUntil) - new Date()) / 60000);
      logger.warn(`Login blocked: ${username} - account locked (${remainingMin}min remaining)`);
      return res.status(423).json({ error: `Account locked due to too many failed attempts. Try again in ${remainingMin} minutes.` });
    }
  } catch (err) {
    logger.error(`Lockout check error: ${err.message}`);
    // Continue with auth — don't block login on DB errors
  }

  passport.authenticate('local', async (err, user, info) => {
    if (err) {
      logger.error(`Local login error: ${err.message}`);
      return res.status(500).json({ error: 'Authentication error' });
    }

    // ── Failed Login: Increment Attempts ──
    if (!user) {
      try {
        const col = await mongo.getFabricUsersCollection();
        const result = await col.findOneAndUpdate(
          { username },
          {
            $inc: { failedAttempts: 1 },
            $set: { lastFailedLogin: new Date().toISOString() },
          },
          { returnDocument: 'after' }
        );
        if (result && result.failedAttempts >= MAX_FAILED_ATTEMPTS) {
          const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
          await col.updateOne({ username }, { $set: { lockedUntil } });
          logger.warn(`Account locked: ${username} after ${result.failedAttempts} failed attempts`);
          return res.status(423).json({ error: `Account locked after ${MAX_FAILED_ATTEMPTS} failed attempts. Try again in 15 minutes.` });
        }
      } catch (lockErr) {
        logger.error(`Failed attempt tracking error: ${lockErr.message}`);
      }
      logger.warn(`Login failed: ${username} from ${req.ip}`);
      return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    }

    // ── Successful Login: Reset Lockout ──
    try {
      const col = await mongo.getFabricUsersCollection();
      await col.updateOne(
        { username: user.username },
        { $set: { failedAttempts: 0, lockedUntil: null, lastLogin: new Date().toISOString() }, $inc: { loginCount: 1 } }
      );
    } catch (resetErr) {
      logger.error(`Lockout reset error: ${resetErr.message}`);
    }

    req.logIn(user, (err) => {
      if (err) {
        logger.error(`Login error: ${err.message}`);
        return res.status(500).json({ error: 'Session creation failed' });
      }
      logger.info(`Login success: ${user.username} via local from ${req.ip}`);
      res.json({
        authenticated: true,
        user: {
          username: user.username,
          displayName: user.displayName,
          authMethod: user.authMethod,
          role: user.role,
          roles: user.roles,
        },
      });
    });
  })(req, res, next);
});

// ── SAML SSO Login (redirect to Entra ID) ─────────────────────────────────────
router.get('/auth/saml', (req, res, next) => {
  if (!config.saml.enabled) {
    return res.status(400).json({ error: 'SAML SSO is not enabled' });
  }
  passport.authenticate('saml', {
    failureRedirect: '/login?error=saml_failed',
  })(req, res, next);
});

// Legacy route — frontend calls /auth/entra, redirect to SAML
router.get('/auth/entra', (req, res) => {
  res.redirect('/api/auth/saml');
});

// ── SAML Assertion Consumer Service (ACS callback) ─────────────────────────────
router.post('/auth/saml/callback', (req, res, next) => {
  passport.authenticate('saml', (err, user, info) => {
    if (err) {
      logger.error(`SAML callback error: ${err.message}`);
      return res.redirect('/login?error=saml_error');
    }
    if (!user) {
      logger.warn(`SAML callback: no user returned. Info: ${JSON.stringify(info)}`);
      return res.redirect('/login?error=saml_failed');
    }

    req.logIn(user, (err) => {
      if (err) {
        logger.error(`SAML session error: ${err.message}`);
        return res.redirect('/login?error=session_failed');
      }
      logger.info(`Login success: ${user.username} via SAML`);
      res.redirect('/');
    });
  })(req, res, next);
});

// ── SAML Service Provider Metadata ─────────────────────────────────────────────
router.get('/auth/saml/metadata', (req, res) => {
  const metadata = getSamlMetadata();
  if (!metadata) {
    return res.status(404).json({ error: 'SAML not configured' });
  }
  res.type('application/xml');
  res.send(metadata);
});

// ── Logout ─────────────────────────────────────────────────────────────────────
router.post('/auth/logout', (req, res) => {
  const username = req.user?.username || 'unknown';
  req.logout((err) => {
    if (err) logger.error(`Logout error: ${err.message}`);
    req.session?.destroy((err) => {
      if (err) logger.error(`Session destroy error: ${err.message}`);
      res.clearCookie('idfabric.sid');
      logger.info(`Logout: ${username}`);
      res.json({ success: true });
    });
  });
});

module.exports = router;