# OpenRouter Agent Migration

## Current Owner Message Flow

Wasender receives a text webhook, resolves the restaurant from the WhatsApp session/number, resolves the sender from the restaurant owner and manager phones, saves the inbound message, and routes trusted owner/manager messages through the restaurant agent service. Before this migration, non-customer messages were sent to Hermes unless intercepted by a local menu shortcut.

## Current Customer Message Flow

Customer messages can now use either the existing deterministic customer flow or the OpenRouter agent orchestrator. `OPENROUTER_CUSTOMER_AGENT_ENABLED=true` routes customers through OpenRouter with customer-safe tools; `false` keeps the legacy flow. `OPENROUTER_CUSTOMER_LEGACY_FALLBACK=true` enables explicit legacy fallback if the customer OpenRouter path fails.

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

Use `AI_PROVIDER=openrouter` with `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` to enable the OpenRouter agent. Set `OPENROUTER_CUSTOMER_AGENT_ENABLED=true` to migrate customer conversations. Set `AI_PROVIDER=hermes` to return owner/manager conversations to the legacy Hermes path. Set `OPENROUTER_CUSTOMER_AGENT_ENABLED=false` to keep customer conversations on the legacy parser.
