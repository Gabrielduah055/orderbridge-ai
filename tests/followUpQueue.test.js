const assert = require("node:assert/strict");
const test = require("node:test");

const { CustomerSession } = require("../dist/models/customerSession.model");
const { OutboundMessage } = require("../dist/models/outboundMessage.model");
const {
  buildCustomerFollowUpQueueMetadata
} = require("../dist/services/followUp.service");
const {
  processNextQueuedWasenderMessage
} = require("../dist/services/wasenderQueue.service");

const restaurantId = "64b000000000000000000801";
const customerPhone = "+233557038547";

const resolvedQuery = (value) => ({
  sort() {
    return this;
  },
  select() {
    return Promise.resolve(value);
  }
});

const processReminder = async ({ metadata, session }) => {
  const originalOutboundFindOne = OutboundMessage.findOne;
  const originalOutboundFindOneAndUpdate = OutboundMessage.findOneAndUpdate;
  const originalSessionFindOne = CustomerSession.findOne;
  let savedCount = 0;
  let sendCount = 0;
  let sessionFilter;

  const candidate = {
    _id: "queue-message-1",
    sessionId: "wasender-session-1",
    nextAttemptAt: new Date(0)
  };
  const locked = {
    ...candidate,
    restaurantId,
    to: customerPhone,
    type: "text",
    text: "Are you still there?",
    status: "sending",
    attempts: 1,
    maxAttempts: 5,
    metadata,
    async save() {
      savedCount += 1;
      return this;
    }
  };

  try {
    OutboundMessage.findOne = (filter) =>
      resolvedQuery(filter.status === "pending" ? candidate : null);
    OutboundMessage.findOneAndUpdate = () => resolvedQuery(locked);
    CustomerSession.findOne = (filter) => {
      sessionFilter = filter;
      return resolvedQuery(session);
    };

    const processed = await processNextQueuedWasenderMessage({
      sendMessage: async () => {
        sendCount += 1;
        return {
          success: true,
          status: 200,
          data: { id: "provider-message-1" }
        };
      }
    });

    return {
      locked,
      processed,
      savedCount,
      sendCount,
      sessionFilter
    };
  } finally {
    OutboundMessage.findOne = originalOutboundFindOne;
    OutboundMessage.findOneAndUpdate = originalOutboundFindOneAndUpdate;
    CustomerSession.findOne = originalSessionFindOne;
  }
};

test("follow-up queue metadata captures the restaurant-scoped draft snapshot", () => {
  const metadata = buildCustomerFollowUpQueueMetadata(
    {
      _id: "customer-session-1",
      restaurantId,
      customerPhone,
      conversationVersion: 4,
      currentStep: "collecting_quantity"
    },
    "collecting_quantity:4"
  );

  assert.deepEqual(metadata, {
    kind: "customer_follow_up",
    sessionId: "customer-session-1",
    restaurantId,
    customerPhone,
    conversationVersion: 4,
    expectedDraftStep: "collecting_quantity",
    followUpKey: "collecting_quantity:4"
  });
});

test("outdated follow-ups are cancelled after a reply or draft-step change", async () => {
  const metadata = {
    kind: "customer_follow_up",
    restaurantId,
    customerPhone,
    conversationVersion: 4,
    expectedDraftStep: "collecting_quantity"
  };
  const staleSessions = [
    {
      conversationVersion: 5,
      currentStep: "collecting_quantity"
    },
    {
      conversationVersion: 4,
      currentStep: "choosing_order_type"
    },
    {
      conversationVersion: 4,
      currentStep: "idle"
    }
  ];

  for (const session of staleSessions) {
    const result = await processReminder({ metadata, session });

    assert.equal(result.processed, true);
    assert.equal(result.locked.status, "cancelled");
    assert.equal(result.sendCount, 0);
    assert.equal(result.savedCount, 1);
    assert.deepEqual(result.sessionFilter, {
      restaurantId,
      customerPhone
    });
  }
});

test("a follow-up is cancelled when its scoped customer session no longer exists", async () => {
  const result = await processReminder({
    metadata: {
      kind: "customer_follow_up",
      restaurantId,
      customerPhone,
      conversationVersion: 4,
      expectedDraftStep: "collecting_quantity"
    },
    session: null
  });

  assert.equal(result.processed, true);
  assert.equal(result.locked.status, "cancelled");
  assert.equal(result.sendCount, 0);
  assert.equal(result.savedCount, 1);
  assert.deepEqual(result.sessionFilter, {
    restaurantId,
    customerPhone
  });
});

test("a current follow-up is still sent", async () => {
  const result = await processReminder({
    metadata: {
      kind: "customer_follow_up",
      restaurantId,
      customerPhone,
      conversationVersion: 4,
      expectedDraftStep: "collecting_quantity"
    },
    session: {
      conversationVersion: 4,
      currentStep: "collecting_quantity"
    }
  });

  assert.equal(result.processed, true);
  assert.equal(result.sendCount, 1);
  assert.equal(result.locked.status, "sent");
  assert.equal(result.locked.sentAt instanceof Date, true);
  assert.equal(result.savedCount, 1);
  assert.deepEqual(result.sessionFilter, {
    restaurantId,
    customerPhone
  });
});
