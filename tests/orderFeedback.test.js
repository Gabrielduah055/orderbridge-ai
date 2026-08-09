const assert = require("node:assert/strict");
const test = require("node:test");

const { PendingAgentAction } = require("../dist/models/pendingAgentAction.model");
const { OrderFeedback } = require("../dist/models/orderFeedback.model");
const { Order } = require("../dist/models/order.model");
const { OutboundMessage } = require("../dist/models/outboundMessage.model");
const { Restaurant } = require("../dist/models/Restaurant");
const {
  executeAgentTool
} = require("../dist/agent-tools/tool.executor");
const {
  isToolAllowedForRole
} = require("../dist/agent-tools/tool.permissions");
const {
  completeOrderThroughFeedback
} = require("../dist/services/orderCompletion.service");
const {
  buildOwnerFeedbackNotification,
  classifyDeterministicOrderFeedback,
  handleOrderFeedbackCustomerResponse,
  listCustomerFeedback,
  resolveCustomerFeedback
} = require("../dist/services/orderFeedback.service");
const {
  applyOrderFeedbackProviderResult,
  buildOrderFeedbackQueueMetadata,
  buildOrderFeedbackRequestMessage,
  getOrderCheckInDelayMinutes,
  getQueuedOrderFeedbackStaleReason,
  scheduleOrderFeedbackFollowUp
} = require("../dist/services/orderFeedbackQueue.service");
const {
  ORDER_FEEDBACK_BATCH_SIZE,
  ORDER_FEEDBACK_MAX_MESSAGES_PER_PASS,
  queueOrderFeedbackReminder,
  runOrderFeedbackSchedulerPass
} = require("../dist/services/orderFeedbackScheduler.service");
const {
  recoverStaleSendingWasenderMessages,
  updateOrderSideEffectAfterSend
} = require("../dist/services/wasenderQueue.service");

const restaurantId = "64b000000000000000000f01";
const otherRestaurantId = "64b000000000000000000f02";
const orderId = "64b000000000000000000f11";
const feedbackId = "64b000000000000000000f21";
const customerPhone = "+233557038547";
const now = new Date("2026-08-01T12:00:00.000Z");

const query = (value) => ({
  sort() {
    return this;
  },
  limit() {
    return this;
  },
  select() {
    return this;
  },
  then(resolve, reject) {
    return Promise.resolve(value).then(resolve, reject);
  }
});

const makeRestaurant = (overrides = {}) => ({
  _id: restaurantId,
  name: "Golden Spoon",
  status: "active",
  ownerName: "Owner",
  ownerPhone: "+233500000001",
  managerPhones: [],
  managerContacts: [],
  wasenderSessionId: "wasender-session-1",
  wasenderApiToken: "restaurant-api-key",
  ...overrides
});

const makeOrder = (overrides = {}) => ({
  _id: orderId,
  restaurantId,
  orderNumber: "ORD-123",
  customerName: "Mavis",
  customerPhone,
  items: [],
  subtotal: 45,
  total: 45,
  orderType: "delivery",
  paymentMethod: "cash",
  paymentStatus: "unpaid",
  status: "accepted",
  feedbackFollowUpStatus: "requested",
  feedbackFollowUpVersion: 1,
  feedbackRequestSentAt: new Date("2026-08-01T10:00:00.000Z"),
  createdAt: new Date("2026-08-01T08:00:00.000Z"),
  updatedAt: new Date("2026-08-01T10:00:00.000Z"),
  ...overrides
});

const makeFeedback = (overrides = {}) => ({
  _id: feedbackId,
  restaurantId,
  orderId,
  orderNumber: "ORD-123",
  customerPhone,
  customerName: "Mavis",
  type: "complaint",
  message: "The delivery was late.",
  sentiment: "negative",
  requiresOwnerAttention: true,
  createdAt: now,
  updatedAt: now,
  async save() {
    return this;
  },
  ...overrides
});

test("feedback request text identifies the restaurant and order without marketing language", () => {
  const message = buildOrderFeedbackRequestMessage(
    makeRestaurant(),
    makeOrder()
  );

  assert.match(message, /Golden Spoon/);
  assert.match(message, /ORD-123/);
  assert.match(message, /1\. Received and satisfied/);
  assert.doesNotMatch(message, /hope you received|proof of delivery/i);
  assert.equal(/offer|promotion|subscribe|marketing/i.test(message), false);
});

test("feedback queue metadata is fully scoped and explicitly transactional", () => {
  assert.deepEqual(
    buildOrderFeedbackQueueMetadata(makeOrder(), "order_feedback_request", 1),
    {
      kind: "order_feedback_request",
      restaurantId,
      orderId,
      orderNumber: "ORD-123",
      customerPhone,
      followUpVersion: 1,
      purpose: "transactional"
    }
  );
});

test("deterministic classification recognizes positive food feedback as received", () => {
  assert.deepEqual(
    classifyDeterministicOrderFeedback("The food was very nice."),
    {
      type: "review",
      sentiment: "positive",
      rating: undefined,
      requiresOwnerAttention: false,
      receiptStatus: "received",
      summary: "The food was very nice."
    }
  );
});

