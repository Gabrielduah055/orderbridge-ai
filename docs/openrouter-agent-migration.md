# OpenRouter Agent Migration

## Current Owner Message Flow

Wasender receives a text webhook, resolves the restaurant from the WhatsApp session/number, resolves the sender from the restaurant owner and manager phones, saves the inbound message, and routes trusted owner/manager messages through the restaurant agent service. Before this migration, non-customer messages were sent to Hermes unless intercepted by a local menu shortcut.

## Current Customer Message Flow

Customer messages use the OpenRouter agent orchestrator whenever `AI_PROVIDER=openrouter`. `OPENROUTER_CUSTOMER_AGENT_ENABLED` defaults to enabled; explicit `false` is an emergency rollback to the legacy flow. `OPENROUTER_CUSTOMER_LEGACY_FALLBACK=true` enables explicit legacy fallback if the customer OpenRouter path fails before any successful mutation.

## Current Hermes Flow

Hermes is configured by `HERMES_AGENT_URL`/`HERMES_API_URL`/`HERMES_API_BASE_URL`, `HERMES_API_KEY`, `HERMES_AGENT_MODEL`, and `HERMES_TIMEOUT_MS`. The backend sends trusted context as instructions and expects Hermes to use registered MCP tools. Hermes remains available behind `AI_PROVIDER=hermes` during rollback.

## Reusable Tools And Services

The migration reuses:

- `tool.registry.ts` for backend tool definitions and handlers.
- `tool.executor.ts` for role checks, Zod validation, execution, pending confirmation, and safe errors.
- `tool.permissions.ts` for owner/manager/customer permissions.
- Menu, order, restaurant, receipt, pending action, sender identity, and conversation-history services.

## Role Permissions

Tools are exposed to OpenRouter only when permitted for the resolved backend sender role. Customer tools are limited to menu/profile/delivery reads, the customer's own order lookup, and order-draft operations. The model cannot provide trusted `restaurantId`, sender phone, sender role, or session context as tool arguments.

## Confirmation Flow

Sensitive mutation tools continue to create pending backend actions unless the backend execution context is confirmed. Explicit owner/manager confirmations and cancellations are handled deterministically before OpenRouter orchestration.

## Conversation History Flow

The restaurant agent saves inbound user messages before orchestration. The OpenRouter orchestrator loads a bounded recent history window, excludes prior tool messages from provider chat history, saves tool outcomes as audit records, and the restaurant agent saves the final assistant response.

For customers, active order drafts and pending clarification records are included as trusted context. Transactional state comes from MongoDB-backed draft and clarification records, not from chat history alone.

For verified staff, order/report follow-up filters are stored separately in a bounded restaurant-and-sender-scoped context record. The retained record contains only filters and date boundaries; every follow-up re-queries orders. The final-answer guard formats narrow order placement and busiest-period answers from tool results so a correct order query cannot be replaced by an unrelated customer-profile summary.

## Campaign intent, eligibility, and media

Natural requests to send customer greetings, reopening announcements, or invitations to order are treated as campaign draft requests even when the word “campaign” is absent. Read-only customer analytics remain mutation-free. One-customer marketing uses a tenant-scoped saved-customer resolution and the standard campaign approval and delivery workflow.

Campaign eligibility is opt-out based for existing customers: valid messaging identities qualify unless the saved preference is an explicit decline or the profile is opted out. Unknown preferences remain unknown. Eligibility is recalculated during preview, approval, scheduling, and send-time checks.

Campaign media is always backend-trusted. A saved menu image is resolved by restaurant item name. A custom image must arrive through the owner WhatsApp upload workflow, pass Wasender metadata limits and Cloudinary validation, and be persisted on a versioned campaign. Media edits invalidate prior approval. The queue sends the approved message as the image caption and revalidates exact campaign version, recipient eligibility, and media identity immediately before delivery.

## Risks And Mitigations

- Model fabrication: mitigated by system rules and real backend tools for operational facts.
- Cross-restaurant access: mitigated by trusted execution context and ignored model-provided identity fields.
- Tool misuse: mitigated by role-filtered tool exposure plus executor permission checks.
- Infinite tool loops: mitigated by `OPENROUTER_MAX_TOOL_ROUNDS`.
- Provider outage: returns a safe failure message and does not silently fall back to Hermes when `AI_PROVIDER=openrouter`.
- Customer ambiguity: mitigated by short-lived `AgentClarification` records scoped to restaurant and customer phone.

## Target OpenRouter Architecture

Incoming WhatsApp message -> trusted backend context -> recent history plus active draft/clarification state -> OpenRouter provider -> model tool call -> local `executeAgentTool` -> Zod validation and role checks -> Mongo-backed services -> tool result returned to model -> concise final WhatsApp response.

## Migration And Rollback

Use `AI_PROVIDER=openrouter` with `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` to enable the OpenRouter agent for staff and customers. Set `AI_PROVIDER=hermes` to return owner/manager conversations to the legacy Hermes path. Set `OPENROUTER_CUSTOMER_AGENT_ENABLED=false` only for an explicit emergency customer rollback.

## Phase 6 Order Decisions

Customer confirmation submits an order to the restaurant; it does not mean the restaurant has accepted it. `confirm_order_draft` returns structured data with `orderEvent: "submitted"`, `notifyOwner: true`, and `receiptRequired: false`. The saved order starts as `awaiting_restaurant_confirmation`; legacy `pending` orders are handled as the same awaiting state.

Owner and manager confirmations must use `confirm_order`. A successful result changes the order to `accepted` and returns `orderEvent: "confirmed"`, `notifyCustomer: true`, and `receiptRequired: true`. The webhook then sends the customer acceptance message, generates the receipt from the saved MongoDB order, and sends the receipt document.

Owner and manager rejections must use `reject_order`. A successful result returns `orderEvent: "rejected"` and `notifyCustomer: true`; no receipt is generated. Rejections use `rejected` plus `restaurantRejectedAt` and optional `restaurantRejectionReason`.

Customer tools must not assume quantity. If quantity is missing, the backend stores a pending item in the draft and asks for the quantity before adding the item. Delivery fees must come from `deliveryPricing`; unresolved fees keep the draft from being submitted.

Webhook side effects are driven only by structured tool results, not by model prose. Order-level timestamps such as `ownerNotifiedAt`, `customerConfirmedNotificationSentAt`, `rejectionNotificationSentAt`, and `receiptSentAt` prevent duplicate sends when Wasender retries a webhook or an agent repeats a tool call.
