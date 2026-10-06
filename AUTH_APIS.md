# Auth Module APIs — King, Promoter, Buyer

Base URL: `{{base_url}}` (e.g. `http://localhost:5000`). All bodies are JSON. Protected routes need `Authorization: Bearer {{access_token}}`.

---

## 👑 King's Account

No password — email + OTP login only.

| Method | Endpoint | Description | Body |
|---|---|---|---|
| POST | `/api/auth/king/register` | Create a King's Account. Blocked when `NODE_ENV=production`. | `{ "email": "king@x.com", "password": "StrongPass1!" }` |
| POST | `/api/auth/king/otp/send` | Email a 6-digit login code to a King's Account. | `{ "email": "king@x.com" }` |
| POST | `/api/auth/king/otp/verify` | Verify the code and log in as `kings_account`. | `{ "email": "king@x.com", "otp": "123456", "challengeId": "..." }` |

### King → manage Promoters

| Method | Endpoint | Description | Body |
|---|---|---|---|
| POST | `/api/auth/promoters/invites` | Invite a Promoter by email. Active immediately once they accept — **no approval needed**. | `{ "email": "promoter@x.com", "name": "...", "expires_in_minutes": 15 }` |
| GET | `/api/admin/promoters` | List Promoters (filters: `applicationStatus` = pending/approved/rejected, `status` = active/blocked/inactive, `search`, `page`, `limit`). Each row has `applicationStatus` (`incomplete` while a self-registered promoter has not submitted the application) and `invitePending`. | — |
| GET | `/api/admin/promoters/:promoterId` | Get one Promoter's full details + recent events. | — |
| PATCH | `/api/admin/promoters/:promoterId/application-status` | Approve/reject a **self-registered** Promoter's application. | `{ "status": "approved" }` or `{ "status": "rejected", "comment": "reason" }` |
| PATCH | `/api/admin/promoters/:promoterId` | Update a Promoter's profile fields. | `{ "full_name": "...", "phone": "...", "avatar_url": "...", "territory_name": "..." }` (any subset) |
| POST | `/api/admin/promoters/:promoterId/block` | Block a Promoter — ends login + all sessions. | `{ "reason": "..." }` (required) |
| POST | `/api/admin/promoters/:promoterId/unblock` | Unblock a Promoter. | `{ "reason": "..." }` (optional) |
| DELETE | `/api/admin/promoters/:promoterId` | Permanently delete a Promoter (fails if events or financial records exist — block instead). | `{ "reason": "..." }` (optional) |
| POST | `/api/admin/promoters/:applicationId/approve` | Approve by application id (same effect as `application-status` → approved). | — |

All `/api/admin/promoters` routes allow `kings_account`, `founder` and `admin`.

---

## 📣 Promoter

### Path A — Self-registration (needs the King's approval)

| Method | Endpoint | Description | Body |
|---|---|---|---|
| POST | `/api/auth/register` | Register with `role: "promoter"`. Starts `pending`. | `{ "email": "...", "password": "...", "role": "promoter" }` |
| POST | `/api/auth/otp/verify` | Verify email OTP. | `{ "email": "...", "otp": "1234", "challengeId": "..." }` |
| POST | `/api/promoters/applications` | Submit application. Account becomes `pending_approval`. | `{ "agreed_to_terms": true, "agreed_to_promoter_agreement": true, "agreed_to_activation_fee_terms": true, "full_name": "...", "avatar_url": "...", "territory_name": "..." (optional) }` |
| GET | `/api/promoters/applications/me` | Check my application status. | — |
| PATCH | `/api/promoters/applications/me` | Edit my pending application. | — |
| — | *King approves/rejects* | See `PATCH /api/admin/promoters/:promoterId/application-status` above. | — |
| POST | `/api/promoters/applications/:id/payments` | Pay the £85 activation fee — **after** approval (doesn't gate it). | `{ "paymentMethod": "card" }` |
| POST | `/api/auth/login` | Login once approved. | `{ "email": "...", "password": "..." }` |

### Path B — Invited by the King (active immediately, no approval)

| Method | Endpoint | Description | Body |
|---|---|---|---|
| — | *King sends invite* | See `POST /api/auth/promoters/invites` above. | — |
| GET | `/api/auth/referrals/validate/:token` | Public — check an invite token is still valid before showing the form. Returns `{ valid, email, name }`. | — |
| POST | `/api/auth/promoters/invites/resend` | Public — resend an expired invite. | `{ "email": "..." }` or `{ "referral_token": "..." }` |
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
- **The Guru role has been removed.** Roles are King, Promoter and Buyer. Registering with `role: "guru"` returns `400`, and any leftover Guru account is refused at login (`403`). Existing Guru rows are kept in the database.
- **Promoter approval:** a self-registered Promoter is gated by the King; a Promoter invited by the King is active as soon as they accept, with no approval step.
- **Promoter fee timing:** the £85 activation fee is paid *after* approval and doesn't gate it.