test("deterministic classification recognizes non-delivery without completing", () => {
  const classification = classifyDeterministicOrderFeedback(
    "My order has not arrived."
  );

  assert.equal(classification.type, "delivery_not_received");
  assert.equal(classification.receiptStatus, "not_received");
  assert.equal(classification.requiresOwnerAttention, true);
});

test("deterministic classification keeps system feedback receipt status unclear", () => {
  const classification = classifyDeterministicOrderFeedback(
    "The agent was too slow."
  );

  assert.equal(classification.type, "system_feedback");
  assert.equal(classification.receiptStatus, "unclear");
});

test("a bare wish to complain is left for one short receipt clarification", () => {
  assert.equal(
    classifyDeterministicOrderFeedback("I want to complain."),
    null
  );
});

test("follow-up scheduling requires a successful acceptance or receipt send", async () => {
  const originalRestaurantFindOne = Restaurant.findOne;
  const originalOrderFindOne = Order.findOne;
  const originalOrderUpdateOne = Order.updateOne;
  let enqueued = 0;

  try {
    Restaurant.findOne = () => query(makeRestaurant());
    Order.findOne = () => query(makeOrder({
      feedbackFollowUpStatus: "not_scheduled",
      feedbackFollowUpVersion: 0,
      feedbackRequestSentAt: undefined,
      customerConfirmedNotificationSentAt: undefined,
      receiptSentAt: undefined
    }));
    Order.updateOne = async () => ({ modifiedCount: 1 });

    const result = await scheduleOrderFeedbackFollowUp(
      restaurantId,
      orderId,
      {
        enqueueMessage: async () => {
          enqueued += 1;
          return { _id: "queue-1" };
        }
      },
      now
    );

    assert.equal(result.scheduled, false);
    assert.equal(result.reason, "acceptance_message_not_sent");
    assert.equal(enqueued, 0);
  } finally {
    Restaurant.findOne = originalRestaurantFindOne;
    Order.findOne = originalOrderFindOne;
    Order.updateOne = originalOrderUpdateOne;
  }
});

test("accepted provider success schedules exactly one delayed transactional request", async () => {
  const originalRestaurantFindOne = Restaurant.findOne;
  const originalOrderFindOne = Order.findOne;
  const originalOrderUpdateOne = Order.updateOne;
  const originalOutboundFindOne = OutboundMessage.findOne;
  const originalOutboundCreate = OutboundMessage.create;
  const order = makeOrder({
    feedbackFollowUpStatus: "not_scheduled",
    feedbackFollowUpVersion: 0,
    feedbackRequestSentAt: undefined,
    customerConfirmedNotificationSentAt: undefined
  });
  let created;

  try {
    Restaurant.findOne = () => query(makeRestaurant());
    Order.findOne = () => query(order);
    Order.updateOne = async (_filter, update) => {
      if (update.$set) {
        Object.assign(order, update.$set);
      }
      return { modifiedCount: 1 };
    };
    OutboundMessage.findOne = () => query(null);
    OutboundMessage.create = async (input) => {
      created = { _id: "queue-feedback-1", ...input };
      return created;
    };

    await updateOrderSideEffectAfterSend(
      {
        _id: "queue-acceptance-1",
        restaurantId,
        metadata: {
          kind: "customer_order_confirmed_notification",
          orderId
        }
      },
      { success: true, status: 200, data: { id: "provider-1" } }
    );

    assert.ok(order.customerConfirmedNotificationSentAt instanceof Date);
    assert.equal(created.idempotencyKey, `order-feedback-follow-up:${orderId}:v1`);
    assert.equal(created.metadata.purpose, "transactional");
    assert.equal(created.metadata.restaurantId, restaurantId);
    assert.equal(created.metadata.orderId, orderId);
    assert.ok(created.nextAttemptAt.getTime() > Date.now());
    assert.equal(order.feedbackFollowUpStatus, "scheduled");
  } finally {
    Restaurant.findOne = originalRestaurantFindOne;
    Order.findOne = originalOrderFindOne;
    Order.updateOne = originalOrderUpdateOne;
    OutboundMessage.findOne = originalOutboundFindOne;
    OutboundMessage.create = originalOutboundCreate;
  }
});

test("queueing or failing an acceptance message never schedules feedback", async () => {
  const originalOrderUpdateOne = Order.updateOne;
  const originalOutboundCreate = OutboundMessage.create;
  let created = 0;

  try {
    Order.updateOne = async () => ({ modifiedCount: 1 });
    OutboundMessage.create = async () => {
      created += 1;
    };

    await updateOrderSideEffectAfterSend(
      {
        _id: "queue-acceptance-2",
        restaurantId,
        metadata: {
          kind: "customer_order_confirmed_notification",
          orderId
        }
      },
      { success: false, status: 500, error: "provider failed" }
    );

    assert.equal(created, 0);
  } finally {
    Order.updateOne = originalOrderUpdateOne;
    OutboundMessage.create = originalOutboundCreate;
  }
});

