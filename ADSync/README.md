# Identity Fabric Web Application

A Node.js/Express web application for querying, searching, and reporting against your Identity Fabric MongoDB collection. Designed to run on Windows as an IIS-hosted application or Windows Service.

## Features

- **Dual Authentication** — LDAP (Active Directory) and Entra ID (Azure AD) SSO
- **Dashboard** — Live stats on active users, terminated accounts, data sources, and last sync time
- **Global Search** — Search across name, email, username, employee ID, department, and title
- **User Detail View** — Full attribute inspector with categorized fields and group memberships
- **12 Pre-built Reports**:
  - User Directory
  - Terminated Users
  - Department Breakdown
  - Group Membership Analysis
  - Stale Accounts & Last Login
  - Password Age & Expiry
  - Account Status Overview
  - Recently Created Accounts
  - Manager Direct Reports
  - Job Title Distribution
  - Data Quality Audit
  - Sync Status & Sources
- **Custom Query Builder** — Run ad-hoc MongoDB aggregation pipelines (admin only)
- **CSV Export** — Export any report to CSV
- **IIS & Windows Service** — Deploy behind IIS for certificate management or as a standalone Windows Service

---

## Prerequisites

| Component | Version | Purpose |
|-----------|---------|---------|
| **Node.js** | 18+ LTS | Runtime |
| **MongoDB** | 6.0+ | Identity Fabric database (from `ADSync.ps1`) |
| **IIS** | 10+ | Web hosting with TLS certificates |
| **iisnode** | 0.2.26+ | IIS ↔ Node.js bridge (Option A) |
| **URL Rewrite** | 2.1+ | Reverse proxy (Option B) |

---

## Quick Start (Development)

```bash
# 1. Clone or copy the project
cd identity-fabric-web

# 2. Install dependencies
npm install

# 3. Create your environment file
copy .env.example .env
# Edit .env with your MongoDB connection string and LDAP settings

# 4. Start the server
npm run dev

# 5. Open http://localhost:3000
```

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
SESSION_SECRET=<random-64-char-string>

# LDAP Authentication
LDAP_ENABLED=true
LDAP_URL=ldap://tuh.tuhs.prv
LDAP_BASE_DN=DC=tuh,DC=tuhs,DC=prv
LDAP_BIND_DN=CN=svc_identityfabric,OU=ServiceAccounts,DC=tuh,DC=tuhs,DC=prv
LDAP_BIND_PASSWORD=<service-account-password>
LDAP_SEARCH_FILTER=(sAMAccountName={{username}})

# Entra ID SSO (optional)
ENTRA_ENABLED=false
ENTRA_TENANT_ID=your-tenant-id
ENTRA_CLIENT_ID=your-client-id
ENTRA_CLIENT_SECRET=your-client-secret
ENTRA_REDIRECT_URI=https://identityfabric.yourdomain.com/auth/entra/callback

# Authorization — AD group names that grant roles
ADMIN_GROUPS=IdentityFabric-Admins
VIEWER_GROUPS=IdentityFabric-Admins,IdentityFabric-ReportViewers
```

---

## Deployment: IIS with iisnode (Recommended)

This approach lets IIS manage TLS certificates and process lifecycle.

### Step 1: Install iisnode

Download from: https://github.com/Azure/iisnode/releases

### Step 2: Create IIS Site

1. Open **IIS Manager**
2. Right-click **Sites** → **Add Website**
   - Site name: `IdentityFabricWeb`
   - Physical path: `C:\inetpub\identity-fabric-web` (copy project here)
   - Binding: HTTPS, port 443, select your TLS certificate
3. Set Application Pool → **.NET CLR Version: No Managed Code**

### Step 3: Install Dependencies

```powershell
cd C:\inetpub\identity-fabric-web
npm install --production
```

### Step 4: Configure Environment

Create `.env` file in the project root with your production settings.

### Step 5: Set Permissions

```powershell
# Grant IIS AppPool identity read/write access
icacls "C:\inetpub\identity-fabric-web" /grant "IIS AppPool\IdentityFabricWeb:(OI)(CI)M" /T
```

The included `web.config` handles routing automatically.

---

## Deployment: Windows Service + IIS Reverse Proxy

This approach runs Node.js as a Windows Service with IIS as a TLS-terminating reverse proxy.

### Step 1: Install as Windows Service

```powershell
cd C:\identity-fabric-web
npm install --production
npm run install-service      # Run as Administrator!
```

The service will be named **IdentityFabricWeb** and start automatically.

### Step 2: Configure IIS Reverse Proxy

1. Install **URL Rewrite** and **Application Request Routing** (ARR) modules
2. Enable ARR proxy:
   - IIS Manager → Server → Application Request Routing → Proxy → Enable proxy
3. Create IIS Site with HTTPS binding and your certificate
4. In `web.config`, uncomment the **OPTION B** reverse proxy rule and comment out iisnode

### Step 3: Manage the Service

```powershell
# Start/Stop
net start IdentityFabricWeb
net stop IdentityFabricWeb

