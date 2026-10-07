# OrderBridge AI Backend

OrderBridge AI is a multi-tenant WhatsApp AI restaurant ordering SaaS. This backend foundation supports super admins, restaurants, menus, orders, Wasender webhooks, receipt PDFs, and a restaurant operations agent.

## Tech Stack

- Node.js
- Express.js
- TypeScript
- MongoDB and Mongoose
- Firebase Authentication with Firebase Admin SDK
- Zod validation

## Install

```bash
npm install
```

## Environment Setup

Create a `.env` file from `.env.example`:

```env
PORT=5000
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/orderbridge
# MONGODB_URL and MONGO_URL are also supported for compatibility.

# Optional override. Defaults to these values for mongodb+srv Atlas URLs.
MONGODB_DNS_SERVERS=8.8.8.8,1.1.1.1
DEBUG_DB_ERRORS=false

FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_CLIENT_EMAIL=your-service-account-client-email
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your-openrouter-api-key
OPENROUTER_MODEL=google/gemini-3.1-flash-lite
OPENROUTER_TIMEOUT_MS=45000
OPENROUTER_MAX_TOOL_ROUNDS=6
OPENROUTER_MAX_OUTPUT_TOKENS=800
OPENROUTER_CUSTOMER_AGENT_ENABLED=true
OPENROUTER_CUSTOMER_LEGACY_FALLBACK=false
OPENROUTER_SITE_URL=
OPENROUTER_APP_NAME=OrderBridgeAI
OPERATIONAL_TELEMETRY_RETENTION_DAYS=30
ADMIN_AUDIT_RETENTION_DAYS=365

# Transactional post-order feedback timing (optional; safe defaults shown)
ORDER_FEEDBACK_DELAY_MINUTES=120
ORDER_FEEDBACK_REMINDER_HOURS=12
ORDER_AUTO_COMPLETE_HOURS=24
```

The backend reads Firebase service account values from environment variables. `FIREBASE_PRIVATE_KEY` supports escaped newlines and is converted internally with `.replace(/\\n/g, "\n")`.

## Restaurant Agent

Owner, manager, and customer WhatsApp messages use OpenRouter when `AI_PROVIDER=openrouter`. `OPENROUTER_CUSTOMER_AGENT_ENABLED` defaults to enabled and is retained only as an emergency customer rollback when explicitly set to `false`. The backend sends the selected model only role-filtered tool definitions, then executes any requested tool locally through the existing `executeAgentTool` flow. MongoDB-backed services remain the source of truth for menu items, prices, availability, drafts, orders, revenue, and mutations.

Hermes is still available for rollback with `AI_PROVIDER=hermes`. To explicitly keep customers on the legacy deterministic ordering flow while staff use OpenRouter, set `OPENROUTER_CUSTOMER_AGENT_ENABLED=false`. If customer OpenRouter fails, the backend returns a safe failure response unless `OPENROUTER_CUSTOMER_LEGACY_FALLBACK=true` is explicitly configured. Legacy fallback is never invoked after a successful AI-side customer mutation.

Customer OpenRouter tools are limited to customer-safe operations: reading the restaurant profile, menu, delivery information, the customer's own order details/latest order, managing that customer's own order draft, cancelling a pre-acceptance order, requesting cancellation after acceptance, and amending a submitted order while it is still awaiting restaurant confirmation. Customers cannot update prices, change availability, read revenue, access another customer's order, or edit an order after the restaurant has acted on it. Customer cancellations, cancellation requests, and submitted-order amendments notify the owner.

## Order Confirmation Workflow

OrderBridge treats customer submission and restaurant acceptance as separate confirmations.

1. The customer builds a draft and confirms the final summary.
2. `confirm_order_draft` converts the draft into one real order with status `awaiting_restaurant_confirmation`.
3. Legacy `pending` orders are treated as awaiting restaurant confirmation for backward compatibility.
4. The owner is notified from real saved order data and can reply `Confirm order ORD-123` or `Reject order ORD-123`.
5. Owner/manager confirmation changes the order to `accepted`, notifies the customer, generates the receipt PDF, and sends it to the customer.
6. Owner/manager rejection changes the order to `rejected`, notifies the customer, and does not generate an accepted-order receipt.

The backend controls order creation, status transitions, owner/customer notifications, receipt generation, receipt delivery, and idempotency. The AI chooses tools and writes conversational responses, but the webhook only triggers side effects from structured backend result flags such as `orderEvent`, `notifyOwner`, `notifyCustomer`, and `receiptRequired`.