test("rejected, cancelled, and expired orders never schedule feedback", async () => {
  const originalRestaurantFindOne = Restaurant.findOne;
  const originalOrderFindOne = Order.findOne;
  let enqueued = 0;

  try {
    Restaurant.findOne = () => query(makeRestaurant());

    for (const status of ["rejected", "cancelled", "expired"]) {
      Order.findOne = () => query(makeOrder({
        status,
        feedbackFollowUpStatus: "not_scheduled",
        customerConfirmedNotificationSentAt: now
      }));
      const result = await scheduleOrderFeedbackFollowUp(
        restaurantId,
        orderId,
        {
          enqueueMessage: async () => {
            enqueued += 1;
            return {};
          }
        },
        now
      );

      assert.equal(result.scheduled, false);
      assert.equal(result.reason, `order_${status}`);
    }

    assert.equal(enqueued, 0);
  } finally {
    Restaurant.findOne = originalRestaurantFindOne;
    Order.findOne = originalOrderFindOne;
  }
});

test("duplicate provider callbacks reuse the same scheduling key", async () => {
  const originalRestaurantFindOne = Restaurant.findOne;
  const originalOrderFindOne = Order.findOne;
  const originalOrderUpdateOne = Order.updateOne;
  const keys = new Set();
  let created = 0;
  const order = makeOrder({
    feedbackFollowUpStatus: "not_scheduled",
    feedbackFollowUpVersion: 0,
    customerConfirmedNotificationSentAt: now
  });

  try {
    Restaurant.findOne = () => query(makeRestaurant());
    Order.findOne = () => query(order);
    Order.updateOne = async (_filter, update) => {
      Object.assign(order, update.$set || {});
      return { modifiedCount: 1 };
    };
    const enqueueMessage = async (input) => {
      if (!keys.has(input.idempotencyKey)) {
        keys.add(input.idempotencyKey);
        created += 1;
      }
      return { _id: "same-queue-record" };
    };

    await scheduleOrderFeedbackFollowUp(
      restaurantId,
      orderId,
      { enqueueMessage },
      now
    );
    await scheduleOrderFeedbackFollowUp(
      restaurantId,
      orderId,
      { enqueueMessage },
      now
    );

    assert.equal(created, 1);
    assert.deepEqual([...keys], [`order-feedback-follow-up:${orderId}:v1`]);
  } finally {
    Restaurant.findOne = originalRestaurantFindOne;
    Order.findOne = originalOrderFindOne;
    Order.updateOne = originalOrderUpdateOne;
  }
});

test("interrupted queue attempts are recovered safely after restart", async () => {
  const originalUpdateMany = OutboundMessage.updateMany;
  let filter;
  let update;

  try {
    OutboundMessage.updateMany = async (capturedFilter, capturedUpdate) => {
      filter = capturedFilter;
      update = capturedUpdate;
      return { modifiedCount: 2 };
    };
    const recovered = await recoverStaleSendingWasenderMessages(now);

    assert.equal(recovered, 2);
    assert.equal(filter.status, "sending");
    assert.ok(filter.lastAttemptAt.$lte < now);
    assert.equal(update.$set.status, "pending");
    assert.equal(update.$set.nextAttemptAt, now);
  } finally {
    OutboundMessage.updateMany = originalUpdateMany;
  }
});

test("stale validation is tenant-scoped and does not consult marketing opt-out state", async () => {
  const originalRestaurantFindOne = Restaurant.findOne;
  const originalOrderFindOne = Order.findOne;
  const originalFeedbackExists = OrderFeedback.exists;
  let restaurantFilter;
  let orderFilter;
  let feedbackFilter;

  try {
    Restaurant.findOne = (filter) => {
      restaurantFilter = filter;
      return query(makeRestaurant());
    };
    Order.findOne = (filter) => {
      orderFilter = filter;
      return query(makeOrder({
        feedbackFollowUpStatus: "scheduled",
        feedbackRequestSentAt: undefined
      }));
    };
    OrderFeedback.exists = async (filter) => {
      feedbackFilter = filter;
      return null;
    };

    const staleReason = await getQueuedOrderFeedbackStaleReason({
      restaurantId,
      sessionId: "wasender-session-1",
      to: customerPhone,
      metadata: buildOrderFeedbackQueueMetadata(
        makeOrder(),
        "order_feedback_request",
        1
      )
    });

    assert.equal(staleReason, null);
    assert.equal(restaurantFilter._id, restaurantId);
    assert.equal(orderFilter.restaurantId, restaurantId);
    assert.equal(feedbackFilter.restaurantId, restaurantId);
    assert.equal(feedbackFilter.orderId, orderId);
  } finally {
    Restaurant.findOne = originalRestaurantFindOne;
    Order.findOne = originalOrderFindOne;
    OrderFeedback.exists = originalFeedbackExists;
  }
});

test("completed and issue-reported orders cancel stale feedback requests", async () => {
  const originalRestaurantFindOne = Restaurant.findOne;
  const originalOrderFindOne = Order.findOne;
  const originalFeedbackExists = OrderFeedback.exists;

  try {
    Restaurant.findOne = () => query(makeRestaurant());
    OrderFeedback.exists = async () => null;

    for (const [order, expected] of [
      [makeOrder({ status: "completed" }), "order_completed"],
      [makeOrder({ feedbackFollowUpStatus: "issue_reported" }), "delivery_issue_reported"]
    ]) {
      Order.findOne = () => query(order);
      const reason = await getQueuedOrderFeedbackStaleReason({
        restaurantId,
        sessionId: "wasender-session-1",
        to: customerPhone,
        metadata: buildOrderFeedbackQueueMetadata(
          makeOrder(),
          "order_feedback_request",
          1
        )
      });
      assert.equal(reason, expected);
    }
  } finally {
    Restaurant.findOne = originalRestaurantFindOne;
    Order.findOne = originalOrderFindOne;
    OrderFeedback.exists = originalFeedbackExists;
  }
});

