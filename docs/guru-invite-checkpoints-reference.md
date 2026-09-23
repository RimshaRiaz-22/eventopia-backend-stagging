# Guru Invite Flow — Checkpoints, APIs & Error Codes (Reference)

This is the quick-reference version of how the King-invite acceptance flow actually
works. For the design reasoning and the bug that led here, see
[`guru-invite-approval-before-acceptance.md`](./guru-invite-approval-before-acceptance.md).

> **Note:** an earlier version of this flow split acceptance into 3 checkpoints
> across 2 calls (a separate profile-submission endpoint before password). That
> was reverted — `POST /auth/guru/register` is the same single existing call it
> always was (name + contract + phone + password together). No new endpoint
> was kept.

## The 2 checkpoints, in one picture

```
King sends invite
        │
        ▼
┌───────────────────────┐   guru opens the        ┌──────────────────────────────────┐
│ CHECKPOINT 1           │   emailed link           │ CHECKPOINT 2                      │   LOGIN WORKS
│ Invite not opened      │ ───────────────────────► │ Not registered yet                │ ──────────►
│ email_status='pending' │                          │ email_status='verified'          │
│                        │                          │ password_hash IS NULL            │
└───────────────────────┘                          └──────────────────────────────────┘
                                                       guru fills in name/contract/phone/
                                                       password and submits ONE call —
                                                       POST /auth/guru/register
```

Each checkpoint is an existing DB column — no new tables, no new columns:

| Checkpoint | What it means | Field that flips | Set by |
|---|---|---|---|
| 1. Opened | Guru clicked the invite link | `users.email_status = 'verified'` | `GET /gurus/invites/validate/:inviteToken` |
| 2. Registered | Guru submitted name/contract/phone/password together — account is now fully active | `users.password_hash IS NOT NULL` | `POST /auth/guru/register` |

The King can approve the application (`PATCH /admin/gurus/:id/application-status`) at **any point** in this sequence — it doesn't skip or reset either checkpoint. Login only cares about checkpoints 1–2, not whether the King has clicked approve.

## What the Guru sees if they try to log in early

`POST /auth/login` checks checkpoints 1–2 (in that order) **before** its normal "pending approval" message, so an invited Guru always gets a specific, actionable error instead of a generic one.

| Situation | HTTP | `code` | `message` (example) |
|---|---|---|---|
| Checkpoint 1 not done (never opened the link) | 403 | `ACCOUNT_SETUP_REQUIRED` | "Your account setup is remaining. Please check your email for the invite link." |
| Checkpoint 1 done, checkpoint 2 not done (opened but never finished registering) | 403 | `PASSWORD_NOT_SET` | "Please set your password to activate your account." |
| Invite expired at either of the above | 403 | *(same code as above)* | same message + " Your invitation link has expired — please resend it." (no `inviteToken` in `data`) |
| Data inconsistency (invite already used but no password — shouldn't normally happen) | 403 | `ACCOUNT_SETUP_ERROR` | "There was a problem completing your account setup. Please contact support." |
| Not an invited Guru at all — wrong password, or self-registered applicant still pending | 401 / 403 | *(none)* | existing generic messages, unchanged |

Every checkpoint error has this shape:
```json
{
  "error": true,
  "message": "Please set your password to activate your account.",
  "code": "PASSWORD_NOT_SET",
  "data": {
    "email": "guru@example.com",
    "inviteToken": "a1b2c3...64-hex-chars"
  }
}
```
`inviteToken` is `null` when the invite has expired (it's no longer usable to deep-link anywhere).

## APIs

### 1. `GET /gurus/invites/validate/:inviteToken` — open the invite (checkpoint 1)

Public. No auth. Called by the frontend the moment the invite link is opened.

**Side effect:** marks `email_status = 'verified'` the first time it succeeds (idempotent — safe to call repeatedly).

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

**Errors**
| HTTP | `code` | Meaning |
|---|---|---|
| 404 | `INVITE_NOT_FOUND` | Bad/removed token |
| 410 | `INVITE_EXPIRED` | Past `expires_at` |
| 409 | `INVITE_ALREADY_USED` | Already fully accepted — tell them to log in |

### 2. `POST /auth/guru/register` — complete registration (checkpoint 2)

Public (token-authenticated — the token itself is the credential). This is the **only** call needed to finish accepting an invite; it sets the profile fields and the password together, activates the account, auto-approves the application, and logs the Guru in.

**Request body**
```json
{
  "invite_token": "a1b2c3...",
  "name": "Jane Doe",
  "contract_name": "Guru Agreement V1",
  "phone": "+447911123456",
  "password": "StrongP@ssw0rd"
}
```
(`full_name` is also accepted in place of `name`; `avatar_url` is optional.)

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
| 404 | No placeholder account found for this invite (shouldn't normally happen) |
| 409 | Email already fully registered — log in instead |
| 403 | Application was rejected, or account was blocked |

### 3. `POST /auth/guru/invites/resend` — get a fresh token (unchanged)

Public. `{ "email": "guru@example.com" }` (or `{ "invite_token": "..." }` as a fallback). Reissues a new token + 15-minute expiry; does **not** reset checkpoint 1 progress already recorded on `users.email_status` — only the token itself is renewed.

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

### 4. `POST /auth/login` — where the checkpoint errors surface

Unchanged request body (`{ email, password }`). See the error table above for what changes — everything else about this endpoint (blocked accounts, self-registration "pending approval", wrong password) is untouched.

## Frontend pieces (already wired)

- `GuruInviteRegister.jsx` — single-step form (name, contract name, phone, password), same as it always was. Calls `GET /gurus/invites/validate/:token` on mount (to auto-verify + fail fast on an already-expired/invalid link), then `POST /auth/guru/register` on submit.
- `Login.jsx` — on a login error with one of the 3 codes above, opens `AccountSetupModal.jsx` instead of a plain toast. "Continue Setup" re-validates the token in place and, if still valid, deep-links to `/auth/guru/register?token=...`; "Resend Invite Email" only fires on an explicit click.

## Postman collection checklist

Only 3 calls are needed to test the invite flow end to end:
1. `GET {{base_url}}/api/gurus/invites/validate/{{invite_token}}`
2. `POST {{base_url}}/api/auth/guru/register` — body: `invite_token, name, contract_name, phone, password`
3. `POST {{base_url}}/api/auth/login` — to see the checkpoint errors before step 2 is done
