const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { executeAgentTool } = require("../dist/agent-tools/tool.executor");
const { CustomerSession } = require("../dist/models/customerSession.model");
const { Order } = require("../dist/models/order.model");
const { OutboundMessage } = require("../dist/models/outboundMessage.model");
const { Restaurant } = require("../dist/models/Restaurant");
const {
  createRestaurantSchema,
  updateRestaurantSchema
} = require("../dist/middleware/validateRequest");
const { runFollowUpPass } = require("../dist/services/followUp.service");
const {
  DEFAULT_DELIVERY_CHECK_IN_DELAY_MINUTES,
  DEFAULT_PICKUP_CHECK_IN_DELAY_MINUTES,
  getOrderAutoCompleteDelayMs,
  getOrderCheckInDelayMinutes,
  getOrderFeedbackReminderDelayMs,
  scheduleOrderFeedbackFollowUp
} = require("../dist/services/orderFeedbackQueue.service");

const restaurantId = "64b000000000000000000d01";
const orderId = "64b000000000000000000d11";
const customerPhone = "+233557038547";
const now = new Date("2026-08-09T12:00:00.000Z");

const query = (value) => ({
  sort() {
    return this;
  },
  limit() {
    return this;
  },
  select() {
    return Promise.resolve(value);
  },
  then(resolve, reject) {
    return Promise.resolve(value).then(resolve, reject);
  }
});

const makeRestaurant = (overrides = {}) => ({
  _id: restaurantId,
  name: "Golden Spoon",
  status: "active",
  ownerPhone: "+233500000001",
  managerPhones: [],
  managerContacts: [],
  wasenderSessionId: "session-1",
  wasenderApiToken: "restaurant-token",
  orderCheckInEnabled: true,
  pickupCheckInDelayMinutes: 45,
  deliveryCheckInDelayMinutes: 75,
  ...overrides
});

const makeAcceptedOrder = (overrides = {}) => ({
  _id: orderId,
  restaurantId,
  orderNumber: "ORD-123",
  customerName: "Ruth",
  customerPhone,
  orderType: "pickup",
  status: "accepted",
  feedbackFollowUpStatus: "not_scheduled",
  feedbackFollowUpVersion: 0,
  customerConfirmedNotificationSentAt: now,
  ...overrides
});

test("start_order moves only an idle draft into choosing_items", async () => {
  const originalFindOne = CustomerSession.findOne;
  const idleDraft = {
    restaurantId,
    customerPhone,
    customerName: "Ruth",
    cartItems: [],
    currentStep: "idle",
    orderType: null,
    deliveryFeeResolved: false,
    conversationVersion: 1,
    expiresAt: new Date(Date.now() + 60_000),
    saves: 0,
    async save() {
      this.saves += 1;
      return this;
    }
  };

  try {
    CustomerSession.findOne = async () => idleDraft;
    const result = await executeAgentTool(
      "start_order",
      {},
      {
        restaurantId,
        restaurant: makeRestaurant(),
        sender: {
          role: "customer",
          phone: customerPhone,
          normalizedPhone: customerPhone,
          verified: false
        },
        originalMessage: "I want to order"
      }
    );

    assert.equal(result.success, true);
    assert.equal(idleDraft.currentStep, "choosing_items");
    assert.equal(idleDraft.saves >= 2, true);
  } finally {
    CustomerSession.findOne = originalFindOne;
  }
});

test("start_order preserves a more specific trusted draft step", async () => {
  const originalFindOne = CustomerSession.findOne;
  const draft = {
    restaurantId,
    customerPhone,
    cartItems: [],
    currentStep: "collecting_quantity",
    orderType: null,
    deliveryFeeResolved: false,
    conversationVersion: 1,
    expiresAt: new Date(Date.now() + 60_000),
    async save() {
      return this;
    }
  };

  try {
    CustomerSession.findOne = async () => draft;
    await executeAgentTool("start_order", {}, {
      restaurantId,
      restaurant: makeRestaurant(),
      sender: {
        role: "customer",
        phone: customerPhone,
        normalizedPhone: customerPhone,
        verified: false
      }
    });
    assert.equal(draft.currentStep, "collecting_quantity");
  } finally {
    CustomerSession.findOne = originalFindOne;
  }
});