test("controlled completion records customer confirmation and updates profile once", async () => {
  const originalOrderFindOne = Order.findOne;
  const originalOrderFindOneAndUpdate = Order.findOneAndUpdate;
  const originalOrderUpdateOne = Order.updateOne;
  let current = makeOrder();
  let profileUpdates = 0;
  let cancellations = 0;

  try {
    Order.findOne = () => Promise.resolve(current);
    Order.findOneAndUpdate = async () => {
      current = makeOrder({
        status: "completed",
        completedAt: now,
        completionSource: "customer_confirmed",
        completionConfirmedByCustomer: true,
        customerConfirmedReceiptAt: now,
        feedbackFollowUpStatus: "answered"
      });
      return current;
    };
    Order.updateOne = async () => ({ modifiedCount: 1 });
    const dependencies = {
      updateCustomerProfile: async () => {
        profileUpdates += 1;
        return null;
      },
      cancelQueuedMessages: async () => {
        cancellations += 1;
        return 1;
      }
    };

    const first = await completeOrderThroughFeedback(
      {
        restaurantId,
        orderId,
        completionSource: "customer_confirmed",
        completionConfirmedByCustomer: true,
        completedAt: now
      },
      dependencies
    );
    const second = await completeOrderThroughFeedback(
      {
        restaurantId,
        orderId,
        completionSource: "customer_confirmed",
        completionConfirmedByCustomer: true,
        completedAt: now
      },
      dependencies
    );

    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(first.order.completionSource, "customer_confirmed");
    assert.equal(first.order.completionConfirmedByCustomer, true);
    assert.equal(profileUpdates, 1);
    assert.equal(cancellations, 1);
  } finally {
    Order.findOne = originalOrderFindOne;
    Order.findOneAndUpdate = originalOrderFindOneAndUpdate;
    Order.updateOne = originalOrderUpdateOne;
  }
});

test("automatic timeout records unconfirmed completion", async () => {
  const originalOrderFindOne = Order.findOne;
  const originalOrderFindOneAndUpdate = Order.findOneAndUpdate;
  const originalOrderUpdateOne = Order.updateOne;
  const completed = makeOrder({
    status: "completed",
    completionSource: "automatic_timeout",
    completionConfirmedByCustomer: false,
    feedbackFollowUpStatus: "automatically_closed",
    completionProfileUpdatedAt: now
  });

  try {
    Order.findOne = () => Promise.resolve(makeOrder());
    Order.findOneAndUpdate = async () => completed;
    Order.updateOne = async () => ({ modifiedCount: 1 });
    const result = await completeOrderThroughFeedback(
      {
        restaurantId,
        orderId,
        completionSource: "automatic_timeout",
        completionConfirmedByCustomer: false,
        completedAt: now
      },
      {
        isRestaurantActive: async () => true,
        hasUnresolvedDeliveryNotReceived: async () => false,
        cancelQueuedMessages: async () => 1
      }
    );

    assert.equal(result.order.completionSource, "automatic_timeout");
    assert.equal(result.order.completionConfirmedByCustomer, false);
    assert.equal(result.order.feedbackFollowUpStatus, "automatically_closed");
  } finally {
    Order.findOne = originalOrderFindOne;
    Order.findOneAndUpdate = originalOrderFindOneAndUpdate;
    Order.updateOne = originalOrderUpdateOne;
  }
});

test("unresolved non-delivery blocks automatic completion", async () => {
  const originalOrderFindOne = Order.findOne;
  let transitions = 0;
  const originalOrderFindOneAndUpdate = Order.findOneAndUpdate;

  try {
    Order.findOne = () => Promise.resolve(makeOrder());
    Order.findOneAndUpdate = async () => {
      transitions += 1;
    };

    await assert.rejects(
      completeOrderThroughFeedback(
        {
          restaurantId,
          orderId,
          completionSource: "automatic_timeout",
          completionConfirmedByCustomer: false
        },
        {
          isRestaurantActive: async () => true,
          hasUnresolvedDeliveryNotReceived: async () => true
        }
      ),
      /blocked by an unresolved non-delivery report/
    );
    assert.equal(transitions, 0);
  } finally {
    Order.findOne = originalOrderFindOne;
    Order.findOneAndUpdate = originalOrderFindOneAndUpdate;
  }
});

test("inactive restaurants never auto-complete orders", async () => {
  const originalOrderFindOne = Order.findOne;
  const originalOrderFindOneAndUpdate = Order.findOneAndUpdate;
  let transitions = 0;

  try {
    Order.findOne = () => Promise.resolve(makeOrder());
    Order.findOneAndUpdate = async () => {
      transitions += 1;
    };

    await assert.rejects(
      completeOrderThroughFeedback(
        {
          restaurantId,
          orderId,
          completionSource: "automatic_timeout",
          completionConfirmedByCustomer: false
        },
        {
          isRestaurantActive: async () => false
        }
      ),
      /inactive restaurant/
    );
    assert.equal(transitions, 0);
  } finally {
    Order.findOne = originalOrderFindOne;
    Order.findOneAndUpdate = originalOrderFindOneAndUpdate;
  }
});

