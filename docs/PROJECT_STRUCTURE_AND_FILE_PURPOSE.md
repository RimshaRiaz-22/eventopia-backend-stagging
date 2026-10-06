# Eventopia Backend: Folder & File Structure Guide

This document explains the project layout, what each folder is responsible for, and the purpose of important files.

## Tech Overview

- Runtime: Node.js
- Framework: Express
- Database: PostgreSQL (`pg`)
- Auth: JWT + sessions
- Integrations: Stripe, GeoNames, SMTP email

---

## Root-Level Structure

```text
eventopia-stagging-backend/
├── server.js
├── package.json
├── package-lock.json
├── .gitignore
├── doc_env.md
├── captain-definition
├── run-init-migration.js
├── docs/
├── migrations/
├── scripts/
├── src/
└── uploads/
```

## Root Files (Purpose)

- `server.js`: Application entry point. Loads environment variables and starts the Express server.
- `package.json`: Project metadata, scripts, and dependencies.
- `package-lock.json`: Locked dependency versions for reproducible installs.
- `.gitignore`: Files/folders excluded from git.
- `doc_env.md`: Environment variable template/reference used for local setup.
- `captain-definition`: Deployment config for CapRover.
- `run-init-migration.js`: Utility runner for initialization SQL/migration scripts.

---

## `src/` (Main Application Code)

```text
src/
├── app.js
├── config/
├── controllers/
├── db/
├── middlewares/
├── routes/
├── services/
├── templates/
├── utils/
└── __tests__/
```

### `src/app.js`

Central Express app configuration:
- Registers middleware (`express.json`, cookies, CORS, request metadata).
- Mounts routes (`/api/...` plus some legacy direct mounts).
- Handles Stripe webhook raw-body route.
- Exposes `GET /` and `GET /health`.
- Initializes scheduled jobs.

### `src/config/`

Configuration modules/constants used by services and controllers.

Examples:
- `territory.config.js`: territory inventory status constants.

### `src/routes/`

Defines API endpoints and maps URL paths to controllers.

Examples:
- `auth.routes.js`: login/register/token/auth routes.
- `events.routes.js`, `tickets.routes.js`, `orders.routes.js`: event ticketing flow.
- `promoters.routes.js`: role/business domain routes.
- `escrow.routes.js`, `ledger.routes.js`, `wallet.routes.js`, `credit.routes.js`: financial routes.
- `index.js`: consolidated route registry used by `/api`.
- `v1.routes.js`: namespaced legacy/contract routes under `/api/v1`.

### `src/controllers/`

HTTP layer handlers:
- Validate request inputs.
- Call service methods.
- Return standardized API responses.

Controller naming usually matches route/domain:
- `auth.controller.js`, `events.controller.js`, `orders.controller.js`, etc.
- Feature-specific controllers include `stripeWebhooks.controller.js`, `ticketAccess.controller.js`.

### `src/services/`

Business logic and integrations live here. This is the core domain layer.

Major service categories:
- **Auth/session/security:** `session.service.js`, `accessToken.service.js`, `otp.service.js`, `access.service.js`
- **Events/tickets/orders:** `orderFulfillment.service.js`, `orderStripePayment.service.js`, `settledTicket.service.js`, `qr.service.js`
- **Finance/ledger/escrow:** `ledgerCore.service.js`, `platformLedger.service.js`, `escrow.service.js`, `escrowLiability.service.js`, `walletMe.service.js`
- **Role ecosystems:** `promoterReferral.service.js`, `territoryLicenceInventory.service.js`
- **Integrations:** `stripeClient.js`, `geonames.service.js`, `email.service.js`, `nodaPayment.service.js`
- **Schedulers/jobs/monitoring:** `scheduler.service.js`, `serviceFeeJob.service.js`, `jobMonitoring.service.js`

### `src/middlewares/`

Reusable request/response middleware.

Examples:
- `auth.middleware.js`: authentication and user context.
- `access.middleware.js`: role/permission enforcement.
- `rateLimiter.middleware.js`: request throttling.
- `upload.middleware.js`: multipart/file upload handling.
- `audit.middleware.js`: audit trail context.
- `requestMeta.middleware.js`: request id/meta injection.
- `viewTracking.middleware.js`: event view tracking.

### `src/db/`

Database connectivity, initialization, and schema files.

- `index.js`: PostgreSQL connection pool.
- `initDb.js`: database bootstrap/init helpers.
- `init.sql`: primary schema (tables, indexes, constraints).
- `liveinit.sql`: alternate/extended schema script.
- `seed-data/categories-tags.json`: seed data used by scripts.

### `src/templates/`

Template generators for outbound emails.

- `emailTemplates.js`: email HTML/text templates for platform notifications.

### `src/utils/`

Small shared helpers used across layers.

Examples:
- `standardResponse.js`: common API response structure.
- `crypto.js`: token/password/hash helper utilities.
- `ticketQr.util.js`: ticket QR payload/signing helpers.
- `eventStatus.js`: event status constants/rules.

### `src/__tests__/` and `src/services/__tests__/`

Automated tests (API/integration/service-level).

Examples:
- `ledger.api.test.js`
- `ledger.integration.test.js`
- `services/__tests__/ledgerCore.service.test.js`

---

## `docs/` (Project Documentation)

Project documentation and API contracts.

Examples:
- `API_DOCUMENTATION.md`: endpoint-level API reference.
- `API_CONTRACTS_EVENTS_TICKETS_ORDERS.md`: contract notes for core event/ticket/order flows.
- `AUTH_LOGIN_REGISTER_BY_ROLE.md`: role-based auth behavior.
- `MONEY_SPLITTING_FLOW_ESCROW_CREDIT_ENGINE.md`: finance and ledger flow notes.
- `postman/`: Postman collections and environments for manual API testing.

---

## `migrations/` (Database Migration SQL)

Incremental migration SQL scripts and migration runner SQL.

Examples:
- `001_add_core_tables.sql`
- `002_ledger_entries_immutable.sql`
- `003_add_pending_approval_event_status.sql`
- `run_migration.sql`

---

## `scripts/` (Operational Utilities)

Local/admin scripts for setup, seeding, and maintenance.

Examples:
- `bootstrap-db.js`: initial DB setup/bootstrap.
- `run-migration.js`: execute SQL migration files.
- `create-first-admin.js`: create initial admin user.
- `seed-ledger-entries.js`, `seed-test-escrow-data.js`: domain seed utilities.
- `fix-permissions-and-env.sh`: local helper to fix ownership/permissions and create `.env`.

---

## `uploads/`

Local storage directory for uploaded files. Served by Express as static assets via `/uploads`.

---

## How the App Flows (High-Level)

1. `server.js` starts the process and loads env.
2. `src/app.js` builds middleware + route stack.
3. `src/routes/*.routes.js` maps endpoint → controller.
4. `src/controllers/*.controller.js` handles request/response.
5. `src/services/*.service.js` applies business logic and DB/integration operations.
6. `src/db/index.js` executes SQL via PostgreSQL pool.

---

## Naming Conventions Used

- `*.routes.js`: URL mapping only.
- `*.controller.js`: HTTP handling and response shaping.
- `*.service.js`: domain rules and external interactions.
- `*.middleware.js`: reusable request pipeline units.
- `*.util.js`: small utility helpers.

This separation keeps logic maintainable and makes features easier to test and extend.
