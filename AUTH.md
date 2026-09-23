# Eventopia Backend Auth, Explained Simply

## The idea in one paragraph

A user signs up or logs in and gets **one token**: a JWT **access token** that lasts **24 hours**. The client sends it on every request as `Authorization: Bearer <token>`.

There is no refresh token. After 24 hours the token stops working, the API answers `401` with `code: "SESSION_EXPIRED"` and the message *"Your session has expired. Please log in again to continue."*, and the web app sends the user to the login page.

Every login also creates a **session** row in the database. A token is only valid if its session is still alive, so we can "log out" a device by killing its session. The session expires at the same moment as the token.

---

## Where the code lives

All paths are under `src/`.

| What | File |
|---|---|
| URL list | `routes/auth.routes.js` |
| Request handlers (register, login, OTP, etc.) | `controllers/auth.controller.js` |
| "Is this user logged in? Are they allowed?" | `middlewares/auth.middleware.js` |
| Create, check and revoke sessions | `services/session.service.js` |
| Create and check OTP codes | `services/otp.service.js` |
| Token and hashing helpers | `utils/crypto.js` |

---

## Roles

| Role | Who they are |
|---|---|
| `buyer` | Normal ticket buyer (default) |
| `promoter` | Creates events and sells tickets |
| `guru` | Recruits promoters |
| `admin`, `founder`, `staff_*` | Internal roles, **cannot** be self-selected at signup |
| `kings_account` | Special ledger account with its own OTP login. Invites and approves Gurus |

Users pick one of `buyer`, `promoter` or `guru` at signup. The Network Manager role has been removed: registering with it returns `400`, and any leftover Network Manager account is refused at login.

---

## Main flows

### 1. Register and verify email (normal signup)

```
POST /auth/register        -> creates user (email_status = pending) + sends OTP
POST /auth/otp/verify      -> checks OTP, marks email verified, logs user in (returns tokens)
POST /auth/otp/resend      -> sends a new OTP
```

- Password rules: at least 8 characters, with an uppercase letter, a lowercase letter, a number and a special character.
- The OTP is valid for **10 minutes** and allows **5 wrong attempts**.
- Signup OTPs are 4 digits. Other OTPs are 6 digits.

### 2. Login

```
POST /auth/login           -> email + password -> tokens
```

Checks, in order:
1. The user exists and `status` is `active`.
2. The account is not `blocked`.
3. The account is not a leftover `network_manager` account (refused with `403`).
4. `account_status` must be `active`. Promoters and gurus stay `pending` until approved.
5. The password matches (bcrypt).

### 3. Staying logged in and logging out

```
POST /auth/logout          -> kill the current session
POST /auth/logout-all      -> kill every session for this user
```

There is no refresh endpoint. When the 24h token expires the user logs in again. The same happens if the session is revoked (logout, password reset or change) or the user's roles change (for example after an admin approves them).

### 4. Forgot / reset password

```
POST /auth/forgot-password -> makes a reset token (valid 1 hour) and emails a link
POST /auth/reset-password  -> token + new password -> sets password, kills all sessions
POST /auth/change-password -> (logged in) current + new password, kills all OTHER sessions
```

`change-password` is mounted from `routes/settings.routes.js`.

### 5. Invite-based signup

| Flow | Created by | Endpoint to register |
|---|---|---|
| **Guru invite** | King's Account, founder or admin (`POST /auth/gurus/invites`) | `POST /auth/guru/register` with `invite_token` |
| **Promoter referral** | Guru (`POST /auth/gurus/promoter/referral-invites`) | `POST /auth/promoter/register` with `referral_token` |

- Invite links expire after **15 minutes** by default (allowed range is 1 to 1440 minutes).
- Each invite can only be used once.
- The email comes from the invite, not from the form.
- `POST /auth/guru/invites/resend` and `POST /auth/promoter/referral-invites/resend` issue a new link when the old one expired.
- `GET /auth/referrals/validate/:token` lets the frontend check a promoter referral token before showing the form.
- `POST /admin/gurus/create-invite` creates **promoter** invites only (`role: "promoter"` is required); those are accepted at `POST /auth/register` with `invite_token`. A Guru invite sent to `POST /auth/register` is refused.

### 5b. Guru flows

**A. Invited by the King's Account (active immediately, no approval)**

```
POST /auth/gurus/invites                 King sends the invite (email with link, 15 min by default)
GET  /gurus/invites/validate/:token      public: page verifies the invite is active
POST /auth/guru/register                 Guru accepts: creates an active Guru and logs them in
```

**B. Guru registers by themselves (pending until the King activates)**

```
POST /auth/register  { role: "guru" }    account starts as "requested"; OTP is emailed
POST /auth/otp/verify                    email verified; Guru gets a token to finish the profile
POST /gurus/applications                 Guru completes the profile; account becomes "pending"
POST /gurus/activation-fee/commit        Guru chooses upfront or negative balance
GET  /admin/gurus/applications           King sees the list (?status=pending, ?page=, ?limit=)
POST /admin/gurus/:applicationId/approve King activates (fee must be committed first)
POST /admin/gurus/:applicationId/reject  King rejects, body: { rejection_reason }
```

