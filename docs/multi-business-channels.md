# Multi-Business and Multi-Channel Architecture

OrderBridge uses one agent orchestrator and the existing configured OpenRouter model for restaurant WhatsApp conversations and e-commerce website conversations. There is no second AI engine or website-specific model configuration.

## Additive business identity

Existing restaurants remain authoritative in the `Restaurant` collection and keep their current `restaurantId`-scoped services, orders, menus, queues, and conversations. They do not require a migration or a matching `Business` record.

The additive `Business` model holds common identity and integration configuration for new business types. An e-commerce tenant is stored directly as `type: "ecommerce"`; it never needs a fake restaurant. A future gradual migration may link a restaurant business through the optional unique `restaurantId`, but existing restaurant code does not depend on that link.

The model contains:

- business name, slug, type, status, owner/staff contacts, and timezone;
- enabled channels and capabilities;
- optional approved agent guidance;
- website integration status, a hashed server credential, allowed origins, and rate limit;
- optional WhatsApp integration identifiers for future activation;
- an external commerce API origin, authentication configuration, bounded paths, timeout, and approved product-link hosts.

Secrets use `select: false` and are removed from JSON output. Website integration keys are stored only as SHA-256 hashes. External API credentials are available only to trusted backend execution.

## Permission resolution

Tool exposure and execution both evaluate the same trusted permission context:

1. sender role;
2. business type;
3. channel;
4. enabled capabilities.

Legacy role-only helpers continue to mean a restaurant WhatsApp context, preserving existing callers and evaluations. Website e-commerce customers receive only these read-only tools when `commerce_catalog_read` is enabled:

- `search_products`;
- `get_product_details`;
- `check_product_availability`;
- `get_business_policies`.

Restaurant mutations, owner reports, campaigns, WhatsApp sends, checkout, inventory updates, price updates, and payment claims are unavailable to website customers. Trusted fields such as `businessId`, `businessType`, `channel`, capabilities, credentials, and conversation identity are stripped from model tool arguments.

## Website chat integration

The business website frontend must call its own backend. That backend calls OrderBridge:

```http
POST /api/integrations/website-chat/<businessId>/messages
Authorization: Bearer <server-side-integration-key>
Content-Type: application/json

{
  "conversationId": "opaque-session-reference-123",
  "message": "Show me phones under GHS 2,000"
}
```

The integration key must never be placed in browser JavaScript. The business ID in the path is not authorization: OrderBridge loads the business record, verifies its status, channel, capabilities, and constant-time credential hash match, then builds the trusted agent context. An optional browser `Origin` header is checked against the configured allowlist.

The response contains the natural-language answer plus structured, tool-grounded `products`, `product`, `productAvailability`, or `policies` data when applicable. Product links are returned only when an external response supplies an HTTPS URL whose hostname is in `canonicalProductHosts`.

Conversation records use `businessId + channel + conversationId`. A website session is never joined to a WhatsApp customer because of a matching name or submitted phone number. Turns for one website conversation are sequenced in process, while unrelated conversations may run concurrently. The current rate limiter is per process; distributed deployments should replace it with a shared store before horizontal scaling.

## External commerce API contract

The external origin and paths are trusted business configuration. Paths must be origin-relative, redirects are rejected, requests use HTTPS, timeouts are bounded to 500–15,000 ms, and response bodies are limited to 512 KiB.

Search receives `query` and `limit` query parameters and returns:

```json
{
  "products": [
    {
      "id": "product-123",
      "name": "Example product",
      "description": "Verified description",
      "price": 1250,
      "currency": "GHS",
      "available": true,
      "stockQuantity": 4,
      "specifications": { "storage": "256 GB" },
      "canonicalUrl": "https://shop.example.com/products/product-123"
    }
  ],
  "total": 1
}
```

Product detail returns `{ "product": <product> }`. Availability returns `{ "productId": "product-123", "available": true, "stockQuantity": 4 }`. Policies returns `{ "policies": [{ "name": "Returns", "content": "...", "url": "https://shop.example.com/returns" }] }`.

OrderBridge does not copy catalog, inventory, customer, order, checkout, or payment records into restaurant collections. Kawama should adapt its existing authoritative backend to this contract through business configuration; no Kawama name, URL, product, or instruction is hardcoded in the orchestrator.

## WhatsApp compatibility and routing

Restaurant WhatsApp routing remains on the existing controller, identity services, queue, and restaurant agent. When both a receiver number and Wasender session are present, both must resolve to the same restaurant; a missing or mismatched resolution fails closed. In production, `WASENDER_WEBHOOK_SECRET` is mandatory and a missing secret causes webhook authentication to fail.

The `Business` model reserves unique e-commerce Wasender session and number fields so a future e-commerce WhatsApp activation can use trusted tenant resolution. This change does not yet route e-commerce WhatsApp messages through restaurant identity or queue collections; those collections remain restaurant-scoped by design.

## Provisioning

Authenticated super administrators can create and inspect common business records through `/api/businesses`. When website chat is enabled and no integration key is supplied, creation returns a generated key once. Only its hash is persisted. Commerce API keys and Wasender tokens are never returned in serialized business records.
