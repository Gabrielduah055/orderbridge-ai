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

The stored payment snapshot remains immutable. Customer confirmations identify `Business.name`, the order number, product amount paid and currency, and state that delivery fees will be arranged separately. Staff notifications use the saved items, totals, customer contact, and delivery details. PDF receipts are outside this chunk; when added, they must use `Business.name` as the merchant.
