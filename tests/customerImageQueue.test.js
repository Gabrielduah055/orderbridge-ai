const assert = require("node:assert/strict");
const test = require("node:test");

const { CustomerSession } = require("../dist/models/customerSession.model");
const { OutboundMessage } = require("../dist/models/outboundMessage.model");
const {
  enqueueWasenderMessage,
  processNextQueuedWasenderMessage,
  sendQueuedWasenderMessage
} = require("../dist/services/wasenderQueue.service");

const restaurantId = "64b000000000000000000998";
const customerPhone = "+233500000099";
const imageUrl = "https://res.cloudinary.com/demo/image/upload/chicken.jpg";

const resolvedQuery = (value) => ({
  sort() {
    return this;
  },
  select() {
    return Promise.resolve(value);
  }
});

test("queued image dispatch sends backend media with its safe caption", async () => {
  const calls = [];
  const result = await sendQueuedWasenderMessage(
    {
      sessionId: "session-1",
      to: customerPhone,
      type: "image",
      imageUrl,
      caption: "Here is Chicken Salad.",
      apiKey: "restaurant-token"
    },
    {
      sendImage: async (...args) => {
        calls.push(args);
        return { success: true, status: 200 };
      }
    }
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls, [[
    "session-1",
    customerPhone,
    imageUrl,
    "Here is Chicken Salad.",
    { apiKey: "restaurant-token" }
  ]]);
});

test("a transient queued image failure remains pending and succeeds on retry", async () => {
  const originalFindOne = OutboundMessage.findOne;
  const originalFindOneAndUpdate = OutboundMessage.findOneAndUpdate;
  const originalSessionFindOne = CustomerSession.findOne;
  const originalWarn = console.warn;
  let attempts = 0;
  let sends = 0;
  const candidate = {
    _id: "image-queue-1",
    sessionId: "session-1",
    nextAttemptAt: new Date(0),
    async save() {
      return this;
    }
  };
  const locked = {
    ...candidate,
    restaurantId,
    to: customerPhone,
    type: "image",
    imageUrl,
    caption: "Here is Chicken Salad.",
    apiKey: "restaurant-token",
    status: "sending",
    attempts: 0,
    maxAttempts: 5,
    metadata: {
      kind: "menu_item_image_delivery",
      restaurantId,
      customerPhone,
      menuItemId: "menu-chicken"
    },
    async save() {
      return this;
    }
  };

  try {
    console.warn = () => undefined;
    OutboundMessage.findOne = (filter) => {
      if (filter.status === "sent") {
        return resolvedQuery(null);
      }
      return resolvedQuery(candidate);
    };
    OutboundMessage.findOneAndUpdate = () => {
      attempts += 1;
      locked.attempts = attempts;
      return resolvedQuery(locked);
    };
    CustomerSession.findOne = () => resolvedQuery({
      conversationVersion: 1,
      currentStep: "choosing_items"
    });

    const sendMessage = async () => {
      sends += 1;
      return sends === 1
        ? { success: false, status: 429, error: "rate limited", retryAfterMs: 1 }
        : { success: true, status: 200, data: { id: "provider-image-1" } };
    };

    assert.equal(await processNextQueuedWasenderMessage({ sendMessage }), true);
    assert.equal(locked.status, "pending");
    assert.equal(locked.nextAttemptAt instanceof Date, true);

    assert.equal(await processNextQueuedWasenderMessage({ sendMessage }), true);
    assert.equal(locked.status, "sent");
    assert.equal(sends, 2);
  } finally {
    OutboundMessage.findOne = originalFindOne;
    OutboundMessage.findOneAndUpdate = originalFindOneAndUpdate;
    CustomerSession.findOne = originalSessionFindOne;
    console.warn = originalWarn;
  }
});

