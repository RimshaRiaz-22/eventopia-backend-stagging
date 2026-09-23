# Auth Module APIs — King, Guru, Promoter, Buyer

Base URL: `{{base_url}}` (e.g. `http://localhost:5000`). All bodies are JSON. Protected routes need `Authorization: Bearer {{access_token}}`.

---

## 👑 King's Account

No password — email + OTP login only.

| Method | Endpoint | Description | Body |
|---|---|---|---|
| POST | `/api/auth/king/register` | Create a King's Account. Blocked when `NODE_ENV=production`. | `{ "email": "king@x.com", "password": "StrongPass1!" }` |
| POST | `/api/auth/king/otp/send` | Email a 6-digit login code to a King's Account. | `{ "email": "king@x.com" }` |
| POST | `/api/auth/king/otp/verify` | Verify the code and log in as `kings_account`. | `{ "email": "king@x.com", "otp": "123456", "challengeId": "..." }` |

### King → manage Gurus

| Method | Endpoint | Description | Body |
|---|---|---|---|
| POST | `/api/auth/gurus/invites` | Invite a Guru by email (active immediately once accepted). | `{ "email": "guru@x.com", "expires_in_minutes": 15 }` |
| GET | `/api/admin/gurus` | List Gurus (filters: `applicationStatus`, `status`, `search`, `page`, `limit`). | — |
| GET | `/api/admin/gurus/:guruId` | Get one Guru's full details + promoters + commissions. | — |
| PATCH | `/api/admin/gurus/:guruId/application-status` | Approve/reject a self-registered Guru's application. | `{ "status": "approved" }` or `{ "status": "rejected", "comment": "reason" }` |
| PATCH | `/api/admin/gurus/:guruId` | Update a Guru's profile fields. | `{ "full_name": "...", "phone": "...", "avatar_url": "...", "contract_name": "...", "territory_name": "..." }` (any subset) |
| POST | `/api/admin/gurus/:guruId/block` | Block a Guru — ends login + all sessions. | `{ "reason": "..." }` (required) |
| POST | `/api/admin/gurus/:guruId/unblock` | Unblock a Guru. | `{ "reason": "..." }` (optional) |
| DELETE | `/api/admin/gurus/:guruId` | Permanently delete a Guru (fails if promoters attached or financial records exist). | `{ "reason": "..." }` (optional) |
| POST | `/api/admin/gurus/:guruId/level` | Set a Guru's commission level (1-3). | `{ "level": 2, "reason": "..." }` |
| POST | `/api/admin/gurus/:guruId/promoters/:promoterId/attach` | Manually attach a promoter to a Guru. | — |
| POST | `/api/admin/gurus/:guruId/promoters/:promoterId/detach` | Manually detach a promoter from a Guru. | — |
| POST | `/api/admin/gurus/:guruId/activate` | Force-activate a Guru, bypassing the application/fee gate. | — |

---

## 🧙 Guru

### Path A — Self-registration (needs King's approval)

| Method | Endpoint | Description | Body |
|---|---|---|---|
| POST | `/api/auth/register` | Register with `role: "guru"`. Starts as `requested`. | `{ "email": "...", "password": "...", "role": "guru" }` |
| POST | `/api/auth/otp/verify` | Verify email OTP, get a temp token to finish the profile. | `{ "email": "...", "otp": "1234", "challengeId": "..." }` |
| POST | `/api/gurus/applications` | Complete Guru profile. Account becomes `pending`. | `{ "contract_name": "...", "territory_name": "...", "agreed_to_terms": true, "agreed_to_guru_agreement": true }` |
| POST | `/api/gurus/activation-fee/commit` | Choose how to pay the £250 activation fee — **required before King can approve**. | `{ "choice": "upfront" }` or `{ "choice": "negative_balance" }` |
| GET | `/api/gurus/applications/me` | Check my own application status. | — |
| — | *King approves* | See `PATCH /api/admin/gurus/:guruId/application-status` above. | — |
| POST | `/api/auth/login` | Login once approved (`account_status = active`). | `{ "email": "...", "password": "..." }` |

### Path B — Invited by King (active immediately, no approval)

| Method | Endpoint | Description | Body |
|---|---|---|---|
| — | *King sends invite* | See `POST /api/auth/gurus/invites` above. | — |
| POST | `/api/auth/guru/invites/resend` | Public — resend an expired Guru invite. | `{ "email": "..." }` or `{ "invite_token": "..." }` |
| POST | `/api/auth/guru/register` | Accept the invite — creates an **active** Guru, logs in immediately. | `{ "invite_token": "...", "name": "...", "contract_name": "...", "password": "...", "phone": "+44...", "avatar_url": "..." (optional) }` |

### Common Guru endpoints

| Method | Endpoint | Description | Body |
|---|---|---|---|
| GET | `/api/gurus/available` | Public — list active Gurus (for promoter Guru-selection). | — |
| GET | `/api/gurus/me` | Get my Guru profile. | — |
| GET | `/api/gurus/dashboard/summary` | Dashboard overview. | — |
| GET | `/api/gurus/promoters/applications` | List promoters who applied under me, pending review. | — |
| POST | `/api/gurus/promoters/:applicationId/approve` | Approve a promoter's application. | — |
| POST | `/api/gurus/promoters/:applicationId/reject` | Reject a promoter's application. | `{ "rejection_reason": "..." }` |
| POST | `/api/gurus/dashboard/promoters/:promoterId/activate` | Activate a pending/invited promoter directly. | — |
| POST | `/api/auth/gurus/promoter/referral-invites` | Guru invites a Promoter by email. | `{ "email": "...", "name": "...", "expires_in_minutes": 15 }` |

