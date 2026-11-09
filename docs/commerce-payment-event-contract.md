# Commerce `order.paid` Event Contract

The commerce endpoint provides a durable, idempotent intake boundary for authoritative paid-order events. Intake stores and acknowledges the event before any notification work. It does not generate receipts, invoke AI, verify payment itself, or arrange delivery. Kawama remains authoritative for payment verification.

## Endpoint and authentication

```http
POST /api/integrations/commerce/<businessId>/events
Authorization: Bearer <server-side-website-integration-key>
Content-Type: application/json
```

The credential is the business's existing website integration key and must be kept in Kawama's backend. It must never be exposed in browser JavaScript. OrderBridge resolves the path business to an `active` or `trial` e-commerce business and verifies the stored key hash using a constant-time comparison. Chat enablement, website capabilities, browser origins, and conversation tokens do not apply to this endpoint. A body-supplied business ID is rejected by the strict request schema and is never used for tenant scope.

## Request

All money values are integer pesewas. The currency is `GHS`. Each line total must equal `quantity * unitPricePesewas`, and `productPaymentTotalPesewas` must equal the sum of all item line totals.

```json
{
  "type": "order.paid",
  "eventId": "evt_opaque_unique_value",
  "occurredAt": "2026-11-02T10:30:00Z",
  "order": {
    "externalOrderId": "order_123",
    "orderNumber": "KW-123",
    "paymentReference": "pay_123",
    "paidAt": "2026-11-02T10:29:30Z",
    "currency": "GHS",
    "productPaymentTotalPesewas": 125000,
    "items": [
      {
        "externalProductId": "product-123",
        "name": "Example product",
        "quantity": 1,
        "unitPricePesewas": 125000,
        "lineTotalPesewas": 125000
      }
    ],
    "customer": {
      "name": "Example Customer",
      "phone": "+233000000000",
      "email": "customer@example.com",
      "whatsappConsent": true
    },
    "delivery": {
      "recipientName": "Example Customer",
      "recipientPhone": "+233000000000",
      "addressLine1": "Known address or area",
      "city": "Accra",
      "region": "Greater Accra",
      "countryCode": "GH",
      "instructions": "Optional bounded delivery note",
      "chargeStatus": "to_be_arranged"
    }
  }
}
```

Optional delivery fields are `recipientName`, `recipientPhone`, `addressLine1`, `addressLine2`, `city`, `region`, `postalCode`, `countryCode`, and `instructions`. `chargeStatus` is required and can only be `to_be_arranged`. Delivery charges are therefore not part of `productPaymentTotalPesewas`; they must be agreed separately in a later workflow.

The JSON object is strict and bounded: unknown fields are rejected, strings and arrays have maximum sizes, at least one and at most 100 items are accepted, and only `order.paid` is supported.

## Responses and idempotency

A new event is stored with `receivedAt` and `status: "received"` and returns `201`:

```json
{
  "success": true,
  "message": "Commerce event received",
  "data": { "eventId": "evt_opaque_unique_value", "status": "received" }
}
```

An equivalent retry returns `200` with `message: "Commerce event already received"`. Reusing an event ID, external order ID, or payment reference with different validated content returns `409`. The original event is never overwritten. Uniqueness is enforced per business by MongoDB indexes for the event ID, external order ID, and payment reference, so concurrent retries have the same outcome.

Invalid credentials return `401`, and invalid or unsupported payloads return `400` using the standard validation response.

## WhatsApp notification processing

Commerce paid-order notifications are opt-in. Set `whatsappIntegration.commerceNotificationsEnabled` to `true` on the Business only after its WhatsApp integration is enabled and has a valid Wasender session, token, sending number, WhatsApp channel, and owner/manager notification recipient. The flag defaults to `false`. Turning it off pauses both event enqueueing and pending commerce queue deliveries. Queue selection uses bounded weighted fairness so restaurant messaging remains operational while due commerce work also continues to make progress.

A background consumer atomically claims stored events with an expiring lease. Missing or paused configuration is recorded and retried with bounded backoff; an expired claim can be recovered after a worker crash. Deterministic queue keys cover the business, event, notification kind, and normalized recipient, so partial enqueueing can resume without recreating jobs that already exist. The event advances to `enqueued` only after every required customer and deduplicated staff job is durable.

Before every send, the queue reloads the matching Business and event, rechecks business status, opt-in, WhatsApp configuration and channel, resolves that Business's current session and token, and verifies customer consent or current staff membership. Customer and individual staff outcomes remain independent queue records. Temporary provider failures retry the same record under the existing queue spacing and retry rules; stale recipients are cancelled. Commerce notifications never use restaurant records, restaurant identity resolution, global credentials, AI, or model-authored text.

The stored payment snapshot remains immutable. Customer confirmations identify `Business.name`, the order number, product amount paid and currency, and state that delivery fees will be arranged separately. Staff notifications use the saved items, totals, customer contact, and delivery details.

## PDF receipt generation and delivery

A separate background worker generates and delivers PDF receipts independently of text notification outcomes. Receipts use `Business.name` as the merchant, never restaurant records.

### Receipt record lifecycle

