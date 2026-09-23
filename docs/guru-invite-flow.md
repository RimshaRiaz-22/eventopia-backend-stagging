# Guru Invite Flow (King → Guru) — Complete Reference

Single source of truth for how a King's Account invites a Guru, how the Guru
accepts, and what happens if the Guru tries to log in before finishing. Covers
backend APIs, DB fields touched, and the frontend pages/components involved.

## Actors & terms

- **King's Account** — admin who sends the invite and can approve/reject/block a Guru application at any time, independent of where the Guru is in the flow below.
- **Guru** — the invitee. Starts as a password-less placeholder account created the moment the King sends the invite.
- **Invite token** — a single-use, opaque 64-char hex string (`guru_invites.invite_token`), emailed as a link. Not a JWT. Has its own `expires_at` (15 minutes by default) and `used_at` (null until accepted).

## End-to-end flow

```
1. King sends invite                     POST /auth/gurus/invites
        │
        │  creates a placeholder `users` row (role=NULL, no password)
        │  + a `guru_applications` row (pending, fee waived)
        │  + a `guru_invites` row (token, 15 min expiry)
        │  emails the registration link
        ▼
2. Guru opens the emailed link           GET /gurus/invites/validate/:inviteToken
        │
        │  marks users.email_status = 'verified' (first time only)
        ▼
3. Guru fills in the registration form   POST /auth/guru/register
        │  (name, contract name, phone, password, optional photo)
        │
        │  sets password_hash, activates the account, auto-approves
        │  the application, marks the invite used, logs the Guru in
        ▼
4. Guru is fully active — normal login (POST /auth/login) works from here on
```

The King can call `PATCH /admin/gurus/:id/application-status` to approve or reject
**at any point** in steps 1–3 — it doesn't skip, block, or reset anything above.
An approval before step 3 just means the account is `account_status='active'`
early; the Guru still can't log in until they set a password in step 3.

## What happens if the Guru tries to log in before step 3

`POST /auth/login` checks this **before** its normal "pending approval" message,
so the Guru always gets something specific instead of a generic error.