test("choosing_items is eligible once and keeps cart-aware follow-up wording", async () => {
  const originals = {
    restaurantFind: Restaurant.find,
    sessionFind: CustomerSession.find,
    outboundFindOne: OutboundMessage.findOne,
    outboundCreate: OutboundMessage.create
  };
  const queued = [];
  const session = {
    _id: "64b000000000000000000d21",
    restaurantId,
    customerPhone,
    cartItems: [{ name: "Chicken Salad" }],
    currentStep: "choosing_items",
    conversationVersion: 4,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    async save() {
      return this;
    }
  };

  try {
    Restaurant.find = () => query([makeRestaurant({ followUpDelayMinutes: 3 })]);
    CustomerSession.find = (filter) => {
      assert.equal(filter.currentStep.$in.includes("choosing_items"), true);
      return query([session]);
    };
    OutboundMessage.findOne = () => query(null);
    OutboundMessage.create = async (input) => {
      queued.push(input);
      return { _id: "follow-up-1", ...input };
    };

    const first = await runFollowUpPass();
    const second = await runFollowUpPass();

    assert.equal(first.messagesQueued, 1);
    assert.equal(second.messagesQueued, 0);
    assert.equal(queued.length, 1);
    assert.match(queued[0].text, /add another item or continue/i);
    assert.equal(queued[0].metadata.expectedDraftStep, "choosing_items");
  } finally {
    Restaurant.find = originals.restaurantFind;
    CustomerSession.find = originals.sessionFind;
    OutboundMessage.findOne = originals.outboundFindOne;
    OutboundMessage.create = originals.outboundCreate;
  }
});

test("pickup and delivery check-in defaults are distinct", () => {
  const original = process.env.ORDER_FEEDBACK_DELAY_MINUTES;
  const legacyRestaurant = {
    pickupCheckInDelayMinutes: undefined,
    deliveryCheckInDelayMinutes: undefined
  };

  try {
    delete process.env.ORDER_FEEDBACK_DELAY_MINUTES;
    assert.equal(
      getOrderCheckInDelayMinutes(legacyRestaurant, "pickup"),
      DEFAULT_PICKUP_CHECK_IN_DELAY_MINUTES
    );
    assert.equal(
      getOrderCheckInDelayMinutes(legacyRestaurant, "delivery"),
      DEFAULT_DELIVERY_CHECK_IN_DELAY_MINUTES
    );
  } finally {
    if (original === undefined) delete process.env.ORDER_FEEDBACK_DELAY_MINUTES;
    else process.env.ORDER_FEEDBACK_DELAY_MINUTES = original;
  }
});

test("restaurant admin validation persists reusable check-in settings", () => {
  const created = createRestaurantSchema.parse({
    name: "Golden Spoon",
    ownerPhone: customerPhone,
    wasenderSessionId: "session-1",
    whatsappNumber: "+233500000001",
    orderCheckInEnabled: true,
    pickupCheckInDelayMinutes: 3,
    deliveryCheckInDelayMinutes: 5
  });
  const updated = updateRestaurantSchema.parse({
    pickupCheckInDelayMinutes: 45,
    deliveryCheckInDelayMinutes: 75
  });

  assert.equal(created.followUpDelayMinutes, 3);
  assert.equal(created.pickupCheckInDelayMinutes, 3);
  assert.equal(created.deliveryCheckInDelayMinutes, 5);
  assert.deepEqual(updated, {
    pickupCheckInDelayMinutes: 45,
    deliveryCheckInDelayMinutes: 75
  });
});

test("pilot minute overrides take precedence without changing production defaults", () => {
  const originalReminderMinutes = process.env.ORDER_FEEDBACK_REMINDER_MINUTES;
  const originalAutoCompleteMinutes = process.env.ORDER_AUTO_COMPLETE_MINUTES;

  try {
    process.env.ORDER_FEEDBACK_REMINDER_MINUTES = "10";
    process.env.ORDER_AUTO_COMPLETE_MINUTES = "30";
    assert.equal(getOrderFeedbackReminderDelayMs(), 10 * 60_000);
    assert.equal(getOrderAutoCompleteDelayMs(), 30 * 60_000);
  } finally {
    if (originalReminderMinutes === undefined) {
      delete process.env.ORDER_FEEDBACK_REMINDER_MINUTES;
    } else {
      process.env.ORDER_FEEDBACK_REMINDER_MINUTES = originalReminderMinutes;
    }
    if (originalAutoCompleteMinutes === undefined) {
      delete process.env.ORDER_AUTO_COMPLETE_MINUTES;
    } else {
      process.env.ORDER_AUTO_COMPLETE_MINUTES = originalAutoCompleteMinutes;
    }
  }
});

