# OrderBridge AI Backend

OrderBridge AI is a multi-tenant WhatsApp AI restaurant ordering SaaS. This backend foundation supports the first admin feature: super admins can create and manage restaurants. WhatsApp bot flows, Hermes AI ordering, menus, orders, receipts, reports, and promotions are intentionally left for later modules.

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
```

The backend reads Firebase service account values from environment variables. `FIREBASE_PRIVATE_KEY` supports escaped newlines and is converted internally with `.replace(/\\n/g, "\n")`.

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