test("awaiting restaurant confirmation cannot be completed by the feedback feature", async () => {
  const originalOrderFindOne = Order.findOne;

  try {
    Order.findOne = () => Promise.resolve(makeOrder({
      status: "awaiting_restaurant_confirmation"
    }));

    await assert.rejects(
      completeOrderThroughFeedback({
        restaurantId,
        orderId,
        completionSource: "customer_confirmed",
        completionConfirmedByCustomer: true
      }),
      /cannot be completed from status awaiting_restaurant_confirmation/
    );
  } finally {
    Order.findOne = originalOrderFindOne;
  }
});

const withFeedbackResponseHarness = async (orders, run) => {
  const originals = {
    orderFind: Order.find,
    orderFindOne: Order.findOne,
    orderFindOneAndUpdate: Order.findOneAndUpdate,
    orderUpdateOne: Order.updateOne,
    outboundFindOne: OutboundMessage.findOne,
    outboundCreate: OutboundMessage.create,
    outboundUpdateMany: OutboundMessage.updateMany,
    restaurantFindOne: Restaurant.findOne,
    feedbackCreate: OrderFeedback.create,
    feedbackFindOne: OrderFeedback.findOne
  };
  let feedbackCreates = 0;
  let completionTransitions = 0;
  let outboundNotifications = 0;
  const currentById = new Map(orders.map((order) => [String(order._id), order]));
  const feedbackByInboundEvent = new Map();
  const outboundByIdempotencyKey = new Map();

  try {
    Order.find = () => query(orders);
    Order.findOne = (filter) => Promise.resolve(currentById.get(String(filter._id)) || null);
    Order.findOneAndUpdate = async (filter, update) => {
      const current = currentById.get(String(filter._id));

      if (!current) {
        return null;
      }

      completionTransitions += 1;
      const completed = {
        ...current,
        ...update.$set,
        completionProfileUpdatedAt: now
      };
      currentById.set(String(filter._id), completed);
      return completed;
    };
    Order.updateOne = async (filter, update) => {
      const current = currentById.get(String(filter._id));
      if (current && update.$set) Object.assign(current, update.$set);
      return { modifiedCount: 1 };
    };
    OutboundMessage.findOne = (filter) =>
      query(outboundByIdempotencyKey.get(filter.idempotencyKey) ?? null);
    OutboundMessage.create = async (input) => {
      const existing = outboundByIdempotencyKey.get(input.idempotencyKey);
      if (existing) return existing;
      outboundNotifications += 1;
      const created = { _id: `outbound-${outboundNotifications}`, ...input };
      outboundByIdempotencyKey.set(input.idempotencyKey, created);
      return created;
    };
    OutboundMessage.updateMany = async () => ({ modifiedCount: 1 });
    Restaurant.findOne = () => query(makeRestaurant());
    OrderFeedback.create = async (input) => {
      if (
        input.inboundEventId &&
        feedbackByInboundEvent.has(input.inboundEventId)
      ) {
        const duplicateError = new Error("duplicate feedback event");
        duplicateError.code = 11000;
        throw duplicateError;
      }
      feedbackCreates += 1;
      const created = makeFeedback({
        _id: `64b000000000000000000f${30 + feedbackCreates}`,
        ...input
      });
      if (input.inboundEventId) {
        feedbackByInboundEvent.set(input.inboundEventId, created);
      }
      return created;
    };
    OrderFeedback.findOne = (filter) =>
      Promise.resolve(
        feedbackByInboundEvent.get(filter.inboundEventId) ?? null
      );

    return await run({
      get feedbackCreates() {
        return feedbackCreates;
      },
      get completionTransitions() {
        return completionTransitions;
      },
      get outboundNotifications() {
        return outboundNotifications;
      },
      currentById
    });
  } finally {
    Order.find = originals.orderFind;
    Order.findOne = originals.orderFindOne;
    Order.findOneAndUpdate = originals.orderFindOneAndUpdate;
    Order.updateOne = originals.orderUpdateOne;
    OutboundMessage.findOne = originals.outboundFindOne;
    OutboundMessage.create = originals.outboundCreate;
    OutboundMessage.updateMany = originals.outboundUpdateMany;
    Restaurant.findOne = originals.restaurantFindOne;
    OrderFeedback.create = originals.feedbackCreate;
    OrderFeedback.findOne = originals.feedbackFindOne;
  }
};

test("response 1 completes the exact active order without creating empty feedback", async () => {
  await withFeedbackResponseHarness([makeOrder()], async (harness) => {
    const result = await handleOrderFeedbackCustomerResponse({
      restaurantId,
      customerPhone,
      message: "1",
      inboundEventId: "event-response-1"
    });

    assert.equal(result.handled, true);
    assert.equal(result.order.status, "completed");
    assert.equal(result.order.completionSource, "customer_confirmed");
    assert.equal(result.order.completionConfirmedByCustomer, true);
    assert.equal(harness.feedbackCreates, 0);
    assert.equal(harness.completionTransitions, 1);
  });
});

