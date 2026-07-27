# Order Workflow

Phase 6 separates customer submission from restaurant acceptance.

## Status Flow

`awaiting_restaurant_confirmation` is the normal awaiting restaurant confirmation state. Legacy `pending` orders are treated as the same state for backward compatibility.

Customer path:

`draft -> awaiting_restaurant_confirmation`

Accepted path:

`awaiting_restaurant_confirmation -> accepted -> preparing -> ready -> completed`

Rejected path:

`awaiting_restaurant_confirmation -> rejected`

## Submission

Customers work in a MongoDB-backed draft. When `confirm_order_draft` succeeds, the backend validates the draft, checks that every item has an explicit quantity, resolves delivery fees from restaurant configuration, recalculates prices from current menu items, creates one real order, stores `sourceDraftId`, sets `customerConfirmedAt`, marks the draft with `convertedOrderId`, and returns structured data:

```json
{
  "orderEvent": "submitted",
  "notifyOwner": true,
  "receiptRequired": false
}
```

Repeated confirmation of the same converted draft returns the existing order.

If the customer names an item without quantity, the draft stores that item as pending and asks for quantity. The item is not added as `1x` unless the customer explicitly supplied a singular quantity such as `one`, `a plate`, or `a pack`.

Delivery fees are resolved from `deliveryPricing` on the restaurant. Flat and zone-based fees can be resolved automatically. Manual or missing configuration blocks final submission until the fee is supplied by a trusted backend path.

## Owner Notification

The owner notification is generated from the saved order, not AI prose. It includes order number, customer details, order type, address when relevant, item quantities, totals, payment state, and reply examples for confirmation or rejection.

`ownerNotifiedAt` prevents duplicate new-order notifications.

## Restaurant Decision

Owners and managers can use `confirm_order` or `reject_order`. Customers cannot use these tools.

Confirmation sets `restaurantConfirmedAt`, changes status to `accepted`, and returns `orderEvent: "confirmed"`.

Rejection sets status to `rejected`, stores `restaurantRejectedAt` and optional `restaurantRejectionReason`, and returns `orderEvent: "rejected"`.

## Receipt Timing

Receipts are generated only after restaurant confirmation. Receipt generation uses the saved order and restaurant records. `receiptGeneratedAt` and `receiptSentAt` prevent duplicate generation and document delivery. Receipt failure does not revert the confirmed order.

## Webhook Side Effects

The Wasender webhook sends the normal agent reply first, then consumes structured backend flags:

- `submitted` triggers owner notification.
- `confirmed` triggers customer confirmation and receipt delivery.
- `rejected` triggers customer rejection notification.

The webhook does not parse AI text to decide whether an order exists or was accepted.
