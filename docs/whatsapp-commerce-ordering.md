# WhatsApp commerce ordering

E-commerce WhatsApp purchasing is opt-in per business. Set
`whatsappIntegration.commercePurchasingEnabled` to `true` through the trusted
business create/update boundary. The setting defaults to `false`. When WhatsApp
is also enabled, capability derivation adds `commerce_ordering`; turning either
setting off removes it. A later superadmin PR should expose this boolean without
allowing callers to edit the derived capability directly.

`commerce_ordering` is accepted only for an e-commerce customer on WhatsApp. It
does not change restaurant permissions and does not expose purchasing tools to
the website chatbot. `commerce_catalog_read` remains independently required for
catalog browsing and verified product resolution.

## Tools and persistent state

Purchasing uses `get_commerce_order_draft`, `add_commerce_order_item`,
`remove_commerce_order_item`, `set_commerce_order_item_quantity`,
`update_commerce_order_customer`, `clear_commerce_order_draft`,
`request_commerce_quote`, `confirm_commerce_checkout`, and
`get_commerce_checkout_status`.

One `CommerceShoppingDraft` is stored per trusted `businessId` and WhatsApp
`customerKey`. The customer key and notification phone come from Wasender
identity resolution, never tool arguments. Draft mutations use versioned
compare-and-set updates and a bounded hash of the trusted provider request ID,
action, and validated arguments, so duplicate webhooks and repeated identical
tool calls cannot apply a cart/customer change twice.

Products are re-read from the configured catalog before add/quantity changes.
The draft collects full name, email, delivery address, order notes, and explicit
WhatsApp consent. An unresolved identity may browse and build a draft but cannot
quote until a trusted E.164 notification phone is available.

Contextual WhatsApp-consent replies are bound to the current persisted assistant
question. A later unambiguous `yes` or `no` is accepted; conflicting, negated, or
conditional wording is rejected. Standalone action words such as `send` are not
consent. The originating customer request and assistant turn are retained until
the consent decision is applied atomically.

## Quote and checkout state

The normal local flow is `draft -> quoted -> explicitly confirmed ->
initializing -> pending -> paid`. Recovery/terminal branches are `uncertain`,
`needs_attention`, `failed`, and `expired`.

A quote stores its exact authoritative item snapshot, integer-pesewa totals,
`GHS` currency, expiry, and draft version. Any purchase-detail mutation increments
the version, so an older quote cannot be confirmed. After the authoritative quote
is actually rendered, its persisted presentation records the assistant turn and
originating customer request. Checkout requires a different, later customer
request with an unambiguous affirmative confirmation. Same-turn quote/confirmation,
negated confirmation, and conditional confirmation are rejected. The confirmation
record binds that later request to the exact quote, version, and assistant turn in
the same atomic transition that reserves the checkout idempotency key.

Before session creation, OrderBridge persists one UUID idempotency key beside the
quote. A timeout, transport failure, `CHECKOUT_INITIALIZING`, or
`CHECKOUT_INITIALIZATION_UNCERTAIN` retains the quote, key, and checkout state.
The next confirmation/status attempt resumes the same backend operation. A new
quote or payment cannot replace an unresolved checkout. Clearing or editing the
local draft never claims to cancel a backend checkout, order, or payment;
unresolved references remain recoverable.

Generic HTTP 5xx responses, malformed/lost responses, transport failures, and
unknown submission errors are also uncertain. Only documented definitive errors
may move the local checkout to `failed`; expiry/change errors move it to `expired`,
and binding/idempotency conflicts move it to `needs_attention`. Unknown outcomes
retain the original quote, key, and recovery reference and block replacement
payment attempts until authoritative recovery resolves them.

Payment is authoritative only after customer-scoped status says `paid`. “I have
paid” invokes the status tool. Checkout tools do not send receipts or alerts;
Kawama's signed payment flow continues to the existing paid-order event, receipt,
manager notification, and review-invitation pipeline.

## Kawama PR1 API mapping

All calls use `commerceIntegration.baseUrl` and the server-only API key as
`Authorization: Bearer ...`:

| Operation | Endpoint | Trusted binding |
| --- | --- | --- |
| Quote | `POST /api/integrations/orderbridge/checkout/quotes` | `customerKey`, trusted customer/phone, notes, verified items |
| Create/resume | `POST /api/integrations/orderbridge/checkout/sessions` | saved `quoteId`, `customerKey`, persisted `Idempotency-Key` |
| Status | `GET /api/integrations/orderbridge/checkout/sessions/:sessionId/status` | saved `sessionId`, `customerKey` query |

Responses must use `{ message, data }`, stay within the response-size limit, and
match PR1's strict schemas. Amounts are integer pesewas, currency is `GHS`, and
delivery is `arranged_separately`. Product links keep the canonical-host rule. A
payment URL is separately validated as credential-free HTTPS and accepted only
from a validated checkout response; the model cannot construct one.

Kawama must enable/configure PR1 (`ORDERBRIDGE_CHECKOUT_ENABLED`, matching bearer
key/business ID, HTTPS WhatsApp callback, and Paystack). OrderBridge provisioning
must set the matching base URL/API key and explicitly enable WhatsApp purchasing.