Important timestamps on orders include `customerConfirmedAt`, `ownerNotifiedAt`, `restaurantConfirmedAt`, `restaurantRejectedAt`, `customerConfirmedNotificationSentAt`, `rejectionNotificationSentAt`, `receiptGeneratedAt`, and `receiptSentAt`. These fields are used to skip duplicate notifications and duplicate receipt sends on retries.

Delivery fees are resolved only from restaurant configuration. Supported configuration is `deliveryPricing.type` of `flat`, `zone_based`, or `manual_confirmation`; unresolved delivery fees block final submission.

Receipt PDFs are generated only after restaurant acceptance. If receipt generation or document delivery fails, the order remains accepted and the failure is recorded on the order for follow-up.

After the accepted-order text or receipt is successfully sent by Wasender, the backend schedules one transactional post-order feedback request. A customer confirmation or delivery-confirming feedback completes the order; a non-delivery report keeps it open and alerts the owner. If the request receives no response, the order is automatically completed after the configured timeout unless a non-delivery issue is unresolved. Receipt generation, receipt delivery, payment state, and completion remain independent.

## Owner order follow-ups and reports

Owner/manager order-list filters are retained for a short, restaurant-and-staff-scoped window so direct follow-ups such as “who placed those orders?” and “when were they placed?” re-query the same authoritative order period. Chat history is never used as the order record, and an explicit new period or filter replaces the retained one. Placement timestamps are formatted in the restaurant timezone (default `Africa/Accra`) and remain separate from completion timestamps.

Owner business reports expose busiest calendar dates and weekday aggregates for weekly, custom, and all-time periods. Weekday totals and per-occurrence averages are backend-calculated, ties are preserved, and an unqualified “usually busiest weekday” uses all recorded activity.

## Customer campaigns

Promotional and inactivity-reengagement campaigns require a valid current WhatsApp identity and exclude customers when `marketingConsent === false` or `isOptedOut === true`. Announcement and holiday campaigns may include valid saved customers without marketing consent, but always exclude `isOptedOut === true`. An unknown preference remains unknown; campaign eligibility does not rewrite it as consent. STOP handling immediately cancels every pending campaign delivery. Provider or deployment-specific messaging restrictions may still apply independently.

Campaign drafts support all eligible customers, behavioural segments, and one safely resolved saved customer. Same-name customers require masked-phone clarification, and arbitrary external recipients are not accepted. Greetings, reopening announcements, and invitations to order use the same draft, preview, explicit approval, snapshot, idempotent queue, and send-time revalidation workflow as other campaigns.

A campaign may attach an existing saved menu-item image or a trusted owner-uploaded JPG, PNG, or WEBP up to 5 MB. Custom uploads use the existing Wasender decryption and Cloudinary validation path. Any message, audience, schedule, or media change increments the campaign version and requires renewed approval. Delivery sends the approved text as the image caption and cancels stale work when the campaign version, recipient eligibility, restaurant credentials, or referenced media changes.

Owners and managers can preview and confirm one direct message to one safely resolved saved customer. Direct messages are tenant-scoped, reject explicitly opted-out customers, bind confirmation to the resolved profile and stable WhatsApp identity, use an idempotent outbound queue key, and revalidate staff authorization, restaurant credentials, customer identity, and opt-out state immediately before delivery.

## Firebase Setup

1. Create or open a Firebase project.
2. Enable Firebase Authentication for the frontend login method you want to use.
3. Create a Firebase Admin service account key.
4. Copy `project_id`, `client_email`, and `private_key` into the backend `.env`.

The backend does not create Firebase users and does not issue JWTs. The frontend signs users in with Firebase, then sends requests with:

```http
Authorization: Bearer <firebase_id_token>
```

The backend verifies that token, then checks the MongoDB `User` record for role and active status.

## Run

```bash
npm run dev
```

Build and run production output:

```bash
npm run build
npm start
```

Health check:

```http
GET /health
```

Response:

```json
{
  "success": true,
  "message": "OrderBridge AI backend is running"
}
```

The public `GET /health` response remains intentionally minimal. Detailed operational data is available only to authenticated active users with the `super_admin` role:

```http
GET /api/admin/operations/whatsapp?window=24h&limit=50
GET /api/admin/operations/agents?window=24h
GET /api/admin/operations/health
GET /api/admin/audit-logs?limit=50
```

