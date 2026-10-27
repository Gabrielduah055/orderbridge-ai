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
  "message": "Show me phones under GHS 2,000"
}
```

The integration key must never be placed in browser JavaScript. The business ID in the path is not authorization: OrderBridge loads the business record, verifies its status, channel, capabilities, and constant-time credential hash match, then builds the trusted agent context. An optional browser `Origin` header is checked against the configured allowlist.

For the first turn, the website backend omits conversation credentials. OrderBridge returns a cryptographically random `conversationId` and a signed `conversationToken`. The website backend must keep that pair server-side and bind it to its own visitor session. It supplies both values on later turns; supplying only one, guessing an identifier, changing the business, or using an invalid token is rejected before history is read. Neither the integration key nor conversation continuation token should be exposed as a public browser credential.

```json
{
  "conversationId": "<OrderBridge-issued 256-bit identifier>",
  "conversationToken": "<OrderBridge-signed continuation token>",
  "message": "Which one has 256 GB storage?"
}
```

Anonymous website visitors remain `verified: false`; a valid continuation token authorizes access to that conversation but does not prove a real-world customer identity.

The response remains conversational: the existing model may recommend products, compare options, explain grounded differences, respect budgets and preferences, and answer follow-up references. After commerce tools run, the orchestrator supplies the same model with backend-issued placeholders for every trusted catalog and policy fact. The response processor rejects unknown placeholders and ungrounded literal facts, then renders valid placeholders from accumulated backend results. If validation fails, OrderBridge uses a safe factual fallback rather than exposing unsupported model prose.

Multiple successful tool calls are merged by product ID, so separate detail lookups remain available for comparisons. Newer detail and availability results override older values. A failed explicit availability lookup suppresses older availability rather than allowing stale search data to win. A bounded trusted grounding snapshot may be reused for follow-up turns in the same authorized conversation for up to 15 minutes; it is stored as conversation metadata, not treated as model-authored history.

The response also contains structured, tool-grounded `products`, `product`, `productAvailability`, or `policies` data when applicable. Prices, currencies, availability, specifications, policies, and product URLs always originate from validated backend tool results. Product links are returned only when an external response supplies an HTTPS URL whose hostname is in `canonicalProductHosts`.

Conversation records use `businessId + channel + conversationId`. A website session is never joined to a WhatsApp customer because of a matching name or submitted phone number. Turns for one website conversation are sequenced in process, while unrelated conversations may run concurrently.

The website limiter enforces the configured `requestsPerMinute` across the whole business, so rotating conversation identifiers cannot reset the allowance. Continued conversations also have a 30-request-per-minute burst ceiling (or the lower business limit). Excess requests return HTTP 429 with `Retry-After` and `X-RateLimit-Scope`. The limiter and turn sequencing maps are currently process-local. A horizontally scaled deployment must replace them with a shared atomic store such as Redis before enabling multiple application instances.

## External commerce API contract

The external origin and paths are trusted business configuration. Paths must be origin-relative, redirects are rejected, requests use HTTPS, timeouts are bounded to 500–15,000 ms, and response bodies are limited to 512 KiB.

Search accepts the following validated fields when the business API supports them:

- optional `query` text;
- `limit` from 1–10;
- non-negative `minPrice` and `maxPrice`, with `minPrice <= maxPrice`;
- optional `category`;
- optional `available` status;
- up to ten `preferences` values;
- `sort` as `relevance`, `price_asc`, or `price_desc`.

At least one of `query`, `category`, or `preferences` is required. OrderBridge forwards these as `query`, `limit`, `minPrice`, `maxPrice`, `category`, `available`, repeated `preference`, and `sort` query parameters. The external business backend remains authoritative for filtering, ranking, price, availability, and relevance. It returns:

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

Restaurant WhatsApp routing remains on the existing controller, identity services, queue, and restaurant agent. A trusted match by receiver number or Wasender session is sufficient when the other field is absent or is not configured for that payload shape. If both identifiers resolve, they must resolve to the same restaurant; conflicting matches fail closed. In production, `WASENDER_WEBHOOK_SECRET` is mandatory and a missing secret causes webhook authentication to fail.

The `Business` model reserves unique e-commerce Wasender session and number fields so a future e-commerce WhatsApp activation can use trusted tenant resolution. This change does not yet route e-commerce WhatsApp messages through restaurant identity or queue collections; those collections remain restaurant-scoped by design.

## Provisioning

Authenticated super administrators can create and inspect common business records through `/api/businesses`. When website chat is enabled and no integration key is supplied, creation returns a generated key once. Only its hash is persisted. Commerce API keys and Wasender tokens are never returned in serialized business records.
