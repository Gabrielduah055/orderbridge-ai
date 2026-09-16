# OrderBridge AI Engineering Instructions

## Product and repository scope

This repository is the TypeScript backend for OrderBridge AI, a multi-tenant WhatsApp restaurant ordering and operations SaaS serving customers, restaurant owners, managers, and super administrators.

The AI model interprets language and chooses only permitted tools. Trusted backend services and MongoDB are authoritative for sender identity, tenant scope, restaurants, menus, prices, availability, customer drafts, orders, permissions, conversations, notifications, and all state changes. Never promote model text or chat history into transactional truth.

## Technology and commands

- Runtime and framework: Node.js, Express, strict TypeScript, MongoDB/Mongoose, Firebase Admin authentication, and Zod.
- The committed `pnpm-lock.yaml` is the dependency lockfile; use `pnpm install` and do not introduce another lockfile.
- Development: `pnpm run dev`.
- TypeScript build: `pnpm run build`.
- Full test suite: `pnpm test`.
- Staff evaluation: `pnpm run eval:staff`.
- Customer evaluation: `pnpm run eval:customer`.
- Production start, after building: `pnpm start`.
- `npm test` invokes the same current package script: it compiles TypeScript and then runs `node --test tests/*.test.js`.
- There is no repository lint or formatting script; do not invent one in implementation notes.
- Treat `dist/` as generated output. Do not manually edit or commit it as source.
- Do not commit uploaded files, `.env`, credentials, private keys, provider tokens, or environment-specific artifacts.

## Architecture map

- `src/controllers`: HTTP/webhook boundaries; `wasender.controller.ts` owns webhook deduplication, trusted routing, per-customer sequencing, replies, and structured side-effect dispatch.
- `src/routes`: Express route wiring and authentication/authorization middleware composition.
- `src/services`: business rules for restaurants, identity, menus, orders, drafts, receipts, messaging, campaigns, reminders, summaries, billing, and schedulers.
- `src/services/ai`: provider selection, prompts, role-filtered provider tool definitions, orchestration, trusted argument stripping, and staff operational context.
- `src/agent-tools`: tool registry, Zod schemas and handlers, role permissions, confirmation persistence, and the sole trusted tool executor.
- `src/models`: Mongoose records and tenant-aware indexes for operational and conversation state.
- `src/middleware`: Firebase authentication, super-admin checks, request validation, uploads, and safe error handling.
- `src/evals`: bounded staff/customer agent scenarios and evaluators; these supplement rather than replace regression tests.
- `src/scripts`: explicit administrative and backfill entry points that run from built output.
- `tests`: Node test-runner regression coverage against compiled `dist/` modules.
- `docs`: workflow and migration rationale, especially `order-workflow.md` and `openrouter-agent-migration.md`.

Before changing WhatsApp routing or agent behavior, inspect `src/controllers/wasender.controller.ts`, `src/services/restaurantAgent.service.ts`, `src/services/ai/`, and `src/agent-tools/`. Before changing orders or delivery behavior, also inspect `orderDraft.service.ts`, `order.service.ts`, `orderSideEffects.service.ts`, `ownerOrderResolution.service.ts`, `wasenderIdentity.service.ts`, `customerIdentity.service.ts`, `wasenderQueue.service.ts`, the corresponding models, and regression tests.

`src/server.ts` starts the HTTP server, Wasender queue worker, follow-ups, owner summaries, pending-action reminders, campaigns, order feedback, billing reconciliation, and scheduler credential diagnostics. Treat startup behavior and worker concurrency as one system.

## Non-negotiable domain invariants

1. Scope every restaurant-owned read and mutation by trusted `restaurantId`, including secondary lookups, quoted-message resolution, pending actions, identities, schedules, and queue revalidation. Never permit cross-tenant reads or writes.
2. Never trust the model to provide `restaurantId`, sender role or phone, customer/session identity, provider credentials, prices, delivery fees, totals, or permission context. Build them from resolved backend context and MongoDB records; strip model-supplied trusted fields.
3. Owners, managers, customers, and super administrators have distinct permissions. Keep agent exposure role-filtered through `tool.permissions.ts`, provider definitions, Zod schemas, and `executeAgentTool`; do not call a handler to bypass those layers.
4. Re-read menu items and restaurant delivery configuration to calculate current prices, availability, fees, subtotals, and totals. Model-authored monetary values are never authoritative.
5. Customer submission and restaurant acceptance are separate events. `confirm_order_draft` creates an `awaiting_restaurant_confirmation` order and notifies staff; it does not accept the order.
6. Preserve service-enforced order transitions and atomic conditional updates. Treat legacy `pending` as awaiting restaurant action and legacy `confirmed` as accepted only where existing compatibility code does; do not add direct or invalid transitions.
7. A customer may amend or immediately cancel only while an order awaits restaurant action. After acceptance, cancellation is a persisted request that owner or manager staff must resolve.
8. Bind staff decisions to the latest amendment version and trusted quoted-message context. A stale notification must never accept or reject a newer order revision.
9. Generate receipts only after restaurant acceptance and from saved order/restaurant records. Receipt generation or delivery failure must be recorded without reverting an accepted order.
10. Drive webhook side effects only from structured backend results such as `orderEvent`, `notifyOwner`, `notifyCustomer`, and `receiptRequired`; never infer a mutation by parsing AI prose.
11. Make webhook processing, tool mutations, outbound sends, notifications, receipts, campaigns, reminders, and scheduled work retry-safe and idempotent. Preserve unique keys, version checks, timestamps, and atomic compare-and-set behavior.
12. Construct operational messages from saved order, restaurant, identity, and action records—not model-generated summaries.
13. Keep customer ownership stable across WhatsApp phone, LID, and mutable username forms. A mutable or reassigned username alone must never claim historical orders, profiles, sessions, or conversations.
14. An unresolved LID or username-only sender is an unverified customer. Owner/manager authorization requires a trusted normalized phone match against current restaurant staff data.
15. Process customer turns sequentially by restaurant plus stable customer identity, while allowing unrelated customers and restaurants to proceed concurrently.
16. Revalidate queued messages at send time when recipient identity, restaurant/staff status, order/amendment state, campaign version/consent, reminder state, or conversation version may have changed. Cancel stale work; retry temporary provider-verification failures safely.
17. Provider failure must fail safely. Never tell a user an operation succeeded unless the trusted tool mutation succeeded, and return customer-safe errors rather than raw provider or database details.
18. Preserve configured provider and rollback boundaries. Do not silently fall back from OpenRouter to Hermes, and never replay a customer or staff mutation through a legacy path after a successful tool mutation.
19. Never expose API keys, Firebase credentials, Wasender tokens, MCP secrets, private keys, sensitive URLs, full internal identifiers, or raw internal errors in code, tests, logs, prompts, tool results, or documentation.

