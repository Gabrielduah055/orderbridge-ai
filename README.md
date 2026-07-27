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
OPENROUTER_CUSTOMER_AGENT_ENABLED=false
OPENROUTER_CUSTOMER_LEGACY_FALLBACK=false
OPENROUTER_SITE_URL=
OPENROUTER_APP_NAME=OrderBridgeAI
```

The backend reads Firebase service account values from environment variables. `FIREBASE_PRIVATE_KEY` supports escaped newlines and is converted internally with `.replace(/\\n/g, "\n")`.

## Restaurant Agent

Owner and manager WhatsApp messages can use OpenRouter by setting `AI_PROVIDER=openrouter`. Customer WhatsApp messages can also use OpenRouter when `OPENROUTER_CUSTOMER_AGENT_ENABLED=true`. The backend sends the selected model only role-filtered tool definitions, then executes any requested tool locally through the existing `executeAgentTool` flow. MongoDB-backed services remain the source of truth for menu items, prices, availability, drafts, orders, revenue, and mutations.

Hermes is still available for rollback with `AI_PROVIDER=hermes`. To keep customers on the legacy deterministic ordering flow while testing owner/manager OpenRouter, leave `OPENROUTER_CUSTOMER_AGENT_ENABLED=false`. If customer OpenRouter is enabled and fails, the backend returns a safe failure response unless `OPENROUTER_CUSTOMER_LEGACY_FALLBACK=true` is explicitly configured.

Customer OpenRouter tools are limited to customer-safe operations: reading the restaurant profile, menu, delivery information, the customer's own order details/latest order, and managing that customer's own order draft. Customers cannot update prices, change availability, read revenue, or access another customer's order.

## Order Confirmation Workflow

OrderBridge treats customer submission and restaurant acceptance as separate confirmations.

1. The customer builds a draft and confirms the final summary.
2. `confirm_order_draft` converts the draft into one real order with status `pending`.
3. In this workflow, `pending` means awaiting restaurant confirmation.
4. The owner is notified from real saved order data and can reply `Confirm order ORD-123` or `Reject order ORD-123`.
5. Owner/manager confirmation changes the order to `confirmed`, notifies the customer, generates the receipt PDF, and sends it to the customer.
6. Owner/manager rejection changes the order to `cancelled`, notifies the customer, and does not generate a confirmed-order receipt.

The backend controls order creation, status transitions, owner/customer notifications, receipt generation, receipt delivery, and idempotency. The AI chooses tools and writes conversational responses, but the webhook only triggers side effects from structured backend result flags such as `orderEvent`, `notifyOwner`, `notifyCustomer`, and `receiptRequired`.

Important timestamps on orders include `customerConfirmedAt`, `ownerNotifiedAt`, `restaurantConfirmedAt`, `restaurantRejectedAt`, `customerConfirmedNotificationSentAt`, `rejectionNotificationSentAt`, `receiptGeneratedAt`, and `receiptSentAt`. These fields are used to skip duplicate notifications and duplicate receipt sends on retries.

Receipt PDFs are generated only after restaurant confirmation. If receipt generation or document delivery fails, the order remains confirmed and the failure is recorded on the order for follow-up.

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

## Create the First Super Admin

1. Create the first admin user in Firebase from the Firebase console or your frontend login flow.
2. Copy the Firebase user UID.
3. Insert a matching MongoDB `users` document:

```js
db.users.insertOne({
  firebaseUid: "firebase-user-uid",
  name: "Super Admin",
  email: "admin@orderbridge.ai",
  role: "super_admin",
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date()
});
```

Restaurant admins must include `restaurantId`; super admins do not.

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
