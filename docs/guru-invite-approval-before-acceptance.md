# Guru Invite Flow — Checkpoint-Based Login Errors — Plan (v2)

## Decisions confirmed

- Self-registration flow (Path A) is correct as-is, no changes: register → submit application → fee commit → pending approval → King approves → login works. `login()`'s existing `accountStatus !== 'active'` → "pending approval" message already covers every pre-approval state correctly.
- Invited Gurus (Path B) stay fee-exempt (`activation_fee_status='not_required'`) — no fee-commit step is added to the invite flow.
- Opening the invite link (`GET /gurus/invites/validate/:inviteToken`) auto-verifies the account (`email_status='verified'`) the first time it succeeds — no separate confirm step.

## Why this requires restructuring invite acceptance, not just a smarter login message

Today `guruRegisterViaInvite` (`auth.controller.js:3420`) does everything in one atomic call: sets password, name, contract_name, phone, flips `email_status='verified'`, and auto-approves the application — all at once. That means "verified but application not submitted" and "application submitted but no password" are **not reachable states** under the current code; there's only "nothing done" and "fully done."

To make each checkpoint real and independently detectable at login time, invite acceptance needs to split into three steps, mirroring how self-registration already has distinct checkpoints (`register` → `otp/verify` → `applications` → `activation-fee/commit`).

## Checkpoint design (no new DB columns — reuses existing fields)

| # | Checkpoint | Reached via | Marker (already exists) |
|---|---|---|---|
| 1 | Invite opened / email verified | `GET /gurus/invites/validate/:inviteToken` (now writes, not just reads) | `users.email_status = 'verified'` |
| 2 | Profile submitted | **New** `POST /gurus/invites/:inviteToken/profile` | `guru_applications.agreed_to_terms = TRUE` |
| 3 | Password set → fully active | `POST /auth/guru/register` (payload simplified) | `users.password_hash IS NOT NULL` |

## Endpoint changes

### 1. `GET /gurus/invites/validate/:inviteToken` (existing, modified)
- Unchanged validation (token exists, not expired, not used).
- **New side effect**: on success, if `users.email_status != 'verified'` for the placeholder user, set `email_status='verified', email_verified_at=NOW()`. Best-effort, idempotent, non-blocking if already verified.
- **New in response**: include current checkpoint state — `{ emailVerified: boolean, profileSubmitted: boolean (from guru_applications.agreed_to_terms) }` — so the frontend can resume at the right step on page reload instead of always restarting at step 1.