## Agent and tool changes

When adding or changing an agent tool:

- Update its `tool.registry.ts` definition, strict Zod schema, and handler; that definition feeds the provider-facing schema.
- Update `tool.permissions.ts`, then verify both provider exposure and executor authorization for every role.
- Keep identity, tenancy, actor, session, credential, and other trusted fields out of model arguments.
- Resolve records through existing tenant-scoped services and recompute authoritative values server-side.
- Preserve persisted confirmation for sensitive mutations; never let repeated model calls bypass confirmation.
- Return bounded, customer-safe, structured results with explicit success/failure and any required side-effect flags.
- Add allowed-role, forbidden-role, tenant-isolation, validation, duplicate-call, and failure-path tests.
- Update prompts, evals, or docs only when observable behavior genuinely changes.

Prefer deterministic backend handling for identity resolution, authorization, order selection/decisions, confirmations, and side effects. The model interprets intent; it is not the transaction coordinator or source of business facts.

## Order and webhook changes

Inspect the complete path before editing any one layer: `wasender.controller.ts`, `restaurantAgent.service.ts`, `orderDraft.service.ts`, `order.service.ts`, `orderSideEffects.service.ts`, `ownerOrderResolution.service.ts`, `wasenderIdentity.service.ts`, `customerIdentity.service.ts`, `wasenderQueue.service.ts`, tool schemas/permissions/handlers, models, and relevant regression tests.

Always reason through duplicate webhooks and tool calls, delayed or retried messages, stale queued work, quoted replies, simultaneous orders, amendment versions, cancellation requests, usernames/LIDs, provider rate limits, and partial receipt/notification failures. Preserve the webhook-event uniqueness boundary and do not make the HTTP acknowledgement depend on slow background processing.

## Code conventions

- Keep TypeScript strict and preserve the existing ES module import syntax compiled to CommonJS.
- Follow existing `camelCase` values/functions, `PascalCase` types/models, and descriptive `*.service.ts`, `*.controller.ts`, and `*.model.ts` naming.
- Validate external requests and tool arguments with Zod or the established boundary validator.
- Put business logic and database coordination in services; keep routes thin and controllers orchestration-focused where practical.
- Use explicit types for trusted execution context, identity references, state transitions, and structured results.
- Return safe user-facing messages and structured error codes; log bounded metadata without secrets or sensitive payloads.
- Reuse existing services, identity filters, queue helpers, and error utilities before creating parallel implementations.
- Avoid unrelated refactors during focused fixes. Do not prescribe a formatter, quote style, or lint rule absent from repository configuration.

## Testing requirements

Run the smallest relevant tests during development and the full `npm test` before completion when feasible. Tests import compiled `dist/`, so a TypeScript build is part of the test script.

Changes affecting identity, permissions, orders, messages, queues, campaigns, reminders, schedulers, provider routing, or agent tools require regression coverage. Depending on the change, cover:

- The correct allowed role and all forbidden roles.
- Cross-restaurant isolation for reads, writes, indexes, quoted context, and queued work.
- Duplicate/concurrent execution, retries, and idempotent outcomes.
- Invalid, ambiguous, or model-injected input and safe failure messages.
- Stale order versions, pending actions, workflow state, recipients, consent, and schedules.
- Provider timeout, rate limit, partial failure, and final failure behavior.
- Phone, LID, changed/reassigned username, and unresolved identity variants.
- Legacy persisted data, including applicable `pending`, `confirmed`, and missing stable-key compatibility.

Do not make a failing test pass by weakening a security, tenancy, identity, idempotency, or transactional assertion unless the product requirement explicitly changed.

## Documentation and environment rules

Keep `README.md`, `.env.example`, `docs/order-workflow.md`, and `docs/openrouter-agent-migration.md` synchronized when configuration, provider behavior, workflows, or externally visible behavior changes. Environment documentation must use placeholders only; never add working credentials.

Do not turn this file into an inventory of every route, environment variable, model field, or tool. Direct future agents to the relevant source and focused docs instead.

## Completion checklist

Before handing work back:

- Review changes against the full affected workflow, not only the edited file.
- Confirm tenant, identity, permission, state-machine, idempotency, and retry invariants considered.
- Run focused tests/evals and the full `npm test` when feasible.
- Ensure generated output, uploads, secrets, and unrelated changes are absent from the diff.
- Report what changed and why, which invariants were considered, tests/evaluations run, anything not run and why, and remaining risks or follow-up work.
