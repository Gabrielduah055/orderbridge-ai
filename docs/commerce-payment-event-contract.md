# Commerce `order.paid` Event Contract

Chunk 3A provides a durable, idempotent intake boundary for authoritative paid-order events. It stores the event only. It does not send WhatsApp messages, generate receipts, invoke AI, verify payment itself, or arrange delivery. Kawama remains authoritative for payment verification.

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

## Boundary for Chunk 3B

Chunk 3B may read records from this collection to implement downstream processing, but must treat the stored event as an immutable Kawama-issued payment snapshot. It must revalidate current tenant, customer destination/consent, and delivery state before any send; persist receipt and notification outcomes independently; and remain retry-safe. Chunk 3B must not reinterpret product payment as including delivery charges or place these commerce events into restaurant order state transitions.