test("response 2 completes the order, saves a complaint, and queues owner notification", async () => {
  await withFeedbackResponseHarness([makeOrder()], async (harness) => {
    const result = await handleOrderFeedbackCustomerResponse({
      restaurantId,
      customerPhone,
      message: "2 The delivery was late and the food was cold.",
      inboundEventId: "event-response-2"
    });

    assert.equal(result.order.status, "completed");
    assert.equal(result.order.completionSource, "customer_feedback");
    assert.equal(result.feedback.type, "complaint");
    assert.equal(result.feedback.requiresOwnerAttention, true);
    assert.equal(harness.feedbackCreates, 1);
    assert.equal(harness.outboundNotifications, 1);
  });
});

test("response 3 never completes and creates an urgent non-delivery record", async () => {
  await withFeedbackResponseHarness([makeOrder()], async (harness) => {
    const result = await handleOrderFeedbackCustomerResponse({
      restaurantId,
      customerPhone,
      message: "3",
      inboundEventId: "event-response-3"
    });

    assert.equal(harness.completionTransitions, 0);
    assert.equal(result.feedback.type, "delivery_not_received");
    assert.equal(result.feedback.requiresOwnerAttention, true);
    assert.equal(
      harness.currentById.get(orderId).feedbackFollowUpStatus,
      "issue_reported"
    );
    assert.equal(harness.outboundNotifications, 1);
  });
});

test("duplicate complaint webhook does not duplicate feedback or owner alert", async () => {
  await withFeedbackResponseHarness([makeOrder()], async (harness) => {
    const input = {
      restaurantId,
      customerPhone,
      message: "2 The chicken was cold.",
      inboundEventId: "event-duplicate-complaint"
    };

    await handleOrderFeedbackCustomerResponse(input);
    await handleOrderFeedbackCustomerResponse(input);

    assert.equal(harness.feedbackCreates, 1);
    assert.equal(harness.outboundNotifications, 1);
    assert.equal(harness.completionTransitions, 1);
  });
});

test("natural positive feedback completes and is stored as a review", async () => {
  await withFeedbackResponseHarness([makeOrder()], async (harness) => {
    const result = await handleOrderFeedbackCustomerResponse({
      restaurantId,
      customerPhone,
      message: "The food was very nice.",
      inboundEventId: "event-natural-positive"
    });

    assert.equal(result.order.status, "completed");
    assert.equal(result.feedback.type, "review");
    assert.equal(result.feedback.sentiment, "positive");
    assert.equal(harness.completionTransitions, 1);
    assert.equal(harness.outboundNotifications, 0);
  });
});