test("terminal image failure queues one URL-free safe fallback", async () => {
  const originalFindOne = OutboundMessage.findOne;
  const originalFindOneAndUpdate = OutboundMessage.findOneAndUpdate;
  const originalSessionFindOne = CustomerSession.findOne;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const fallbackJobs = [];
  const candidate = {
    _id: "image-queue-terminal",
    sessionId: "session-1",
    nextAttemptAt: new Date(0),
    async save() {
      return this;
    }
  };
  const locked = {
    ...candidate,
    restaurantId,
    to: customerPhone,
    type: "image",
    imageUrl,
    caption: "Here is Chicken Salad.",
    apiKey: "restaurant-token",
    idempotencyKey: "image:webhook-1",
    status: "sending",
    attempts: 5,
    maxAttempts: 5,
    metadata: {
      kind: "menu_item_image_delivery",
      restaurantId,
      customerPhone,
      menuItemId: "menu-chicken"
    },
    async save() {
      return this;
    }
  };

  try {
    console.info = () => undefined;
    console.warn = () => undefined;
    OutboundMessage.findOne = (filter) =>
      resolvedQuery(filter.status === "sent" ? null : candidate);
    OutboundMessage.findOneAndUpdate = () => resolvedQuery(locked);
    CustomerSession.findOne = () => resolvedQuery({
      conversationVersion: 1,
      currentStep: "choosing_items"
    });

    await processNextQueuedWasenderMessage({
      sendMessage: async () => ({
        success: false,
        status: 503,
        error: `provider rejected ${imageUrl}`
      }),
      enqueueMessage: async (input) => {
        fallbackJobs.push(input);
        return input;
      }
    });

    assert.equal(locked.status, "failed");
    assert.equal(fallbackJobs.length, 1);
    assert.equal(fallbackJobs[0].type, "text");
    assert.match(fallbackJobs[0].text, /couldn't send the image right now/i);
    assert.doesNotMatch(fallbackJobs[0].text, /https?:\/\//i);
    assert.equal(fallbackJobs[0].imageUrl, undefined);
  } finally {
    OutboundMessage.findOne = originalFindOne;
    OutboundMessage.findOneAndUpdate = originalFindOneAndUpdate;
    CustomerSession.findOne = originalSessionFindOne;
    console.info = originalInfo;
    console.warn = originalWarn;
  }
});

test("an image idempotency key prevents duplicate queue jobs", async () => {
  const originalFindOne = OutboundMessage.findOne;
  const originalCreate = OutboundMessage.create;
  let stored;
  let creates = 0;

  try {
    OutboundMessage.findOne = () => resolvedQuery(stored ?? null);
    OutboundMessage.create = async (input) => {
      creates += 1;
      stored = { _id: "image-queue-1", ...input };
      return stored;
    };

    const input = {
      restaurantId,
      sessionId: "session-1",
      to: customerPhone,
      type: "image",
      imageUrl,
      caption: "Here is Chicken Salad.",
      idempotencyKey: `send_restaurant_agent_image:event-1:${customerPhone}`
    };
    const first = await enqueueWasenderMessage(input);
    const duplicate = await enqueueWasenderMessage(input);

    assert.equal(creates, 1);
    assert.equal(duplicate, first);
  } finally {
    OutboundMessage.findOne = originalFindOne;
    OutboundMessage.create = originalCreate;
  }
});

test("a queued text after an image is deferred by per-session spacing", async () => {
  const originalFindOne = OutboundMessage.findOne;
  const originalFindOneAndUpdate = OutboundMessage.findOneAndUpdate;
  let saved = 0;
  let sends = 0;
  const now = new Date();
  const candidate = {
    _id: "text-after-image",
    sessionId: "session-1",
    nextAttemptAt: new Date(0),
    async save() {
      saved += 1;
      return this;
    }
  };

  try {
    OutboundMessage.findOne = (filter) =>
      resolvedQuery(filter.status === "pending" ? candidate : { sentAt: now });
    OutboundMessage.findOneAndUpdate = () => {
      throw new Error("spacing must be applied before a queue job is locked");
    };

    const processed = await processNextQueuedWasenderMessage({
      sendMessage: async () => {
        sends += 1;
        return { success: true };
      }
    });

    assert.equal(processed, true);
    assert.equal(saved, 1);
    assert.equal(sends, 0);
    assert.equal(candidate.nextAttemptAt.getTime() > now.getTime(), true);
  } finally {
    OutboundMessage.findOne = originalFindOne;
    OutboundMessage.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("queued text and document dispatch behavior is unchanged", async () => {
  const calls = [];
  const dependencies = {
    sendText: async (...args) => {
      calls.push(["text", ...args]);
      return { success: true };
    },
    sendDocument: async (...args) => {
      calls.push(["document", ...args]);
      return { success: true };
    }
  };

  await sendQueuedWasenderMessage(
    { sessionId: "session-1", to: customerPhone, type: "text", text: "Hello" },
    dependencies
  );
  await sendQueuedWasenderMessage(
    {
      sessionId: "session-1",
      to: customerPhone,
      type: "document",
      documentUrl: "https://example.test/receipt.pdf",
      caption: "Receipt"
    },
    dependencies
  );

  assert.deepEqual(calls[0], [
    "text",
    "session-1",
    customerPhone,
    "Hello",
    { apiKey: undefined }
  ]);
  assert.deepEqual(calls[1], [
    "document",
    "session-1",
    customerPhone,
    "https://example.test/receipt.pdf",
    "Receipt",
    { apiKey: undefined }
  ]);
});