### 2. `POST /gurus/invites/:inviteToken/profile` (new)
- Public, token-authenticated (same trust model as `guru/register` today — the token IS the credential).
- Body: `{ name (or full_name), contract_name?, phone, agreed_to_terms (required true), agreed_to_guru_agreement (required true) }`.
- Validates: token exists, unused, unexpired; `email_status === 'verified'` (checkpoint 1 must precede checkpoint 2 — 400 otherwise, "please verify your invite first"); phone E.164 if provided; `agreed_to_terms`/`agreed_to_guru_agreement` both truthy (400 otherwise, same rule as self-reg's `createApplication`); **same `rejected`/`blocked` guards `guruRegisterViaInvite` already has** — `guru_applications.account_status !== 'rejected'` (403 otherwise) and `users.account_status !== 'blocked'` (403 otherwise). Without these, a King-rejected or blocked invitee could still submit a profile after rejection/block.
- Effect: updates `users.name`/`phone`; updates the existing `guru_applications` row (already created at invite-send time) — sets `contract_name`, `phone`, `agreed_to_terms=TRUE`, `agreed_to_guru_agreement=TRUE`.
- Does **not** set a password, does **not** create a session — guru still can't log in after this step.

### 3. `POST /auth/guru/register` (existing, payload simplified)
- Body becomes: `{ invite_token, password }` — `name`/`contract_name`/`phone` are no longer accepted here (captured in step 2 now).
- New precondition: `guru_applications.agreed_to_terms` must be `TRUE` (checkpoint 2 done) — 400 "Please complete your application first" otherwise. This stops someone from skipping straight to password-setting with an empty profile.
- Everything else stays as today: sets `password_hash`, `role='guru'`, `account_status='active'`, `guru_active=TRUE`, auto-approves `guru_applications`, marks `guru_invites.used_at=NOW()`, creates `guru_profiles`/referral code, logs in via `createSession`.

### 4. `POST /auth/guru/invites/resend` (existing, unchanged)
- Still works regardless of which checkpoint the invitee is stuck at — reissues a fresh token + 15-min expiry. Resets progress back to checkpoint 1 only in the sense of token validity; `email_status`/`agreed_to_terms` already recorded on the `users`/`guru_applications` rows are **not** reset (no need to re-verify or re-submit profile after a resend, only to re-authenticate via the new token). Note: current implementation looks up the invite by email, not by user id, so this still works cleanly.

## `login()` decision tree (new) — CORRECTED ordering

**Critical fix from the first draft of this plan:** the new checkpoint branch must run *before* the existing `accountStatus !== 'active'` → "pending approval" gate, not after it. Under the original ordering, an invited Guru who hasn't been King-approved yet (the *default*, most common case — `users.account_status` stays `'pending'` until either the King explicitly approves or the Guru finishes all 3 checkpoints) would hit the generic "pending approval" message at step 4 and never reach the new logic at step 5. That would mean the new codes only ever fired in the one edge case that started this whole thread (King pre-approves) — not the everyday case of a Guru partway through their own invite.

Revised full order for `login()`:

```
1. status !== 'active'              → existing "inactive, contact support" (unchanged)
2. accountStatus === 'blocked'      → existing "blocked" (unchanged)
3. role === 'network_manager'       → existing (unchanged)

4. NEW — runs regardless of accountStatus, BEFORE the pending-approval gate:
   password_hash IS NULL AND an unused (used_at IS NULL) guru_invites row exists for this email?
        │
        ├─ NO  → fall through to steps 5/6 unchanged (covers self-registered applicants,
        │        who always have a password_hash set from their own /auth/register call,
        │        and any other password_hash-null edge case)
        │
        └─ YES → checkpoint decision tree:
              │
              ├─ invite expired (expires_at < now)
              │     → 403 { code: 'ACCOUNT_SETUP_REQUIRED' | 'PROFILE_SETUP_INCOMPLETE' | 'PASSWORD_NOT_SET'
              │             (whichever checkpoint applies, see below), message includes "your invite has
              │             expired, please resend it", data: { email } — no inviteToken, it's invalid }
              │
              ├─ email_status != 'verified'  [checkpoint 1 not done]
              │     → 403 { code: 'ACCOUNT_SETUP_REQUIRED',
              │             message: "Your account setup is remaining. Please check your email for the
              │             invite link, or resend it.", data: { email, inviteToken } }
              │
              ├─ email_status = 'verified' AND guru_applications.agreed_to_terms = FALSE  [checkpoint 2 not done]
              │     → 403 { code: 'PROFILE_SETUP_INCOMPLETE',
              │             message: "Please complete your application to continue.",
              │             data: { email, inviteToken } }
              │
              └─ agreed_to_terms = TRUE AND password_hash still NULL  [checkpoint 3 not done]
                    → 403 { code: 'PASSWORD_NOT_SET',
                            message: "Please set your password to activate your account.",
                            data: { email, inviteToken } }

5. accountStatus !== 'active'       → existing "pending approval" (unchanged — now only reached by
                                        self-registered applicants still awaiting King approval, since
                                        invited Gurus are fully handled by step 4 above)
6. !password_hash                   → existing generic 401 fallback (now effectively dead code for
                                        the guru-invite case, but kept as a safety net for any other
                                        role/flow that might reach here with no password set)
```

Notes:
- Step 4 also needs to handle `guru_invites` rows with `used_at` set but `password_hash` still null (data inconsistency — e.g. a crash mid-transaction) → generic 403 "Please contact support to complete your account setup."
- This is the **first place in `login()`'s response that adds a `code` field** — today `login()` only ever returns `{error, message, data}` with no machine-readable code (confirmed by reading the whole function and grepping the frontend `Login.jsx`, which just toasts `err.message`). Adding `code` here is a deliberate, scoped departure from that pattern so the frontend can branch to the right modal, per your requirement. Doesn't touch any other error branch in `login()`.
- Returning `inviteToken` directly in the login error response mirrors the existing pattern where `createGuruInvite`/`resendGuruInvite` already return the plaintext token in their response bodies (flagged as a known risk in `AUTH.md`) — consistent with current risk posture, not a new exposure introduced by this change. Flag if you'd rather the frontend call `resend` separately instead of getting the token inline here.
- Self-registered applicants are unaffected: they always have `password_hash` set immediately at `/auth/register` (bcrypt-hashed synchronously), so they never have an unused `guru_invites` row and always fall through step 4 to the unchanged step-5 "pending approval" message.

## Frontend implication (not building this — flagging for your awareness)

- `GuruInviteRegister.jsx` currently POSTs everything (`name, contract_name, password, phone`) in one call to `/auth/guru/register`. It needs to become a 2-step form: profile step (→ `POST /gurus/invites/:token/profile`) then password step (→ `POST /auth/guru/register` with just `password`).
- `Login.jsx` needs a new modal keyed off `err.code` (currently only toasts `err.message`) with per-code CTA: `ACCOUNT_SETUP_REQUIRED`/`PROFILE_SETUP_INCOMPLETE` → "Resend invite" button hitting `/auth/guru/invites/resend`; `PASSWORD_NOT_SET` → deep-link to the password step using the returned `inviteToken`.

## Open items for your review

1. Fold expired-invite into the same checkpoint code (as designed above), or add a distinct `INVITE_EXPIRED` code?
2. Confirm `PROFILE_SETUP_INCOMPLETE` payload is right — should it also return partially-known values (e.g. `name` if a King supplied one at invite time) so the frontend can pre-fill the profile form?
3. Should `POST /gurus/invites/:inviteToken/profile` be callable more than once (edit before setting password), or is it one-shot like the current accept call?

## Reference — full file map (Guru invite/register flow)

### Routes
- `src/routes/auth.routes.js` — `/gurus/invites` (create), `/guru/invites/resend`, `/guru/register` (accept — payload to be simplified), `/register`, `/otp/verify`, `/login`
- `src/routes/gurus.routes.js` — `/invites/validate/:inviteToken` (public — to gain a write side-effect), `/invites/:inviteToken/profile` (new), `/applications`, `/applications/me`, `/activation-fee/commit`
- `src/routes/admin.routes.js` — King-facing `/admin/gurus*` management routes

### Controllers
- `src/controllers/auth.controller.js` — `register` (:645), `login` (:1129, to gain the new branch), `verifyOtpEmail` (:75), `createGuruInvite` (:3102), `resendGuruInvite` (:3286), `guruRegisterViaInvite` (:3420, payload to simplify)
- `src/controllers/gurus.controller.js` — `createApplication` (:155), `updateMyApplication` (:283), `getMyApplication` (:414), `commitActivationFee` (:492) — new `submitInviteProfile`-style function to add here or in `inviteValidation.controller.js`
- `src/controllers/adminGuru.controller.js` — `listGurus`, `getGuruDetails`, `updateApplicationStatus` (:271), `updateGuru`, `blockGuru`, `unblockGuru`, `deleteGuru`
- `src/controllers/admin.controller.js` — `approveGuruApplication` (:26), `rejectGuruApplication` (:211), `activateGuru` (:569)
- `src/controllers/inviteValidation.controller.js` — `validateInvite` (:13, to gain the auto-verify side effect)

### Services
- `src/services/inviteEmailService.js` — `sendGuruInviteEmail`, `sendGuruInviteResendEmail`
- `src/services/session.service.js` — `createSession`, `validateAccessToken`, `revokeAllUserSessions`
- `src/services/otp.service.js` — `createOtp`, `verifyOtp`, `resendOtp`
- `src/services/referral.service.js` — `ReferralService`
- `src/services/guru.service.js` — `GuruService`

### DB schema (`src/db/init.sql`)
- `users` (:12), `guru_profiles` (:348), `guru_applications` (:612, `agreed_to_terms`/`agreed_to_guru_agreement` are `BOOLEAN NOT NULL DEFAULT FALSE` — confirmed, clean checkpoint markers), `guru_invites` (:1012), `guru_levels`/`guru_commission_rates` (:1054/:1069), `guru_referrals` (:1085), `admin_guru_actions` (:1222)

### Docs already in repo
- `BACKEND/EVENTOPIA-BACKEND-CODE/AUTH.md`
- `BACKEND/EVENTOPIA-BACKEND-CODE/AUTH_APIS.md`

### Frontend files that will need matching changes (not built yet)
- `WEB/EVENTOPIA-WEB/src/pages/Auth/Guru/GuruInviteRegister.jsx` — split into 2-step form
- `WEB/EVENTOPIA-WEB/src/pages/Auth/Login.jsx` — add code-keyed modal
- `WEB/EVENTOPIA-WEB/src/pages/KingAdmin/Gurus/InviteGuruModal.jsx` — unaffected (invite creation unchanged)
