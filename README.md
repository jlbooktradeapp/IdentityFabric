# Identity Fabric Web Application

A Node.js/Express web application for querying, searching, and reporting against your Identity Fabric MongoDB collection. Designed to run on Windows behind IIS or as a Windows Service.

## Features

- **Three authentication methods** — Local accounts (bcrypt), LDAP (Active Directory), and Entra ID (Azure AD SSO)
- **Dashboard** — Live stats on active users, terminated accounts, data sources, and last sync time
- **Global search** — Across name, email, username, employee ID, department, and title
- **User detail view** — Full attribute inspector with categorized fields and group memberships
- **12 pre-built reports** — User directory, terminated users, department breakdown, group membership, stale accounts, password expiry, account status, new accounts, manager hierarchy, title distribution, data quality audit, sync status
- **Custom query builder** — Ad-hoc MongoDB aggregation pipelines (admin only)
- **CSV export** — Export any report
- **IIS and Windows Service deployment** with TLS certificate management

---

## Quick Start

```powershell
cd C:\IdentityFabric
npm install
copy .env.example .env
# Edit .env — at minimum set SESSION_SECRET (see Security section below)

# Create your first local admin account
npm run create-admin

# Start the server
npm run dev

# Open http://localhost:3000 and log in with your local account
```

---

## Local Admin Accounts

Local accounts are stored in MongoDB with bcrypt-hashed passwords (12 rounds). They work independently of LDAP and Entra ID — you can always log in even if AD is down.

```powershell
# Interactive (prompts for username/password)
npm run create-admin

# Non-interactive
node scripts/create-local-user.js --username admin --password "Y0urS3cure!Pass" --role admin

# List all local users
node scripts/create-local-user.js --list

# Delete a user
node scripts/create-local-user.js --username admin --delete
```

**Password requirements:** 12+ characters, uppercase, lowercase, number, special character.

**Account lockout:** 5 failed attempts → 15-minute lock.

---

## Configuration (.env)

```env
# MongoDB — must match your ADSync.ps1 settings
MONGO_URI=mongodb://localhost:27017
MONGO_DB=IdentityFabric
MONGO_COLLECTION=INTERNAL

# Server
PORT=3000
NODE_ENV=production
TRUST_PROXY=true
SESSION_SECRET=<generate-a-random-64-char-string>

# LDAP (optional — set LDAP_ENABLED=false to disable)
LDAP_ENABLED=true
LDAP_URL=ldaps://tuh.tuhs.prv
LDAP_BASE_DN=DC=tuh,DC=tuhs,DC=prv
LDAP_BIND_DN=CN=svc_identityfabric,OU=ServiceAccounts,DC=tuh,DC=tuhs,DC=prv
LDAP_BIND_PASSWORD=<service-account-password>
LDAP_SEARCH_FILTER=(sAMAccountName={{username}})

# Entra ID (optional — set ENTRA_ENABLED=false to disable)
ENTRA_ENABLED=false
ENTRA_TENANT_ID=your-tenant-id
ENTRA_CLIENT_ID=your-client-id
ENTRA_CLIENT_SECRET=your-client-secret
ENTRA_REDIRECT_URI=https://identityfabric.tuhs.temple.edu/auth/entra/callback

# Authorization — AD group names that grant roles
ADMIN_GROUPS=IdentityFabric-Admins
VIEWER_GROUPS=IdentityFabric-Admins,IdentityFabric-ReportViewers
```

Generate a session secret in PowerShell:
```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }) -as [byte[]])
```

---

## Security Architecture

### Authentication Security

| Layer | Protection | Details |
|-------|-----------|---------|
| **Password storage** | bcrypt (12 rounds) | ~250ms per hash — makes brute force impractical |
| **Login rate limiting** | 10 attempts / 15 min / IP+username | Separate from global API rate limit |
| **Account lockout** | 5 failures → 15 min lock | Per-account, tracked in MongoDB |
| **Session fixation** | Session regenerated on login | Prevents session hijacking via pre-auth session IDs |
| **Session storage** | Server-side in MongoDB (encrypted at rest) | Cookie contains only a signed session ID |
| **Cookie flags** | httpOnly, secure, sameSite=lax | JS cannot read cookie; built-in CSRF protection |
| **LDAP injection** | Input sanitization (RFC 4515) | Special characters escaped before LDAP filter |
| **User enumeration** | Constant-time response for bad usernames | bcrypt hash runs even for nonexistent users |

### Transport & Header Security

