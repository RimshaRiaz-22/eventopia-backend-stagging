# How the Event Module Works (Simple Guide)

This explains, in plain language, how events are created, published, and sold in the backend.

> **Updated:** King approval is no longer required for an event to go live. Publishing is what makes an event visible to buyers — see below.

## Who does what

- **Promoter** — creates and manages their own events.
- **King's Account (King)** — can view any event and has the same create/publish/pause/cancel powers as a promoter (acts like a super-promoter), and approves cancellation requests for already-live events.
- **Buyer** — browses published events and buys tickets.

## The event lifecycle, step by step

```
draft → published (visible to buyers) → completed
  ↓          ↓
cancel   pause → unpublished → republish
(instant)      ↓
             cancellation_requested → cancelled  (King approves)
```

### 1. Draft
Promoter (or King) creates an event (`POST /api/promoters/events`). It starts as `draft` — a work in progress, not visible to buyers. Almost anything can be edited at this stage.

### 2. Cancel a draft (instant, no approval needed)
While an event is still `draft` (or `pending_approval` — see below), it has never been shown to buyers, so cancelling it is instant: `POST /events/:id/cancel` sets status straight to `cancelled`. No King review needed.

A promoter can also just delete a draft outright (`DELETE /events/:id`) as long as no tickets have been sold.

### 3. Publish → instantly visible to buyers
When the event is ready, the promoter (or King) publishes it directly: `POST /events/:id/publish`. This checks that required fields are filled in (title, description, dates, city, format, and at least one active ticket type if tickets are needed), then sets status to `published`.

**`published` is the only status buyers can see.** There is no separate King approval step blocking this — as soon as it's published, it's live on the public event list and detail pages.

*(There's still an optional `submit`/`pending_approval` step (`POST /events/:id/submit`) a promoter can use if they just want to mark an event "ready for review," but it does nothing to visibility — only `publish` does. King approving a `pending_approval` event no longer changes whether buyers can see it.)*

### 4. Pause / republish
Once live, a promoter or King can pause an event (`published` → `unpublished`, hides it from buyers) and bring it back later (`unpublished` → `published`).

### 5. Cancel a live event (two-step, needs King approval)
Once an event has been published (and may have ticket sales), cancelling still goes through King review, to protect buyers who may have already bought tickets:
1. Promoter requests cancellation (`POST /events/:id/cancel`) → status becomes `cancellation_requested`.
2. King approves the cancellation (`POST /admin/kings-account/events/:id/cancel/approve`) → status becomes `cancelled`.

A King can also force-cancel a live event directly, skipping the request step.

You can't edit an event once it's `cancelled` or `cancellation_requested`.

### 6. Complete
After the event happens, it's marked `completed` (`POST /events/:id/complete`). This is tracked separately from the status above — it's what unlocks the promoter getting paid out from escrow (the ticket money held until the event is confirmed to have happened).

### 7. Delete
A promoter can only delete an event if it has **no tickets sold** and is **not currently published**. Otherwise they must cancel it instead.

## Tickets

Each event can have multiple **ticket types** (e.g. "Early Bird", "VIP"), each with its own price, quantity available, and sale window. Rules:
- Once a ticket type has sales, its price can no longer be changed.
- Capacity can't be reduced below what's already sold.

## How buyers actually get tickets

1. Buyer picks ticket types and creates an order (`POST /api/orders`).
2. The system checks real-time availability (accounting for other people mid-checkout, not just tickets already sold), so two people can't buy the last seat at the same time.
3. Buyer pays, order is confirmed, and tickets are issued with a QR code.
4. At the door, the promoter scans the QR code to check the buyer in (`POST /events/:id/scan`).

## Who's allowed to do what (access control)

- Only the promoter who owns an event can edit/manage it — a King can act on any event, same as its own promoter.
- A promoter must be **approved and active** (King-approved as a promoter account) before they can manage any events at all. This is about the promoter's account, not about approving individual events.
- Public browsing endpoints need no login, and show any `published` event.
- Buyers can only see/manage their own orders and tickets.

## What changed

Previously, publishing an event alone wasn't enough — a King also had to separately "approve" it (moving it into a different `active` status) before it showed up for buyers. That extra gate has been removed:

- **Before:** `draft → pending_approval → (King approves) → active (buyer-visible)`
- **Now:** `draft → published (buyer-visible immediately)`

King's role on events is now the same as a promoter's (create/publish/pause) plus approving cancellations on events that are already live.
