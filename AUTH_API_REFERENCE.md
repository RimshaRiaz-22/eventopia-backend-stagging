# Auth API Reference

Base URL: `{{base_url}}` (example `http://localhost:4000`). Bodies are JSON. Protected routes need `Authorization: Bearer <token>`.
One 24h access token, no refresh token. Expired token returns 401 with `code: "SESSION_EXPIRED"`.
Errors look like `{ "error": true, "message": "...", "data": {} }`.

---

## 1. King

### POST /api/auth/king/register
Creates a King account. Blocked in production.
Body: `{ "email": "king@x.com", "password": "Str0ng!Pass1" }`
Response 201: `data { id, email, role }`

### POST /api/auth/king/otp/send
Emails a login code to the King.
Body: `{ "email": "king@x.com" }`
Response: `data { email, challengeId, expires-in, otp (development only) }`

### POST /api/auth/king/otp/verify
Verifies the code and logs the King in.
Body: `{ "email": "king@x.com", "otp": "123456", "challengeId": "..." }`
Response: `data { email, role: "kings_account", accessToken, expiresAt }`

---

## 2. Promoter

### GET /api/auth/referrals/validate/:token
Checks a King invite token before showing the invite form.
Body: none
Response: `data { valid, email, name, token_type }`. Errors: 401 invalid, 409 used, 410 expired.

### POST /api/auth/promoter/register
Accepts the King invite. Promoter is active immediately with no approval.
Body: `{ "referral_token": "...", "name": "John Doe", "password": "Str0ng!Pass1", "phone": "+447911123456" }`
Response 201: `data { access_token, expires_at, user { id, name, email, phone, role } }`

### POST /api/auth/promoters/invites/resend
Sends a new invite link when the old one expired. Public.
Body: `{ "email": "promoter@x.com" }` or `{ "referral_token": "..." }`
Response: `data { email, resent_at, expires_at, expires_in_minutes, referral_token, registration_url }`

### POST /api/auth/register
Self registration. Account starts pending and needs King approval.
Body: `{ "email": "promoter@x.com", "password": "Str0ng!Pass1", "role": "promoter", "role_requested": "promoter" }`
Optional: `"referral_token"` when coming from a promoter referral link.
Response 201: `data { email, userId, accountStatus, emailStatus, roleRequested, otp (development only), challengeId, expires-in }`

### POST /api/auth/otp/verify
Verifies the email code and logs the promoter in.
Body: `{ "email": "promoter@x.com", "otp": "1234", "challengeId": "...", "userId": 42 }`
Response: `data { userId, accessToken, expires-at, emailStatus, setupRequired, role, user }`

### POST /api/auth/otp/resend
Sends a new email code.
Body: `{ "email": "promoter@x.com" }`
Response: `data { email, userId, otp (development only), challengeId, expires-in }`

### POST /api/files/avatar
Uploads the optional profile photo. Needs promoter token.
Body: form-data with file field `avatar`
Response: `data { avatarUrl }`

### POST /api/promoters/applications
Submits the application. Account becomes pending approval.
Body: `{ "full_name": "John Doe", "phone": "+447911123456", "avatar_url": null, "agreed_to_terms": true, "agreed_to_promoter_agreement": true, "agreed_to_activation_fee_terms": true }`
Response 201: `data { application { id, accountStatus, territoryName, activationFee, invoiceId, currency } }`

### POST /api/auth/login
Logs in after approval, or for an invited promoter who finished setup.
Body: `{ "email": "promoter@x.com", "password": "Str0ng!Pass1" }`
Response: `data { email, userId, accessToken, expires-at, setupRequired, accountStatus, emailStatus, role, user }`
403 codes: `PROMOTER_INVITE_PENDING`, `EMAIL_NOT_VERIFIED`, `PROFILE_INCOMPLETE`. Plain 403 means pending approval or blocked.

---

## 3. Buyer

