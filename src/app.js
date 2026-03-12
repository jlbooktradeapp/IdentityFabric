/**
 * Express Application — Identity Fabric Web
 *
 * Security measures:
 *   - Helmet (security headers: CSP, HSTS, X-Frame-Options, etc.)
 *   - Rate limiting (global + per-login-endpoint)
 *   - Session stored server-side in MongoDB (not in cookies)
 *   - Session fixation protection (regenerate on login)
 *   - Cookie flags: httpOnly, secure, sameSite
 *   - CORS restricted to same-origin in production
 *   - No stack traces or internal errors exposed to clients
 *   - Request logging with user attribution
 */

const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const config = require('./config');
const logger = require('./config/logger');
const { passport, initAuth } = require('./middleware/auth');
const requestLogger = require('./middleware/requestLogger');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

const app = express();

// ── Security Headers ───────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],  // TODO: Migrate inline onclick handlers to addEventListener, then remove unsafe-inline and use nonces
      scriptSrcAttr: ["'unsafe-inline'"],         // TODO: Remove once inline event handlers are eliminated
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'", "https://login.microsoftonline.com"],
      upgradeInsecureRequests: [],
    },
  },
  // HSTS — tell browsers to only use HTTPS for 1 year
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  // Prevent clickjacking
  frameguard: { action: 'deny' },
  // Prevent MIME type sniffing
  noSniff: true,
  // Referrer policy
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Permissions-Policy — restrict browser features the app doesn't need
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
  );
  next();
});

// ── Compression ────────────────────────────────────────────────────────────────
app.use(compression());

// ── CORS ───────────────────────────────────────────────────────────────────────
if (config.nodeEnv === 'production') {
  // Production: same-origin only
  app.use(cors({ origin: false }));
} else {
  // Development: allow local origins
  app.use(cors({ origin: true, credentials: true }));
}

// ── Trust Proxy (required behind IIS) ──────────────────────────────────────────
if (config.trustProxy) {
  app.set('trust proxy', 1);
}

// ── Global Rate Limiter ────────────────────────────────────────────────────────
// 200 requests per minute per IP — prevents API abuse
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
}));

// ── Body Parsing ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Sessions ───────────────────────────────────────────────────────────────────
// Stored in MongoDB — cookie only contains the session ID (signed, httpOnly)
app.use(session({
  secret: config.session.secret,
  name: 'idfabric.sid',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: config.mongo.uri,
    dbName: config.mongo.database,
    collectionName: '_sessions',
    ttl: config.session.maxAge / 1000,
    autoRemove: 'native',
    // Note: At-rest encryption (crypto option) removed — session confidentiality
    // is handled by signed httpOnly cookies + MongoDB access controls. The kruptein
    // library used by connect-mongo's crypto has strict secret requirements. If
    // at-rest encryption is needed, use MongoDB's native encryption-at-rest instead.
  }),
  cookie: {
    maxAge: config.session.maxAge,
    httpOnly: true,                                  // JS cannot read the cookie
    secure: config.nodeEnv === 'production',         // HTTPS only in production
    sameSite: 'lax',                                 // CSRF protection
  },
}));

// ── Passport ───────────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

// ── CSRF Protection (Custom Header Check) ──────────────────────────────────────
// All state-changing API requests must include X-Requested-With header.
// Browsers block cross-origin requests from adding custom headers without CORS
// preflight, which our CORS policy denies. This + SameSite=lax provides robust
// CSRF protection for a JSON API without token management overhead.
app.use('/api/', (req, res, next) => {
  // Skip safe methods and unauthenticated endpoints
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Skip SAML callback (POST from Entra ID, not from our frontend)
  if (req.path === '/auth/saml/callback') return next();
  // Require custom header on all state-changing requests
  if (!req.headers['x-requested-with']) {
    logger.warn(`CSRF check failed: ${req.method} ${req.path} from ${req.ip} - missing X-Requested-With`);
    return res.status(403).json({ error: 'Missing required request header' });
  }
  next();
});

// ── Idle Session Timeout ────────────────────────────────────────────────────────
// Destroys sessions idle longer than configured timeout (separate from absolute maxAge).
app.use((req, res, next) => {
  if (req.session && req.isAuthenticated && req.isAuthenticated()) {
    const now = Date.now();
    const lastActivity = req.session.lastActivity || now;
    const idleMs = config.session.idleTimeout;
    if (idleMs && (now - lastActivity) > idleMs) {
      logger.info(`Idle timeout: ${req.user?.username} (${Math.round((now - lastActivity) / 60000)}min idle)`);
      return req.session.destroy((err) => {
        if (err) logger.error(`Idle timeout session destroy: ${err.message}`);
        res.clearCookie('idfabric.sid');
        return res.status(401).json({ error: 'Session expired due to inactivity' });
      });
    }
    req.session.lastActivity = now;
  }
  next();
});

// ── Request Logging ────────────────────────────────────────────────────────────
app.use(requestLogger);

// ── Static Files ───────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: config.nodeEnv === 'production' ? '1d' : 0,
  setHeaders: (res, filePath) => {
    // Never cache HTML — deployments should take effect immediately
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
  // Prevent directory listing
  dotfiles: 'deny',
}));

// ── API Routes ─────────────────────────────────────────────────────────────────
app.use('/api', authRoutes);
app.use('/api', apiRoutes);

// ── Health Check (unauthenticated, rate-limited by global limiter) ─────────────
app.get('/api/health', async (req, res) => {
  try {
    const mongo = require('./services/mongo');
    await mongo.testConnection();
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: 'Database connection failed' });
  }
});

// ── SPA Fallback ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Global Error Handler ───────────────────────────────────────────────────────
// Never expose stack traces or internal details to the client
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack, path: req.path });

  if (config.nodeEnv === 'development') {
    res.status(500).json({ error: err.message, stack: err.stack });
  } else {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Export init function for server.js ─────────────────────────────────────────
app.initAuth = initAuth;

module.exports = app;