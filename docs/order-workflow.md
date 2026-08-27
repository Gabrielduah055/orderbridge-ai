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

While the submitted order is still `awaiting_restaurant_confirmation` (or legacy `pending`), the same customer can use `amend_submitted_order` to change one item quantity, add or remove an item, switch pickup/delivery, or change the delivery address. Positive quantities and item removals must be explicitly supported by the customer's current message. The backend recalculates trusted menu prices and delivery fees, increments `customerAmendmentVersion`, returns `orderEvent: "amended"` with `notifyOwner: true`, and queues one idempotent owner notification per amendment version. Once the restaurant accepts, rejects, or begins preparing the order, customer amendments are blocked.

Before restaurant acceptance, the customer can cancel immediately with `cancel_order`. The backend records `customerCancelledAt`, returns `orderEvent: "cancelled"` with `notifyOwner: true`, and queues an idempotent owner cancellation notification. After acceptance, `cancel_order` persists a pending cancellation request without changing the order status. An owner or manager must use `resolve_customer_cancellation_request` to approve or decline it, and the customer is notified of that decision.

Repeated confirmation of the same converted draft returns the existing order.

If the customer names an item without quantity, the draft stores that item as pending and asks for quantity. The item is not added as `1x` unless the customer explicitly supplied a singular quantity such as `one`, `a plate`, or `a pack`.

Delivery fees are resolved from `deliveryPricing` on the restaurant. Flat and zone-based fees can be resolved automatically. Manual or missing configuration blocks final submission until the fee is supplied by a trusted backend path.

## Owner Notification

The owner notification is generated from the saved order, not AI prose. It includes order number, customer details, order type, address when relevant, item quantities, totals, payment state, and reply examples for confirmation or rejection.

`ownerNotifiedAt` prevents duplicate new-order notifications. Before sending, the queue reloads the order and cancels an original or amended notification if its status or `customerAmendmentVersion` is stale. The provider message ID and queued amendment version bind quoted owner replies to the exact version staff actually saw.

## Restaurant Decision

Owners and managers can use `confirm_order` or `reject_order`. Customers cannot use these tools. The `reject_order.reason` model argument is optional: the backend accepts only an explicit inline staff reason or the real current staff message from one trusted pending rejection selection. Quoting an older owner notification after a customer amendment blocks Accept or Reject until staff reviews the latest version.

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