| State | HTTP | `code` | Message |
|---|---|---|---|
| Never opened the invite link (`email_status != 'verified'`) | 403 | `ACCOUNT_SETUP_REQUIRED` | "Your account setup is remaining. Please check your email for the invite link." |
| Opened the link but never finished the registration form (`password_hash IS NULL`) | 403 | `PASSWORD_NOT_SET` | "Please set your password to activate your account." |
| Either of the above, and the invite has since expired | 403 | *(same code)* | same message + " Your invitation link has expired — please resend it." (`inviteToken` omitted from `data`) |
| Data inconsistency — invite marked used but no password was ever set (shouldn't normally happen) | 403 | `ACCOUNT_SETUP_ERROR` | "There was a problem completing your account setup. Please contact support." |
| Anything else (wrong password, blocked, self-registered applicant still pending, etc.) | 401/403 | — | existing generic messages, unchanged |

Error shape:
```json
{
  "error": true,
  "message": "Please set your password to activate your account.",
  "code": "PASSWORD_NOT_SET",
  "data": { "email": "guru@example.com", "inviteToken": "a1b2c3...64-hex" }
}
```
`inviteToken` is `null` once the invite has expired.

Implemented in `src/services/guruInviteStatus.service.js` (`getPendingGuruInviteLoginBlock`), called from `login()` in `auth.controller.js` right after the blocked/network-manager checks and before the generic pending-approval gate.

## Backend APIs

### 1. `POST /auth/gurus/invites` — King sends the invite

Auth: King's Account / founder / admin (`requireAuth`, role checked inline).

**Request**
```json
{
  "email": "guru@example.com",
  "name": "Jane Doe",
  "contract_name": "Guru Agreement V1",
  "expires_in_minutes": 15
}
```
`name` and `contract_name` optional; `expires_in_minutes` optional, 1–1440, defaults to 15.

**What it does**
- Finds or creates a placeholder `users` row: `role=NULL, password_hash=NULL, account_status='pending', email_status='pending'`. 409 if the email already has a password or is already `role='guru'`.
- Upserts a `guru_applications` row: `account_status='pending', activation_fee_status='not_required'` (invited Gurus never pay the £250 fee).
- Generates the invite token, inserts into `guru_invites`, emails the registration link.

**Success — `201`**
```json
{
  "error": false,
  "message": "Guru invitation has been sent to guru@example.com. The link expires in 15 minutes...",
  "data": {
    "email": "guru@example.com",
    "expires_at": "2026-09-23T10:15:00.000Z",
    "guru_id": 123,
    "invite_token": "a1b2c3...",
    "registration_url": "https://.../auth/guru/register?token=a1b2c3..."
  }
}
```

### 2. `GET /gurus/invites/validate/:inviteToken` — open the invite

Public. Called the moment the invite link is opened.

**Side effect**: marks `email_status = 'verified'` the first time it succeeds (idempotent).

**Success — `200`**
```json
{
  "error": false,
  "message": "Invitation verified successfully. You can now complete your registration.",
  "data": {
    "inviteToken": "a1b2c3...",
    "email": "guru@example.com",
    "name": "Jane Doe",
    "expiresAt": "2026-09-23T10:15:00.000Z",
    "createdBy": "Eventopia Admin",
    "isValid": true,
    "emailVerified": true
  }
}
```

**Errors**: `404 INVITE_NOT_FOUND` · `410 INVITE_EXPIRED` · `409 INVITE_ALREADY_USED`

### 3. `POST /auth/guru/register` — complete registration

Public (token-authenticated — the token is the credential). The **only** call needed to finish accepting an invite: sets the profile and password together, activates the account, auto-approves the application, marks the invite used, and logs the Guru in.

**Request**
```json
{
  "invite_token": "a1b2c3...",
  "name": "Jane Doe",
  "contract_name": "Guru Agreement V1",
  "phone": "+447911123456",
  "password": "StrongP@ssw0rd",
  "avatar_url": "https://your-cdn.com/avatar.jpg"
}
```
`full_name` accepted in place of `name`. `avatar_url` optional — see frontend section for how it's produced.

**Success — `201`**
```json
{
  "error": false,
  "message": "Your Guru account has been created. Welcome aboard! You are now logged in.",
  "data": {
    "access_token": "eyJhbGciOi...",
    "user": {
      "id": 123,
      "name": "Jane Doe",
      "email": "guru@example.com",
      "phone": "+447911123456",
      "avatar_url": "https://your-cdn.com/avatar.jpg",
      "role": "GURU",
      "contract_name": "Guru Agreement V1",
      "credit_balance": -295,
      "level": 1,
      "sprint_active": false,
      "referral_code": "GURU-XXXX"
    },
    "expires_at": "2026-09-24T10:15:00.000Z"
  }
}
```

**Errors**
| HTTP | Meaning |
|---|---|
| 400 | Missing `invite_token`/`name`/`contract_name`/`password`/`phone`, or weak password |
| 422 | Phone not in E.164 format |
| 401 | Invite token invalid |
| 410 | Invite expired or already used |
| 404 | No placeholder account found for this invite |
| 409 | Email already fully registered — log in instead |
| 403 | Application was rejected, or account was blocked |

### 4. `POST /auth/guru/invites/resend` — get a fresh token

Public. `{ "email": "guru@example.com" }` (or `{ "invite_token": "..." }` as a fallback). Reissues a new token + 15-minute expiry. Does not reset `email_status` — only the token itself is renewed.

**Success — `200`**
```json
{
  "error": false,
  "message": "New invitation sent to guru@example.com! Check your inbox. This link expires in 15 minutes.",
  "data": {
    "email": "guru@example.com",
    "expires_at": "2026-09-23T10:30:00.000Z",
    "invite_token": "d4e5f6...",
    "registration_url": "https://.../auth/guru/register?token=d4e5f6..."
  }
}
```

### 5. `POST /files/avatar` — image upload (used by the registration form)

Public (no `requireAuth` applied, despite the route comment) — needed because the Guru has no account yet at this point. Multipart form field `avatar`.

**Success — `200`**
```json
{ "error": false, "message": "Avatar uploaded successfully.", "data": { "avatarUrl": "https://.../uploads/xyz.png" } }
```

### 6. `POST /auth/login` — where the checkpoint errors surface

Unchanged request body (`{ email, password }`). See the error table above for what's new — everything else (blocked accounts, wrong password, self-registration pending-approval) is untouched.

## DB fields touched (no schema changes were needed)

| Table | Field | Meaning |
|---|---|---|
| `users` | `email_status` | `'pending'` → `'verified'` on opening the invite link |
| `users` | `password_hash` | `NULL` → set on completing registration |
| `users` | `role`, `account_status`, `guru_active`, `guru_active_until` | flip to `'guru'` / `'active'` / `TRUE` / `+1yr` on completing registration |
| `guru_applications` | `account_status` | `'pending'` → `'approved'` on completing registration (no separate King approval needed for invited Gurus) |
| `guru_applications` | `activation_fee_status` | `'not_required'` — set at invite time, invited Gurus never pay |
| `guru_invites` | `used_at` | `NULL` → timestamp on completing registration (single-use enforcement) |

## Frontend

### `GuruInviteRegister.jsx` (`WEB/EVENTOPIA-WEB/src/pages/Auth/Guru/`)

Single-step form. On mount, calls the validate API (fails fast + shows the expired/resend modal if the link is already dead, and pre-fills the name field if the King supplied one at invite time). On submit:
1. Uploads the photo if one was chosen (`uploadAvatarIfNeeded` → `POST /files/avatar`)
2. Calls `POST /auth/guru/register` with everything
3. Logs the Guru in and redirects to `/dashboard/guru`

Fields: Profile Photo (optional, square dashed dropzone — same pattern as the self-registration wizard's `GuruRegister.jsx`, local preview via `URL.createObjectURL`, upload deferred to submit), Full Name + Contract Name (one row), Phone Number, Password.

### `AccountSetupModal.jsx` (`WEB/EVENTOPIA-WEB/src/pages/Auth/`)

Shown from `Login.jsx` when a login attempt returns `ACCOUNT_SETUP_REQUIRED`, `PASSWORD_NOT_SET`, or `ACCOUNT_SETUP_ERROR`. Two actions, side by side:
- **Continue Setup** — re-validates the token in place (`GET /gurus/invites/validate/:token`) before navigating anywhere; if it's since expired, the modal switches to an "Invitation Expired" state instead of navigating to a dead page. Only navigates to `/auth/guru/register?token=...&email=...` once confirmed valid.
- **Resend Invite Email** — only ever fires on an explicit click, never automatically.

### `TokenExpirationModal.jsx` (`WEB/EVENTOPIA-WEB/src/pages/Auth/Guru/`)

Shown when `GuruInviteRegister.jsx` itself discovers an expired/invalid token (e.g. someone opens a stale emailed link directly). Accepts a `defaultEmail` prop so the resend form doesn't make the Guru retype an email that's already known from context.

## Testing checklist (Postman)

Only 3 calls needed end-to-end:
1. `GET {{base_url}}/api/gurus/invites/validate/{{invite_token}}`
2. `POST {{base_url}}/api/auth/guru/register` — body: `invite_token, name, contract_name, phone, password` (+ optional `avatar_url`)
3. `POST {{base_url}}/api/auth/login` — to see the checkpoint errors before step 2 is done

To exercise the King-approves-early scenario: send the invite, approve via `PATCH /admin/gurus/:id/application-status {"status":"approved"}` **without** doing steps 1–2, then try step 3's login — expect `ACCOUNT_SETUP_REQUIRED` (or `PASSWORD_NOT_SET` if you did step 1 first).