---

## 📣 Promoter

### Path A — Self-registration (picks a Guru, needs Guru's approval)

| Method | Endpoint | Description | Body |
|---|---|---|---|
| POST | `/api/auth/register` | Register with `role: "promoter"`. Starts `pending`. | `{ "email": "...", "password": "...", "role": "promoter" }` |
| POST | `/api/auth/otp/verify` | Verify email OTP. | `{ "email": "...", "otp": "1234", "challengeId": "..." }` |
| POST | `/api/promoters/applications` | Submit application, choosing a Guru. | `{ "agreed_to_terms": true, "agreed_to_promoter_agreement": true, "agreed_to_activation_fee_terms": true, "guru_user_id": 12, "full_name": "...", "avatar_url": "..." }` |
| GET | `/api/promoters/applications/me` | Check my application status. | — |
| PATCH | `/api/promoters/applications/me` | Edit my pending application. | — |
| — | *Guru approves/rejects* | See Guru's `POST /api/gurus/promoters/:applicationId/approve` \| `/reject` above. | — |
| POST | `/api/promoters/applications/:id/payments` | Pay the £85 activation fee — **after** approval (doesn't gate it). | `{ "paymentMethod": "card" }` |
| POST | `/api/auth/login` | Login once approved. | `{ "email": "...", "password": "..." }` |

### Path B — Invited by a Guru/King (active immediately, no approval)

| Method | Endpoint | Description | Body |
|---|---|---|---|
| — | *Guru/King sends invite* | See `POST /api/auth/gurus/promoter/referral-invites` above. | — |
| GET | `/api/auth/referrals/validate/:token` | Public — check a referral token is still valid before showing the form. | — |
| POST | `/api/auth/promoter/referral-invites/resend` | Public — resend an expired referral invite. | `{ "email": "..." }` or `{ "referral_token": "..." }` |
| POST | `/api/auth/promoter/register` | Accept the invite — creates an **active** Promoter, logs in immediately. | `{ "name": "...", "password": "...", "phone": "+44...", "referral_token": "..." }` |

### Common Promoter endpoints

| Method | Endpoint | Description | Body |
|---|---|---|---|
| GET | `/api/promoters/me` | Get my promoter profile. | — |
| PUT | `/api/promoters/setup-account` | Complete/update name, password, avatar. | `{ "name": "...", "password": "...", "avatar_url": "..." }` |
| GET | `/api/promoters/dashboard/overview` | Dashboard overview (active promoters only). | — |

---

## 🧑‍💻 Buyer

Simplest role — no invite, no approval, active immediately.

| Method | Endpoint | Description | Body |
|---|---|---|---|
| POST | `/api/auth/register` | Register (role defaults to `buyer`). | `{ "email": "...", "password": "...", "name": "...", "city": "...", "role": "buyer" }` |
| POST | `/api/auth/otp/verify` | Verify email OTP — also logs in. | `{ "email": "...", "otp": "1234", "challengeId": "..." }` |
| POST | `/api/auth/otp/resend` | Resend the signup OTP. | `{ "email": "..." }` |
| POST | `/api/auth/login` | Login with email + password. | `{ "email": "...", "password": "..." }` |
| POST | `/api/auth/oauth/register` | Sign up / log in via Google, Facebook, etc. | `{ "email": "...", "name": "...", "oauthProvider": "google", "oauthId": "...", "role": "buyer" }` |
| POST | `/api/auth/forgot-password` | Request a password reset link (1h expiry). | `{ "email": "..." }` |
| POST | `/api/auth/reset-password` | Reset password with the emailed token. Kills all sessions. | `{ "token": "...", "newPassword": "..." }` |
| POST | `/api/v1/auth/change-password` | Change password while logged in. Keeps current session, kills others. | `{ "current_password": "...", "new_password": "...", "confirm_new_password": "..." }` |
| GET | `/api/auth/me` | Get my profile. | — |
| PATCH | `/api/auth/me` | Update name/avatar. | `{ "name": "...", "avatarUrl": "..." }` |
| POST | `/api/auth/setup` | Set full name for the first time. | `{ "fullName": "..." }` |
| GET | `/api/users/me/preferences` | Get city + interest tags. | — |
| PUT | `/api/users/me/preferences` | Update city + interest tags. | `{ "city": "...", "interestsTagIds": [1, 4, 7] }` |
| POST | `/api/auth/logout` | Log out current session. | — |
| POST | `/api/auth/logout-all` | Log out of all devices. | — |

---

## Notes

- **One token, 24h.** Every login/OTP-verify/invite-accept returns a single `accessToken` valid for 24h — no refresh tokens. On expiry the API returns `401` with `code: "SESSION_EXPIRED"`.
- **Roles that need approval:** Guru and Promoter both have a self-registration path gated by an approver (King for Guru, Guru for Promoter) and a separate invite path that skips approval entirely.
- **Fee timing differs:** Guru's activation fee must be committed *before* the King can approve. Promoter's activation fee is paid *after* the Guru approves.