test("customer check-in tool delegates a natural complaint to the trusted feedback workflow", async () => {
  await withFeedbackResponseHarness([makeOrder()], async (harness) => {
    const result = await executeAgentTool(
      "respond_to_order_check_in",
      {
        outcome: "received_complaint",
        feedbackText: "I got it but the chicken was cold"
      },
      {
        restaurantId,
        restaurant: makeRestaurant(),
        sender: {
          role: "customer",
          phone: customerPhone,
          normalizedPhone: customerPhone,
          verified: false
        },
        originalMessage: "I got it but the chicken was cold",
        requestId: "event-tool-complaint"
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.data.outcome, "received_complaint");
    assert.equal(result.data.status, "completed");
    assert.equal(result.data.feedbackType, "complaint");
    assert.equal(harness.completionTransitions, 1);
    assert.equal(harness.outboundNotifications, 1);
  });
});

test("customer check-in tool never completes a not-received order", async () => {
  await withFeedbackResponseHarness([makeOrder()], async (harness) => {
    const result = await executeAgentTool(
      "respond_to_order_check_in",
      { outcome: "not_received" },
      {
        restaurantId,
        restaurant: makeRestaurant(),
        sender: {
          role: "customer",
          phone: customerPhone,
          normalizedPhone: customerPhone,
          verified: false
        },
        originalMessage: "I still haven't received it",
        requestId: "event-tool-not-received"
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.data.outcome, "not_received");
    assert.equal(result.data.feedbackType, "delivery_not_received");
    assert.equal(harness.completionTransitions, 0);
    assert.equal(harness.outboundNotifications, 1);
  });
});

test("natural non-delivery feedback never completes", async () => {
  await withFeedbackResponseHarness([makeOrder()], async (harness) => {
    const result = await handleOrderFeedbackCustomerResponse({
      restaurantId,
      customerPhone,
      message: "I have not received my food.",
      inboundEventId: "event-natural-missing"
    });

    assert.equal(result.feedback.type, "delivery_not_received");
    assert.equal(harness.completionTransitions, 0);
  });
});

test("ambiguous feedback asks for an order number instead of guessing", async () => {
  const secondOrder = makeOrder({
    _id: "64b000000000000000000f12",
    orderNumber: "ORD-456"
  });

  await withFeedbackResponseHarness(
    [makeOrder(), secondOrder],
    async (harness) => {
      const result = await handleOrderFeedbackCustomerResponse({
        restaurantId,
        customerPhone,
        message: "1",
        inboundEventId: "event-ambiguous"
      });

      assert.equal(result.handled, true);
      assert.equal(result.success, false);
      assert.match(result.message, /ORD-123/);
      assert.match(result.message, /ORD-456/);
      assert.equal(harness.completionTransitions, 0);
      assert.equal(harness.feedbackCreates, 0);
    }
  );
});

test("quoted order number selects the correct restaurant-scoped active order", async () => {
  const secondOrder = makeOrder({
    _id: "64b000000000000000000f12",
    orderNumber: "ORD-456"
  });

  await withFeedbackResponseHarness(
    [makeOrder(), secondOrder],
    async (harness) => {
      const result = await handleOrderFeedbackCustomerResponse({
        restaurantId,
        customerPhone,
        message: "ORD-456 1",
        inboundEventId: "event-exact-order"
      });

      assert.equal(result.order.orderNumber, "ORD-456");
      assert.equal(result.order.status, "completed");
      assert.equal(harness.currentById.get(orderId).status, "accepted");
    }
  );
});

test("scheduler is bounded and one order failure does not stop another", async () => {
  const candidates = Array.from(
    { length: ORDER_FEEDBACK_BATCH_SIZE + 10 },
    (_, index) => makeOrder({
      _id: `64b000000000000000000${String(100 + index).slice(-3)}`
    })
  );
  let calls = 0;
  const result = await runOrderFeedbackSchedulerPass(now, {
    loadRestaurants: async () => [makeRestaurant()],
    findSchedulingCandidates: async () => candidates,
    findReminderCandidates: async () => [],
    findAutoCompletionCandidates: async () => [],
    cancelStaleMessages: async () => 0,
    scheduleFollowUp: async () => {
      calls += 1;
      if (calls === 1) throw new Error("one bad order");
      return { scheduled: true };
    },
    enqueueMessage: async () => ({}),
    logError: () => {}
  });

  assert.equal(result.errors, 1);
  assert.equal(result.followUpsScheduled > 0, true);
  assert.equal(calls <= ORDER_FEEDBACK_MAX_MESSAGES_PER_PASS + 1, true);
  assert.equal(result.ordersChecked <= ORDER_FEEDBACK_BATCH_SIZE, true);
});

test("scheduler automatic close runs once and records an unconfirmed source", async () => {
  let completionCalls = 0;
  let completionInput;
  const result = await runOrderFeedbackSchedulerPass(now, {
    loadRestaurants: async () => [makeRestaurant()],
    findSchedulingCandidates: async () => [],
    findReminderCandidates: async () => [],
    findAutoCompletionCandidates: async () => [makeOrder()],
    cancelStaleMessages: async () => 0,
    completeOrder: async (input) => {
      completionCalls += 1;
      completionInput = input;
      return {
        order: makeOrder({ status: "completed" }),
        idempotent: false,
        customerProfileUpdated: true
      };
    }
  });

  assert.equal(completionCalls, 1);
  assert.equal(completionInput.completionSource, "automatic_timeout");
  assert.equal(completionInput.completionConfirmedByCustomer, false);
  assert.equal(result.ordersAutomaticallyCompleted, 1);
});

test("reminders are queued at most once for one follow-up version", async () => {
  const originalOrderFindOne = Order.findOne;
  const originalOutboundExists = OutboundMessage.exists;
  const keys = new Set();
  let enqueued = 0;
  const order = makeOrder({
    feedbackRequestSentAt: new Date("2026-07-31T20:00:00.000Z"),
    feedbackReminderSentAt: undefined
  });

  try {
    Order.findOne = () => Promise.resolve(order);
    OutboundMessage.exists = async ({ idempotencyKey }) =>
      keys.has(idempotencyKey) ? { _id: "existing-reminder" } : null;
    const enqueueMessage = async (input) => {
      enqueued += 1;
      keys.add(input.idempotencyKey);
      return { _id: "reminder-1" };
    };

    const first = await queueOrderFeedbackReminder(
      makeRestaurant(),
      order,
      enqueueMessage,
      now
    );
    const second = await queueOrderFeedbackReminder(
      makeRestaurant(),
      order,
      enqueueMessage,
      now
    );

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(enqueued, 1);
    assert.deepEqual([...keys], [`order-feedback-reminder:${orderId}:v1`]);
  } finally {
    Order.findOne = originalOrderFindOne;
    OutboundMessage.exists = originalOutboundExists;
  }
});

test("owner notification provider success and failure are recorded separately", async () => {
  const originalUpdateOne = OrderFeedback.updateOne;
  const updates = [];

  try {
    OrderFeedback.updateOne = async (filter, update) => {
      updates.push({ filter, update });
      return { modifiedCount: 1 };
    };
    const message = {
      restaurantId,
      sessionId: "wasender-session-1",
      to: "+233500000001",
      metadata: {
        kind: "order_feedback_owner_notification",
        restaurantId,
        feedbackId
      }
    };

    await applyOrderFeedbackProviderResult(
      message,
      { success: false, status: 500, error: "provider down" },
      now
    );
    await applyOrderFeedbackProviderResult(
      message,
      { success: true, status: 200 },
      now
    );

    assert.deepEqual(updates[0].filter, { _id: feedbackId, restaurantId });
    assert.equal(
      updates[0].update.$set.ownerNotificationFailureReason,
      "provider down"
    );
    assert.equal(updates[1].update.$set.ownerNotifiedAt, now);
    assert.ok(updates[1].update.$unset.ownerNotificationFailedAt !== undefined);
  } finally {
    OrderFeedback.updateOne = originalUpdateOne;
  }
});

test("owner feedback notification clearly distinguishes urgent complaints", () => {
  const message = buildOwnerFeedbackNotification(makeFeedback());

  assert.match(message, /ORD-123/);
  assert.match(message, /Mavis/);
  assert.match(message, /CUSTOMER COMPLAINT/);
});

test("feedback permissions allow only owner and manager access", () => {
  assert.equal(isToolAllowedForRole("list_customer_feedback", "owner"), true);
  assert.equal(isToolAllowedForRole("list_customer_feedback", "manager"), true);
  assert.equal(isToolAllowedForRole("list_customer_feedback", "customer"), false);
  assert.equal(isToolAllowedForRole("resolve_customer_feedback", "customer"), false);
  assert.equal(isToolAllowedForRole("respond_to_order_check_in", "customer"), true);
  assert.equal(isToolAllowedForRole("respond_to_order_check_in", "owner"), false);
});

test("feedback list query is tenant-scoped and capped at 20", async () => {
  const originalFind = OrderFeedback.find;
  let filter;
  let limit;

  try {
    OrderFeedback.find = (capturedFilter) => ({
      sort() {
        filter = capturedFilter;
        return this;
      },
      async limit(capturedLimit) {
        limit = capturedLimit;
        return [];
      }
    });
    await listCustomerFeedback(restaurantId, {
      type: "complaint",
      requiresAttention: true,
      limit: 100
    });

    assert.deepEqual(filter, {
      restaurantId,
      type: "complaint",
      requiresOwnerAttention: true
    });
    assert.equal(limit, 20);
  } finally {
    OrderFeedback.find = originalFind;
  }
});

test("feedback resolution is tenant-scoped, retained, and records the staff phone", async () => {
  const originalFindOne = OrderFeedback.findOne;
  let filter;
  let saves = 0;
  const feedback = makeFeedback({
    async save() {
      saves += 1;
      return this;
    }
  });

  try {
    OrderFeedback.findOne = async (capturedFilter) => {
      filter = capturedFilter;
      return feedback;
    };
    const result = await resolveCustomerFeedback(
      restaurantId,
      feedbackId,
      "0557038547"
    );

    assert.deepEqual(filter, { _id: feedbackId, restaurantId });
    assert.ok(result.feedback.resolvedAt instanceof Date);
    assert.equal(result.feedback.resolvedByPhone, customerPhone);
    assert.equal(saves, 1);
  } finally {
    OrderFeedback.findOne = originalFindOne;
  }
});

test("another restaurant cannot resolve a feedback record", async () => {
  const originalFindOne = OrderFeedback.findOne;
  let filter;

  try {
    OrderFeedback.findOne = async (capturedFilter) => {
      filter = capturedFilter;
      return null;
    };
    await assert.rejects(
      resolveCustomerFeedback(otherRestaurantId, feedbackId, customerPhone),
      /Customer feedback not found/
    );
    assert.equal(filter.restaurantId, otherRestaurantId);
  } finally {
    OrderFeedback.findOne = originalFindOne;
  }
});

test("complaint resolution is confirmation-gated in the owner tool", async () => {
  const originalFeedbackFindOne = OrderFeedback.findOne;
  const originalPendingUpdateMany = PendingAgentAction.updateMany;
  const originalPendingCreate = PendingAgentAction.create;
  let pending;
  const context = {
    restaurantId,
    restaurant: makeRestaurant(),
    sender: {
      name: "Owner",
      phone: "+233500000001",
      normalizedPhone: "+233500000001",
      role: "owner",
      verified: true
    }
  };

  try {
    OrderFeedback.findOne = async () => makeFeedback();
    PendingAgentAction.updateMany = async () => ({ modifiedCount: 0 });
    PendingAgentAction.create = async (input) => {
      pending = { _id: "pending-feedback-resolution", ...input };
      return pending;
    };
    const result = await executeAgentTool(
      "resolve_customer_feedback",
      { feedbackId },
      context
    );

    assert.equal(result.requiresConfirmation, true);
    assert.equal(pending.toolName, "resolve_customer_feedback");
    assert.deepEqual(pending.arguments, { feedbackId });
  } finally {
    OrderFeedback.findOne = originalFeedbackFindOne;
    PendingAgentAction.updateMany = originalPendingUpdateMany;
    PendingAgentAction.create = originalPendingCreate;
  }
});

test("customers are denied feedback tools before any database lookup", async () => {
  const originalFind = OrderFeedback.find;
  let queries = 0;

  try {
    OrderFeedback.find = () => {
      queries += 1;
      return query([]);
    };
    const result = await executeAgentTool(
      "list_customer_feedback",
      {},
      {
        restaurantId,
        restaurant: makeRestaurant(),
        sender: {
          phone: customerPhone,
          normalizedPhone: customerPhone,
          role: "customer",
          verified: false
        }
      }
    );

    assert.equal(result.code, "TOOL_FORBIDDEN");
    assert.equal(queries, 0);
  } finally {
    OrderFeedback.find = originalFind;
  }
});