Operational responses use a response-level `generatedAt` plus component-level `observedAt` values. A newly generated response does not refresh an old observation. MongoDB ping and queue-backlog diagnostics have explicit bounded deadlines; a disconnect, timeout, or query failure returns a partial health snapshot and marks backlog values unavailable (`null`) instead of inventing zeroes. The protected health route still requires Firebase verification followed by the active user and `super_admin` role stored in MongoDB. If MongoDB is unavailable, that authorization cannot be completed safely, so the request returns a bounded `503` response instead of bypassing authorization or returning a partial snapshot to an unverified role. Wasender configuration reports only whether credentials are configured and a masked session reference; provider connection health stays `unknown` / `not_monitored` until a direct observation exists. WhatsApp activity windows count each record once when a receive, processing, send, or latest-attempt timestamp falls within the requested inclusive window, and each direction is capped at the newest 5,000 activity records. Responses exclude credentials, message bodies, customer and order content, tool arguments/results, and raw provider payloads or errors.

Agent telemetry stores separate records for complete agent turns, individual provider requests, and local tool executions. Queries are capped at 5,000 newest records and telemetry expires after 30 days by default. `OPERATIONAL_TELEMETRY_RETENTION_DAYS` may set 1-90 days. Telemetry persistence is best-effort and never breaks customer-facing agent execution.

Successful super-admin mutations are audited from the authenticated backend user. Stored details are limited to action, target identifiers, changed field names, and allowlisted scalar metadata. Audit entries expire after 365 days by default; `ADMIN_AUDIT_RETENTION_DAYS` accepts 30-2,555 days. A failed initial audit write enters a bounded in-memory queue (1,000 unresolved records, retry every 5 seconds in batches of 25). Retry passes are serialized, and health reports queued and in-flight records as unresolved until persistence completes. The completed mutation response remains successful. Retries are idempotent by event ID, but this remains best effort: queued or in-flight entries can be lost on process restart and new entries are dropped if the unresolved queue is full.

## Create the First Super Admin

Create or sign in once with the intended account using Firebase Authentication, then run:

```bash
npm run bootstrap:superadmin -- --email=admin@example.com
```

The command looks up the existing Firebase user, then safely creates or updates the matching MongoDB user as an active `super_admin`. It does not create a public bootstrap endpoint or print credentials. It fails rather than guessing if an existing MongoDB record conflicts with the Firebase UID or email.

The authenticated frontend profile is available at `GET /api/auth/me`. It returns only the user's id, email, role, and active state.

## Restaurant Routes

All restaurant routes require a Firebase ID token and a MongoDB user with `role: "super_admin"`.

```http
POST   /api/restaurants
GET    /api/restaurants
GET    /api/restaurants/:restaurantId
PATCH  /api/restaurants/:restaurantId
PATCH  /api/restaurants/:restaurantId/status
PATCH  /api/restaurants/:restaurantId/plan
DELETE /api/restaurants/:restaurantId
```

Status body:

```json
{
  "status": "active"
}
```

Plan body:

```json
{
  "plan": "premium"
}
```

## Create Restaurant Example

```json
{
  "name": "Auntie Ama Foods",
  "ownerName": "Auntie Ama",
  "ownerPhone": "0241234567",
  "managerPhones": ["0241234567"],
  "plan": "growth",
  "status": "trial",
  "wasenderSessionId": "auntie-ama-session",
  "whatsappNumber": "0241234567",
  "openingHours": "Monday to Saturday, 8am to 9pm",
  "pickupAddress": "Madina Zongo Junction",
  "deliveryEnabled": true,
  "deliveryAreas": ["Madina", "Adenta", "Legon"],
  "deliveryFeeNote": "Delivery fee depends on location and will be confirmed by staff.",
  "assistantTone": "friendly",
  "followUpEnabled": true,
  "followUpDelayMinutes": 5
}
```

Restaurant slugs are generated from names and kept unique automatically. Ghana phone numbers are normalized where possible, for example `0241234567` becomes `+233241234567`.

## Plans

Plans are configured in `src/constants/planFeatures.ts`.

- `starter`: 30 menu items, 1 manager phone, auto follow-up and receipt PDFs.
- `growth`: 100 menu items, 3 manager phones, food images, daily reports, and promotions.
- `premium`: 500 menu items, 10 manager phones, scheduled promos, analytics, and advanced reports.