# Check status
sc query IdentityFabricWeb

# View logs
Get-Content C:\identity-fabric-web\logs\combined.log -Tail 50

# Uninstall
npm run uninstall-service
```

---

## API Reference

All API routes are prefixed with `/api`. Authentication is required unless noted.

### Authentication
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/methods` | Available auth methods (no auth required) |
| GET | `/api/auth/me` | Current user info |
| POST | `/api/auth/login` | LDAP login (`{ username, password }`) |
| GET | `/api/auth/entra` | Initiate Entra ID SSO flow |
| POST | `/api/auth/logout` | End session |

### Data
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats` | Dashboard statistics |
| GET | `/api/search?q=...` | Global text search |
| GET | `/api/users/:id` | User detail by objectGUID |
| POST | `/api/users/query` | Advanced filtered query |
| GET | `/api/distinct/:field` | Distinct values for a field |

### Reports
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/reports` | List all available reports |
| GET | `/api/reports/:id` | Run a pre-built report |
| GET | `/api/export/:id` | Export report as CSV |
| POST | `/api/query/custom` | Run custom aggregation (admin only) |

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (no auth required) |

---

## Authorization Model

| Role | Access |
|------|--------|
| **admin** | All features including custom queries |
| **viewer** | Dashboard, search, pre-built reports, CSV export |

Roles are determined by AD group membership. Configure group names via `ADMIN_GROUPS` and `VIEWER_GROUPS` in `.env`.

---

## Project Structure

```
identity-fabric-web/
├── public/
│   └── index.html          # SPA frontend (login, dashboard, search, reports, query)
├── scripts/
│   └── install-service.js  # Windows Service installer/uninstaller
├── src/
│   ├── app.js              # Express application setup
│   ├── server.js           # Entry point (starts HTTP server)
│   ├── config/
│   │   ├── index.js        # Configuration from environment variables
│   │   └── logger.js       # Winston logger
│   ├── middleware/
│   │   ├── auth.js         # Passport strategies (LDAP + Entra ID)
│   │   └── requestLogger.js
│   ├── routes/
│   │   ├── auth.js         # Auth endpoints
│   │   └── api.js          # Data, search, reports, export endpoints
│   └── services/
│       ├── mongo.js        # MongoDB connection and query service
│       └── reports.js      # Pre-built report definitions and runner
├── web.config              # IIS configuration (iisnode + reverse proxy)
├── .env.example            # Environment variable template
├── package.json
└── README.md
```

---

## Troubleshooting

**LDAP bind fails**: Verify `LDAP_BIND_DN` and `LDAP_BIND_PASSWORD`. Test with `ldapsearch` or `Test-ComputerSecureChannel`.

**MongoDB connection refused**: Ensure MongoDB is running and accessible. Check firewall rules for port 27017.

**iisnode 500 errors**: Check `iisnode_logs/` directory. Ensure Node.js is in the system PATH. Verify AppPool identity has file permissions.

**Session not persisting**: Ensure MongoDB is accessible (sessions are stored there). Check that `SESSION_SECRET` is set.

**Entra ID callback fails**: Verify `ENTRA_REDIRECT_URI` matches the registered redirect URI in your Azure AD app registration exactly.