Until the King activates the account, `POST /auth/login` answers `403` (pending approval). Approving revokes the Guru's sessions, so they log in again and get the Guru role. The admin routes allow `kings_account`, `founder` and `admin`.

### 6. OAuth (Google, Facebook, Clerk)

```
POST /auth/oauth/register  -> sign up or log in with an OAuth identity
POST /auth/oauth/callback  -> exchange a Clerk token for app tokens
```

New OAuth users with no role selected get `requiresRoleSelection: true` and must pick one. Roles that need approval return `pendingApproval: true` instead of tokens.

### 7. King's Account (no password)

```
POST /auth/king/register   -> creates the account (blocked when NODE_ENV=production)
POST /auth/king/otp/send   -> emails a 6-digit code
POST /auth/king/otp/verify -> code -> tokens with role kings_account
```

### 8. Profile

```
GET   /auth/me      -> current user, applications, preferences, promoter wallet info
PATCH /auth/me      -> update name / avatar
POST  /auth/setup   -> set full name for the first time
```

---

## How a request gets checked

`requireAuth` runs on protected routes:

1. Read the `Authorization: Bearer <token>` header.
2. Verify the JWT signature and expiry.
3. Look up the session. It must exist, not be revoked, not be expired, and the user must be active.
4. Compare `rolesVersion` in the token with the user's current value. If an admin changed the user's roles, old tokens stop working.
5. Load the user and set `req.user`, `req.userRoles` and `req.sessionId`.

After that, role guards decide whether the user may use the route:

| Guard | Allows |
|---|---|
| `requireRole('a','b')` | Any one of the listed roles |
| `requireAdmin` | admin |
| `requireFounderOrAdmin` | founder or admin |
| `requireKingsAccount` | kings_account |
| `requirePromoter` / `requireActivePromoter` | promoter (active = `account_status` is `active`) |
| `requireEventOwnership` / `requireTicketTypeOwnership` | The promoter who owns that event or ticket type |
| `requireOrderOwnership` / `requireTicketOwnership` | The buyer who owns that order or ticket |

---

## Database tables involved

- `users`: account, role, `account_status`, `email_status`, `roles_version`
- `sessions`: one row per login (expiry, `revoked_at`)
- `devices`: optional device tracking
- `otps`: OTP **hash**, purpose, expiry, attempt count, `consumed_at`
- `password_reset_tokens`, `email_verification_tokens`
- `guru_invites`, `promoter_referral_invites`, `guru_referrals`
- Application tables: `guru_applications`, `promoter_applications`

---

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `JWT_SECRET` | Signs access tokens | **none, must be set** |
| `JWT_ACCESS_EXPIRE` | Token **and** session life. Number plus `s`, `m`, `h` or `d` | `24h` |
| `FRONTEND_URL` | Base for invite links | `http://localhost:5173` |
| `NODE_ENV` | `production` disables King's register | none |

---

## Known problems (fix before going live)

Ranked by risk:

1. **OTPs and reset tokens are returned in API responses** (`register`, `resendOtp`, `forgotPassword`). Anyone can request a reset for someone else's email and get the token, which allows account takeover.
2. **OAuth endpoints trust the client.** `oauth/register` and `oauth/callback` don't verify the OAuth or Clerk token, so a caller can claim any email. `oauthCallback` is also broken as written (undefined `getTokenExpiry`, wrong token helper, no session).
3. **Fallback JWT secret** `"default-secret-change-in-production"` is used when `JWT_SECRET` is missing.
4. **Weak OTPs.** `Math.random()`, 4 digits for signup, and resending gives fresh attempts, so they can be brute-forced.
5. **Resend-invite endpoints are public** and return the new invite token, so anyone who knows an invited email can take the invite.
6. **No rate limiting on auth routes.** Login, OTP, forgot-password and register are unprotected.
7. **`role: "promoter"` at register** creates an active account without approval.
8. **Reset password** only checks length, not full strength rules.
9. ~~**Refresh token gaps.**~~ Fixed: refresh tokens were removed, and `expires-at` now returns the real session expiry.
10. **`requireAuth` role fallback bug.** `filter(...) || fallback` never falls back. `req.user` also lacks `email_status`.
11. **Email case sensitivity.** `A@x.com` and `a@x.com` can be different accounts.
12. **Plaintext tokens.** Invite and reset tokens are stored in plaintext.

---

## Session expiry: how the client is told

When a token or session is no longer valid, `requireAuth` returns:

```json
{ "error": true, "code": "SESSION_EXPIRED", "message": "Your session has expired. Please log in again to continue.", "data": null }
```

`code: "SESSION_EXPIRED"` is used for: expired or invalid JWT, session missing, revoked or past its expiry, and role changes (with a different message). Other 401s (wrong password, missing header) do **not** carry the code, so the web app only logs the user out when the session really ended.

Rollout note: run `migrations/006_sessions_drop_refresh_token.sql` **before** deploying this code, because `sessions.refresh_token_hash` used to be `NOT NULL`.