When the text-notification consumer marks an event `enqueued`, it also creates a `CommerceReceipt` record keyed by `(businessId, commerceEventId)`. A duplicate-key race returns the existing record. If the initial receipt-record creation fails, a periodic reconciliation sweep in the receipt worker detects enqueued events lacking a receipt and creates one idempotently, without resetting event processing or replaying text notifications. The receipt record stores a random, per-business-unique `receiptNumber`, the snapshotted `merchantName`, and progresses through `pending → generating → generated → enqueued` (or `failed`). Receipts whose PDF is already stored (`generated`) but whose enqueue crashed are reclaimed with the existing PDF, skipping regeneration.

### Generation and storage

The receipt worker atomically claims a pending or generated receipt with an expiring lease (5 minutes). Crashed worker leases expire and are reclaimed. Missing Cloudinary configuration, incomplete event readiness, and paused business settings cause deferrals that do not consume the generation attempt budget; only actual PDF generation and upload attempts are counted. The worker generates a PDF in memory using PDFKit containing:

- **Merchant name** (`Business.name` snapshot), receipt number, order number
- **Payment date**, customer name, phone, optional email
- **Itemized line items** with quantities, unit prices (integer pesewas converted correctly), line totals, and currency
- **Product total paid** — no taxes, fees, or discounts are invented
- **Delivery fee note**: "Delivery fees are arranged separately."

The PDF buffer is uploaded to Cloudinary as a `raw` resource using a stable, opaque, tenant-scoped public ID (`commerce-receipts/{receiptObjectId}.pdf`). Cloudinary's `overwrite: false` prevents duplicate uploads on retry. The asset URL and public ID are persisted on the receipt record so retries reuse the same PDF.

Generation failures are deferred with exponential backoff (30 seconds to 15 minutes) up to 8 actual generation attempts before the receipt is marked `failed`. Missing Cloudinary configuration causes a deferral without counting against the budget.

### Document delivery

Once the PDF is durably stored, the worker enqueues a `document` message for the event's `customer.phone` using a deterministic idempotency key: `commerce:{businessId}:{eventId}:receipt:{normalizedRecipient}`. The queue kind is `commerce_paid_order_receipt`.

Before sending, the queue refreshes the matching receipt (validated by receipt ID, business ID, and event ID), rechecks:
- Business eligibility, status, and `commerceNotificationsEnabled`
- WhatsApp integration (enabled, channel, session, token)
- Customer `whatsappConsent` from the event (uses the **customer** consent branch, not the staff-recipient branch)
- Receipt PDF URL availability

The Business's current session and token are resolved at send time. Global or cross-tenant credentials are never used. Queue spacing, fairness, pause handling, and retry rules are reused from the existing commerce notification infrastructure.

### Independence from text notifications

Receipt processing is fully independent of customer and staff text notification delivery outcomes. The receipt worker does not reset event processing status, recreate text notification queue jobs, or depend on their send results. Generation failures and document-delivery failures are separately recoverable through their own retry chains.

## Purchase review invitations

Newly enqueued commerce receipt messages are marked as eligible for a purchase review invitation. An invitation job is created only after that receipt's `OutboundMessage` is durably marked `sent`; `CommerceReceipt.status = enqueued` alone is not sufficient. The job is not tied to physical delivery, and receipts created before this feature are not automatically backfilled.

The durable job is unique per business, external order ID, and customer recipient. Workers use atomic expiring claims and bounded retries with exponential backoff for commerce API and processing failures. Intentional notification/configuration pauses return the job to `pending` without consuming an attempt, so it resumes when the business is re-enabled. Before fetching links, the worker uses the same deterministic queue idempotency key and tenant/order/customer scope to reconnect any invitation message created before job finalization was interrupted. A reconciliation pass remains limited to sent receipt messages carrying the new eligibility marker. After a claim, OrderBridge calls:

`POST /api/integrations/orderbridge/orders/{externalOrderId}/review-links`

The request uses `Business.commerceIntegration.apiKey` as a Bearer token. It never uses the website integration key. The commerce HTTP client preserves its HTTPS/same-origin URL restriction, redirect rejection, configured timeout, and response-size limit. The response is a top-level object (there is no `data` wrapper):

```json
{
  "orderNumber": "ORD-123",
  "products": [
    {
      "productId": "product-1",
      "name": "Product name",
      "reviewState": "available",
      "reviewUrl": "https://shop.example.com/reviews/product-1"
    }
  ]
}
```

The returned order number and product names must match the paid-order snapshot. `reviewState` is either `available` or `submitted`, and the response must cover every distinct purchased product ID exactly once: missing, duplicate, unexpected, and empty-for-nonempty-order product sets are rejected. Each non-null review URL must be HTTPS on a host listed in `commerceIntegration.canonicalProductHosts`. Submitted products and null URLs are omitted from the invitation; a valid all-submitted response therefore queues no WhatsApp message.

All remaining products are grouped into one customer message using the dedicated `commerce_purchase_review_invitation` queue kind. Its deterministic queue idempotency key is scoped by business, external order, and customer recipient. At send time the queue revalidates the paid event, customer consent and recipient, business eligibility, current WhatsApp credentials, the durable invitation job, and the successfully sent source receipt. Invitation failure changes neither payment/event state nor receipt or manager-notification delivery, and does not resend the PDF.