for (const scenario of [
  { orderType: "pickup", pickupCheckInDelayMinutes: 3, expectedMinutes: 3 },
  { orderType: "delivery", deliveryCheckInDelayMinutes: 5, expectedMinutes: 5 }
]) {
  test(`accepted ${scenario.orderType} uses its restaurant check-in delay`, async () => {
    const originalRestaurantFindOne = Restaurant.findOne;
    const originalOrderFindOne = Order.findOne;
    const originalOrderUpdateOne = Order.updateOne;
    let queued;

    try {
      Restaurant.findOne = () => query(makeRestaurant(scenario));
      Order.findOne = () => query(makeAcceptedOrder({ orderType: scenario.orderType }));
      Order.updateOne = async () => ({ modifiedCount: 1 });

      const result = await scheduleOrderFeedbackFollowUp(
        restaurantId,
        orderId,
        {
          enqueueMessage: async (input) => {
            queued = input;
            return { _id: "check-in-1" };
          }
        },
        now
      );

      assert.equal(result.scheduled, true);
      assert.equal(
        queued.nextAttemptAt.toISOString(),
        new Date(now.getTime() + scenario.expectedMinutes * 60_000).toISOString()
      );
      assert.doesNotMatch(queued.text, /proof of delivery|hope you received/i);
    } finally {
      Restaurant.findOne = originalRestaurantFindOne;
      Order.findOne = originalOrderFindOne;
      Order.updateOne = originalOrderUpdateOne;
    }
  });
}

test("disabled restaurant check-ins do not queue an accepted-order message", async () => {
  const originalRestaurantFindOne = Restaurant.findOne;
  const originalOrderFindOne = Order.findOne;
  let enqueued = 0;

  try {
    Restaurant.findOne = () => query(makeRestaurant({ orderCheckInEnabled: false }));
    Order.findOne = () => query(makeAcceptedOrder());
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
    assert.equal(result.reason, "order_check_in_disabled");
    assert.equal(enqueued, 0);
  } finally {
    Restaurant.findOne = originalRestaurantFindOne;
    Order.findOne = originalOrderFindOne;
  }
});

test("the receipt timestamp is only a legacy scheduling anchor, never completion evidence", async () => {
  const originalRestaurantFindOne = Restaurant.findOne;
  const originalOrderFindOne = Order.findOne;
  const originalOrderUpdateOne = Order.updateOne;
  const order = makeAcceptedOrder({
    customerConfirmedNotificationSentAt: undefined,
    receiptSentAt: now,
    status: "accepted"
  });

  try {
    Restaurant.findOne = () => query(makeRestaurant());
    Order.findOne = () => query(order);
    Order.updateOne = async () => ({ modifiedCount: 1 });
    await scheduleOrderFeedbackFollowUp(
      restaurantId,
      orderId,
      { enqueueMessage: async () => ({ _id: "legacy-anchor-check-in" }) },
      now
    );

    assert.equal(order.status, "accepted");
    assert.equal(order.completedAt, undefined);
    assert.equal(order.completionConfirmedByCustomer, undefined);
  } finally {
    Restaurant.findOne = originalRestaurantFindOne;
    Order.findOne = originalOrderFindOne;
    Order.updateOne = originalOrderUpdateOne;
  }
});

test("the legacy post-delivery auto-completion scheduler is retired", () => {
  const sourceRoot = path.join(__dirname, "..", "src");
  const retiredService = path.join(
    sourceRoot,
    "services",
    "postDeliveryFollowUp.service.ts"
  );
  const serverSource = fs.readFileSync(path.join(sourceRoot, "server.ts"), "utf8");

  assert.equal(fs.existsSync(retiredService), false);
  assert.doesNotMatch(serverSource, /PostDeliveryFollowUp|postDeliveryFollowUp/);
});
