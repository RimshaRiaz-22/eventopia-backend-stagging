# Postman – Events API by Role

This folder contains a **Postman Collection** for the Eventopia **Events module**, with APIs grouped by role and example responses saved for reference.

## Import into Postman

1. Open **Postman**.
2. Click **Import** (or File → Import).
3. Drag and drop or choose one of:
   - **`Eventopia_Final_API.postman_collection.json`** (recommended final consolidated collection)
   - `Eventopia_API.postman_collection.json`
   - `Eventopia_API_Collection.postman_collection.json`
   - `Eventopia-Events-API.postman_collection.json`
4. The selected collection will appear in your Postman sidebar.

## Collection structure

| Folder | Role | Contents |
|--------|------|----------|
| **Buyer (Public + Orders)** | Buyer / anyone | Public event list, event detail, private share link; create order, checkout, my orders/tickets, order/ticket/QR, cancel order |
| **Promoter** | Promoter | Event CRUD, v1 create-with-tiers, list/export; images (cover/gallery); category & tags; publish/pause/cancel/republish/complete; ticket types; performance, attendees, validate/check-in, logs; access settings & rotate |
| **Admin** | Admin | List all events, event detail, complete event, cancel event, audit logs, metrics |

## Variables (set before calling APIs)

Edit the collection (or use an environment) and set:

| Variable | Example | Description |
|----------|---------|-------------|
| `baseUrl` | `http://localhost:3000` | API base URL |
| `token` | `eyJhbGc...` | Bearer token for auth-required endpoints |
| `eventId` | `1` | Event ID for path params |
| `orderId` | `1` | Order ID |
| `ticketId` | `1` | Ticket ID |
| `ticketTypeId` | `1` | Ticket type ID |
| `shareToken` | (from private link) | Share token for private-link event |
| `imageId` | (event_media id) | Gallery image ID for delete |

For `Eventopia_Final_API.postman_collection.json`, defaults are:
- `baseUrl = http://localhost:4000/api`
- `accessToken = ""` (auto-filled by Login test script)

**To set the token:** After logging in via `/api/auth/login`, copy the access token from the response into the `token` variable (collection or environment).

## Saved responses

Many requests include **saved example responses** (status 200 and sample JSON). In Postman:

- Send a request, then use **Save Response → Save as example** to add or replace examples.
- Use the **Examples** dropdown on a request to view or switch between saved responses.

These examples are for **reference** (expected shape and fields); actual responses may differ slightly by environment.

## Base path summary

- **Public events:** `GET /api/events`, `GET /api/events/:id`, `GET /api/events/share/:shareToken`
- **Orders (buyer):** `POST /api/orders/events/:eventId/orders`, `POST /api/orders/:orderId/checkout`, `GET /api/orders/me/orders`, `GET /api/orders/me/tickets`, etc.
- **Promoter:** ` /api/promoters/events` (CRUD, images, category, tags, publish, pause, cancel, republish, complete, ticket-types, performance, attendees, validate, checkin, logs, access-settings, rotate-access); **v1:** `POST /api/v1/events`, `GET /api/v1/events/my`, `GET /api/v1/events/my/export`, `GET /api/v1/events/:id`
- **Admin:** `GET /api/admin/events`, `GET /api/admin/events/:eventId`, `POST /api/admin/events/:eventId/complete`, `POST /api/admin/events/:eventId/cancel`, `GET /api/admin/events/audit-logs`, `GET /api/admin/events/metrics`

For full field-level docs and error codes, see:

- [EVENT_APIS_BY_ROLE.md](../EVENT_APIS_BY_ROLE.md)
- [PROMOTER_EVENT_APIS.md](../PROMOTER_EVENT_APIS.md)
