/**
 * Server entry point — starts Express, connects to MongoDB.
 * Supports HTTPS (direct TLS) and HTTP.
 * Works both as a standalone process and as a Windows Service.
 *
 * For IIS deployment: IIS handles TLS termination, so Node runs HTTP only.
 * For standalone deployment: Node handles TLS directly using cert files.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('./app');
const config = require('./config');
const logger = require('./config/logger');
const mongo = require('./services/mongo');
const scheduler = require('./services/scheduler');

async function start() {
  // Mask credentials in connection strings for logging
  const sanitizeUri = (uri) => uri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');

  logger.info('═══════════════════════════════════════════════════════');
  logger.info('  Identity Fabric Web Application');
  logger.info(`  Environment: ${config.nodeEnv}`);
  logger.info(`  Port: ${config.port}`);
  logger.info(`  MongoDB: ${sanitizeUri(config.mongo.uri)}`);
  logger.info(`  LDAP Auth: ${config.ldap.enabled ? 'Enabled' : 'Disabled'}`);
  logger.info(`  SAML SSO: ${config.saml.enabled ? 'Enabled (' + config.saml.issuer + ')' : 'Disabled'}`);
  logger.info(`  TLS: ${config.tls.enabled ? config.tls.certPath || config.tls.pfxPath : 'Disabled (HTTP only)'}`);
  logger.info(`  SMTP: ${config.smtp.host}:${config.smtp.port} (from: ${config.smtp.from})`);
  logger.info(`  Scheduler: ${config.scheduler.enabled ? 'Enabled' : 'Disabled'}`);
  logger.info(`  Idle Timeout: ${config.session.idleTimeout / 60000}min`);
  logger.info('═══════════════════════════════════════════════════════');

  // Connect to MongoDB
  try {
    const { db } = await mongo.connect();
    // Initialize auth subsystem (local users collection, indexes)
    await app.initAuth(db);

    // Start report scheduler after DB is ready
    scheduler.start();
  } catch (err) {
    logger.error(`Failed to connect to MongoDB: ${err.message}`);
    logger.warn('Application will start but database queries will fail until MongoDB is available.');
  }

  // Start server — HTTPS if certs are configured, otherwise HTTP
  let server;

  if (config.tls.enabled) {
    let tlsOptions = {};

    // PFX format (Windows-friendly, single file with key + cert)
    if (config.tls.pfxPath) {
      if (!fs.existsSync(config.tls.pfxPath)) {
        logger.error(`TLS PFX not found: ${config.tls.pfxPath}`);
        process.exit(1);
      }
      tlsOptions.pfx = fs.readFileSync(config.tls.pfxPath);
      if (config.tls.pfxPassphrase) {
        tlsOptions.passphrase = config.tls.pfxPassphrase;
      }
      logger.info(`TLS using PFX: ${config.tls.pfxPath}`);
    }
    // PEM format (key + cert as separate files)
    else if (config.tls.keyPath && config.tls.certPath) {
      if (!fs.existsSync(config.tls.keyPath)) {
        logger.error(`TLS key not found: ${config.tls.keyPath}`);
        process.exit(1);
      }
      if (!fs.existsSync(config.tls.certPath)) {
        logger.error(`TLS cert not found: ${config.tls.certPath}`);
        process.exit(1);
      }
      tlsOptions.key = fs.readFileSync(config.tls.keyPath);
      tlsOptions.cert = fs.readFileSync(config.tls.certPath);
      logger.info(`TLS using PEM: ${config.tls.certPath}`);
    }
    else {
      logger.error('TLS_ENABLED=true but no certificate configured. Set TLS_PFX_PATH or TLS_KEY_PATH + TLS_CERT_PATH.');
      process.exit(1);
    }

    // Optional CA chain
    if (config.tls.caPath && fs.existsSync(config.tls.caPath)) {
      tlsOptions.ca = fs.readFileSync(config.tls.caPath);
    }

    server = https.createServer(tlsOptions, app);
    server.listen(config.port, () => {
      logger.info(`HTTPS server listening on port ${config.port}`);
      logger.info(`Local: https://localhost:${config.port}`);
    });

    // Optionally redirect HTTP → HTTPS on port 80
    if (config.tls.httpRedirectPort) {
      const redirectApp = require('express')();
      redirectApp.all('*', (req, res) => {
        res.redirect(301, `https://${req.hostname}:${config.port}${req.url}`);
      });
      http.createServer(redirectApp).listen(config.tls.httpRedirectPort, () => {
        logger.info(`HTTP → HTTPS redirect active on port ${config.tls.httpRedirectPort}`);
      });
    }
  } else {
    // Plain HTTP (use when IIS handles TLS termination)
    server = http.createServer(app);
    server.listen(config.port, () => {
      logger.info(`HTTP server listening on port ${config.port}`);
      logger.info(`Local: http://localhost:${config.port}`);
      if (config.nodeEnv === 'production') {
        logger.warn('Running HTTP in production — ensure IIS or a reverse proxy handles TLS!');
      }
    });
  }

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`${signal} received. Shutting down gracefully...`);
    scheduler.stop();
    server.close(async () => {
      await mongo.disconnect();
      logger.info('Server shut down complete.');
      process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout.');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});