| Header | Value | Purpose |
|--------|-------|---------|
| **Strict-Transport-Security** | max-age=31536000; includeSubDomains | Force HTTPS for 1 year |
| **Content-Security-Policy** | self + fonts/icons CDN only | Prevents XSS via script injection |
| **X-Frame-Options** | DENY | Prevents clickjacking |
| **X-Content-Type-Options** | nosniff | Prevents MIME sniffing |
| **Referrer-Policy** | strict-origin-when-cross-origin | Limits referer leakage |

### API Security

| Protection | Details |
|-----------|---------|
| **Global rate limit** | 200 requests/min per IP on all `/api/` routes |
| **Login rate limit** | 10 attempts/15 min per IP+username |
| **No stack traces in production** | Error handler strips internals; full detail logged server-side |
| **Custom query restricted** | Admin role only; auto-injected `$limit: 1000` safety net |
| **Input limits** | Request body capped at 1MB; field allowlists on distinct queries |

### Deprecated Packages Replaced

| Old (deprecated) | New (maintained) | Why |
|---|---|---|
| `ldapjs` (decomissioned) | `ldapts` v7 | Actively maintained, TypeScript, async/await |
| `passport-azure-ad` (deprecated by Microsoft) | `@azure/msal-node` v2 | Microsoft's official auth library, actively patched |

### Production Hardening Checklist

- [ ] Use **LDAPS** (`ldaps://`) to encrypt AD credentials in transit
- [ ] Generate a **strong SESSION_SECRET** (see command above)
- [ ] Enable **HTTPS in IIS** with a valid TLS certificate
- [ ] Restrict **MongoDB access** (bind to localhost or enable auth)
- [ ] Create **AD security groups** for role-based access
- [ ] Set `NODE_ENV=production` in `.env`
- [ ] Review `logs/combined.log` for authentication events

---

## Deployment: IIS with iisnode

1. Install [iisnode](https://github.com/Azure/iisnode/releases)
2. Create IIS site → Physical path: project folder, HTTPS binding with your TLS cert
3. Set Application Pool → .NET CLR Version: **No Managed Code**
4. Run `npm install --production` in the project folder
5. Set permissions:
   ```powershell
   icacls "C:\IdentityFabric" /grant "IIS AppPool\IdentityFabricWeb:(OI)(CI)M" /T
   ```

The included `web.config` handles routing automatically.

## Deployment: Windows Service + IIS Reverse Proxy

1. Install as a Windows Service:
   ```powershell
   npm run install-service   # Run as Administrator
   ```
2. Install IIS **URL Rewrite** + **ARR** modules
3. In `web.config`, uncomment the reverse proxy rule, comment out iisnode
4. Create IIS site with HTTPS binding pointing to the project folder

```powershell
# Manage the service
net start IdentityFabricWeb
net stop IdentityFabricWeb
npm run uninstall-service
```

---

## API Reference

All `/api` routes require authentication unless noted.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | Health check |
| GET | `/api/auth/methods` | No | Available auth methods |
| GET | `/api/auth/me` | Yes | Current user info |
| POST | `/api/auth/login/local` | No | Local account login |
| POST | `/api/auth/login/ldap` | No | LDAP login |
| GET | `/api/auth/entra` | No | Start Entra ID SSO flow |
| POST | `/api/auth/logout` | Yes | End session |
| GET | `/api/stats` | Yes | Dashboard statistics |
| GET | `/api/search?q=...` | Yes | Global text search |
| GET | `/api/users/:id` | Yes | User detail |
| GET | `/api/reports` | Yes | List available reports |
| GET | `/api/reports/:id` | Yes | Run a pre-built report |
| GET | `/api/export/:id` | Yes | Export report as CSV |
| POST | `/api/query/custom` | Admin | Run custom aggregation pipeline |
| GET | `/api/distinct/:field` | Yes | Distinct values for filters |

---

## Project Structure

```
identity-fabric-web/
├── public/
│   └── index.html              # SPA frontend
├── scripts/
│   ├── create-local-user.js    # Local account management
│   └── install-service.js      # Windows Service installer
├── src/
│   ├── app.js                  # Express app (security, middleware, routes)
│   ├── server.js               # Entry point
│   ├── config/
│   │   ├── index.js            # Environment configuration
│   │   └── logger.js           # Winston logger
│   ├── middleware/
│   │   ├── auth.js             # Passport (local + ldapts + MSAL)
│   │   └── requestLogger.js    # Request logging
│   ├── routes/
│   │   ├── auth.js             # Auth endpoints (rate-limited)
│   │   └── api.js              # Data, reports, export endpoints
│   └── services/
│       ├── mongo.js            # MongoDB connection & queries
│       └── reports.js          # 12 pre-built reports
├── web.config                  # IIS configuration
├── .env.example                # Environment template
└── package.json
```
