/**
 * Centralized configuration — reads from environment variables (.env or system).
 */
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  trustProxy: process.env.TRUST_PROXY === 'true',

  session: {
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours absolute maximum
    idleTimeout: parseInt(process.env.SESSION_IDLE_TIMEOUT || '1800000', 10), // 30 minutes idle default
  },

  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017',
    database: process.env.MONGO_DB || 'IdentityFabric',
    collection: process.env.MONGO_COLLECTION || 'Identities',
  },

  ldap: {
    enabled: process.env.LDAP_ENABLED === 'true',
    url: process.env.LDAP_URL || 'ldap://tuh.tuhs.prv',
    baseDn: process.env.LDAP_BASE_DN || 'DC=tuh,DC=tuhs,DC=prv',
    bindDn: process.env.LDAP_BIND_DN || '',
    bindPassword: process.env.LDAP_BIND_PASSWORD || '',
    searchFilter: process.env.LDAP_SEARCH_FILTER || '(sAMAccountName={{username}})',
  },

  saml: {
    enabled: process.env.SAML_ENABLED === 'true',
    // Entra SAML SSO URL (from Entra → Enterprise App → Single sign-on → Login URL)
    entryPoint: process.env.SAML_ENTRY_POINT || '',
    // Entity ID — identifies this app to Entra (must match Entra Identifier)
    issuer: process.env.SAML_ISSUER || 'https://fabric.tuhs.prv',
    // ACS URL — where Entra POSTs the SAML assertion after login
    callbackUrl: process.env.SAML_CALLBACK_URL || 'https://fabric.tuhs.prv/api/auth/saml/callback',
    // Entra IdP signing certificate — base64 string or path to .cer/.pem file
    idpCert: process.env.SAML_IDP_CERT || '',
    idpCertPath: process.env.SAML_IDP_CERT_PATH || '',
    // SAML Attribute Claim URIs — map to the claim names configured in Entra
    claims: {
      username: process.env.SAML_CLAIM_USERNAME || 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
      email: process.env.SAML_CLAIM_EMAIL || 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      displayName: process.env.SAML_CLAIM_DISPLAYNAME || 'http://schemas.microsoft.com/identity/claims/displayname',
      title: process.env.SAML_CLAIM_TITLE || 'http://schemas.microsoft.com/identity/claims/jobtitle',
      role: process.env.SAML_CLAIM_ROLE || 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
    },
  },

  auth: {
    adminGroups: (process.env.ADMIN_GROUPS || 'SG_APP_FABRIC_ADMIN').split(',').map(s => s.trim()),
    viewerGroups: (process.env.VIEWER_GROUPS || 'SG_APP_FABRIC_ADMIN,SG_APP_FABRIC').split(',').map(s => s.trim()),
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || './logs',
  },

  tls: {
    enabled: process.env.TLS_ENABLED === 'true',
    // PFX format (recommended for Windows)
    pfxPath: process.env.TLS_PFX_PATH || '',
    pfxPassphrase: process.env.TLS_PFX_PASSPHRASE || '',
    // PEM format (alternative)
    keyPath: process.env.TLS_KEY_PATH || '',
    certPath: process.env.TLS_CERT_PATH || '',
    caPath: process.env.TLS_CA_PATH || '',
    httpRedirectPort: process.env.TLS_HTTP_REDIRECT_PORT
      ? parseInt(process.env.TLS_HTTP_REDIRECT_PORT, 10)
      : null,
  },

  smtp: {
    host: process.env.SMTP_HOST || 'smtp.tuhs.prv',
    port: parseInt(process.env.SMTP_PORT || '25', 10),
    secure: process.env.SMTP_SECURE === 'true',
    from: process.env.SMTP_FROM || 'FabricReports@tuhs.temple.edu',
    // Restrict scheduled report delivery to these domains (comma-separated)
    allowedDomains: (process.env.SMTP_ALLOWED_DOMAINS || 'tuhs.temple.edu,temple.edu,tuhs.prv')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  },

  scheduler: {
    enabled: process.env.SCHEDULER_ENABLED !== 'false',  // enabled by default
    checkIntervalMs: parseInt(process.env.SCHEDULER_INTERVAL || '60000', 10),  // 1 minute
  },
};

// ── Startup Safety Checks ────────────────────────────────────────────────────
const DANGEROUS_SECRETS = [
  'dev-secret-change-me',
  'CHANGE-ME-IMMEDIATELY-generate-a-random-64-char-string',
];

if (DANGEROUS_SECRETS.includes(config.session.secret)) {
  if (config.nodeEnv === 'production') {
    console.error('\n══════════════════════════════════════════════════════');
    console.error('  FATAL: SESSION_SECRET is set to a default value.');
    console.error('  This is a critical security risk in production.');
    console.error('  Generate a secret with PowerShell:');
    console.error('    [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }) -as [byte[]])');
    console.error('  Then set SESSION_SECRET in your .env file.');
    console.error('══════════════════════════════════════════════════════\n');
    process.exit(1);
  } else {
    console.warn('WARNING: Using default SESSION_SECRET — acceptable for dev only.');
  }
}

if (config.session.secret.length < 32) {
  console.warn('WARNING: SESSION_SECRET is shorter than 32 characters. Use a longer secret for production.');
}

module.exports = config;