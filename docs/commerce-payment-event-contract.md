# Future Commerce `order.paid` Event Contract

This document defines the boundary for a later pull request. The current multi-business change does not receive payment events, generate commerce receipts, or send payment notifications.

## Intended flow

1. The commerce backend verifies payment using its payment provider.
2. The commerce backend sends an authenticated, idempotent `order.paid` event to OrderBridge.
3. OrderBridge revalidates the business, event signature, event ID, and authoritative order snapshot.
4. OrderBridge creates or retrieves the saved receipt-delivery record.
5. OrderBridge sends the customer receipt and sends the business owner the trusted order details.
6. The owner contacts the customer personally to agree on destination and delivery fee.

OrderBridge must not calculate, quote, or negotiate the delivery fee for this commerce workflow.

## Proposed HTTP contract

```http
POST /api/integrations/commerce-events/<businessId>
X-OrderBridge-Event-Id: evt_opaque_unique_value
X-OrderBridge-Timestamp: 2026-10-27T12:00:00Z
X-OrderBridge-Signature: sha256=<hmac-of-raw-body-and-timestamp>
Content-Type: application/json
```

```json
{
  "version": "2026-10-01",
  "type": "order.paid",
  "occurredAt": "2026-10-27T12:00:00Z",
  "order": {
    "externalOrderId": "order_123",
    "orderNumber": "KW-123",
    "currency": "GHS",
    "subtotal": 1250,
    "discount": 0,
    "tax": 0,
    "totalPaid": 1250,
    "paymentReference": "provider_reference_redacted_for_customer",
    "items": [
      {
        "externalProductId": "product-123",
        "name": "Example product",
        "quantity": 1,
        "unitPrice": 1250,
        "lineTotal": 1250
      }
    ],
    "customer": {
      "name": "Example Customer",
      "receiptDestination": "+233000000000"
    }
  }
}
```

The exact payload will be finalized against Kawama's authoritative paid-order representation. OrderBridge must not accept client-authored totals or a browser-generated payment success event.

## Required safeguards

- Resolve the signing secret from the trusted business record; never from the body.
- Verify the signature against the raw request bytes and a bounded timestamp window.
- Require a unique `(businessId, eventId)` record before side effects.
- Re-fetch or cryptographically trust a bounded authoritative order snapshot from the configured commerce backend before generating messages.
- Persist receipt and owner-notification states separately so partial failure is retryable.
- Revalidate the customer's current permitted delivery destination at send time.
- Never put commerce events into restaurant order state transitions or calculate a restaurant delivery fee.
- Store bounded metadata and redact credentials, full provider payloads, and sensitive payment data from logs.

## Reusable integration points

The follow-up implementation should add a channel-neutral inbound integration-event record, a commerce receipt view built from the verified external order snapshot, and business-scoped outbound notification interfaces. Existing receipt formatting and Wasender queue behavior may be reused only after their current `restaurantId` assumptions are made additive and send-time tenant revalidation remains intact.