### POST /api/auth/register
Creates the buyer account. Active immediately, email code still required.
Body: `{ "email": "buyer@x.com", "password": "Str0ng!Pass1", "role": "buyer", "role_requested": "buyer", "name": "Test Buyer", "city": "London" }`
Response 201: `data { email, userId, otp (development only), challengeId, expires-in, user }`

### POST /api/auth/otp/verify
Verifies the email code and logs the buyer in.
Body: `{ "email": "buyer@x.com", "otp": "1234", "challengeId": "...", "userId": 42 }`
Response: `data { userId, accessToken, expires-at, emailStatus, setupRequired, role, user }`

### POST /api/auth/otp/resend
Sends a new email code.
Body: `{ "email": "buyer@x.com" }`
Response: `data { email, userId, otp (development only), challengeId, expires-in }`

### POST /api/auth/login
Logs the buyer in.
Body: `{ "email": "buyer@x.com", "password": "Str0ng!Pass1" }`
Response: `data { email, userId, accessToken, expires-at, setupRequired, accountStatus, emailStatus, role, user }`
403 code `EMAIL_NOT_VERIFIED` when the email is not verified yet.

### POST /api/auth/oauth/register
Signs up or logs in with Google or Facebook.
Body: `{ "email": "buyer@x.com", "name": "Test Buyer", "oauthProvider": "google", "oauthId": "google-123", "avatarUrl": "", "role": "buyer", "role_requested": "buyer", "applicationData": { "city": "London" } }`
Response: `data { email, userId, accessToken, expires-at, setupRequired, accountStatus, emailStatus, isNewUser, user }`
For a promoter send role `promoter` and `applicationData { phone, agreed_to_terms, agreed_to_promoter_agreement, agreed_to_activation_fee_terms }`.

### POST /api/auth/forgot-password
Creates a reset token valid for 1 hour and emails the link.
Body: `{ "email": "buyer@x.com" }`
Response: `data { email, resetToken }`

### POST /api/auth/reset-password
Sets a new password and ends all sessions.
Body: `{ "token": "...", "newPassword": "NewStr0ng!Pass1" }`
Response: `data { success: true }`

### POST /api/auth/logout
Ends the current session. Needs token.
Body: none
Response: `data { loggedOut: true, sessionId }`

Forgot password, reset password and logout work the same for promoters.

---

## 4. King: Promoters tab

All routes need the King token. Allowed roles are kings_account, founder and admin.

### POST /api/auth/promoters/invites
Invites a promoter by email. Link expires in 15 minutes by default.
Body: `{ "email": "promoter@x.com", "name": "John Doe", "expires_in_minutes": 15 }`
Response 201: `data { email, sent_at, expires_at, expires_in_minutes, referral_token, registration_url }`

### GET /api/admin/promoters
Lists promoters with filters and pages.
Query: `page`, `limit`, `search`, `applicationStatus` (pending, approved, rejected), `status` (active, blocked, inactive)
Response: `data { promoters [ { id, name, email, phone, applicationStatus, accountStatus, invitePending, createdAt } ], count, pagination }`

### GET /api/admin/promoters/:promoterId
Returns one promoter with the last 20 events.
Body: none
Response: `data { promoter { ...fields, application }, events [] }`

### PATCH /api/admin/promoters/:promoterId
Edits profile fields. Send any of them.
Body: `{ "full_name": "New Name", "phone": "+447911123456", "avatar_url": "", "territory_name": "London" }`
Response: `data { promoter { id, email, name, phone, avatar_url, territory_name } }`

### PATCH /api/admin/promoters/:promoterId/application-status
Approves or rejects a self registered promoter.
Body approve: `{ "status": "approved" }`
Body reject: `{ "status": "rejected", "comment": "reason is required" }`
Response: `data { application, user }` for approve, `data { promoterId, applicationId, applicationStatus, comment }` for reject.

### DELETE /api/admin/promoters/:promoterId
Deletes a promoter permanently. Fails with 409 if events or financial records exist.
Body: `{ "reason": "optional" }`
Response: `data { promoterId, deleted: true }`
