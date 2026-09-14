const assert = require("node:assert/strict");
const test = require("node:test");
const { Types } = require("mongoose");

const {
  resolveOperationalRecipients
} = require("../dist/services/operationalRecipient.service");
const orderService = require("../dist/services/order.service");
const { Order } = require("../dist/models/order.model");
const { OutboundMessage } = require("../dist/models/outboundMessage.model");
const { Restaurant } = require("../dist/models/Restaurant");
const { OrderFeedback } = require("../dist/models/orderFeedback.model");
const {
  findTrustedQuotedOwnerOrderContext
} = require("../dist/services/ownerOrderNotificationContext.service");
const ownerOrderResolution = require("../dist/services/ownerOrderResolution.service");
const {
  getAgentToolDefinitionsForRole,
  isToolAllowedForRole
} = require("../dist/agent-tools/tool.permissions");
const { toolRegistry } = require("../dist/agent-tools/tool.registry");

const restaurantId = "64b000000000000000000001";
const otherRestaurantId = "64b000000000000000000002";
const orderId = "64b000000000000000000104";
const feedbackId = "64b000000000000000000504";
const ownerPhone = "+233500000001";
const amaPhone = "+233500000002";
const kojoPhone = "+233500000003";

const makeRestaurant = (overrides = {}) => ({
  _id: new Types.ObjectId(restaurantId),
  name: "Golden Grill",
  ownerName: "Nana",
  ownerPhone,
  managerPhones: [amaPhone, kojoPhone],
  managerContacts: [
    { name: "Ama", phone: "0500000002" },
    { name: "Kojo", phone: kojoPhone }
  ],
  wasenderSessionId: "session-1",
  wasenderApiToken: "token-1",
  ...overrides
});

const makeOrder = (overrides = {}) => ({
  _id: new Types.ObjectId(orderId),
  restaurantId: new Types.ObjectId(restaurantId),
  orderNumber: "ORD-104",
  customerName: "Esi",
  customerPhone: "+233500000099",
  items: [
    {
      menuItemId: new Types.ObjectId("64b000000000000000000301"),
      name: "Jollof Rice",
      quantity: 2,
      unitPrice: 30,
      totalPrice: 60
    }
  ],
  subtotal: 60,
  deliveryFee: 10,
  total: 70,
  orderType: "delivery",
  deliveryAddress: "Osu",
  status: "awaiting_restaurant_confirmation",
  paymentMethod: "cash",
  paymentStatus: "unpaid",
  feedbackFollowUpStatus: "not_scheduled",
  customerAmendmentVersion: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides
});

const restore = (target, key, value) => {
  target[key] = value;
};

test("operational recipient resolution prefers all valid unique managers and falls back to owner", () => {
  assert.deepEqual(resolveOperationalRecipients(makeRestaurant()), [
    { recipientType: "manager", recipientPhone: amaPhone, recipientName: "Ama" },
    { recipientType: "manager", recipientPhone: kojoPhone, recipientName: "Kojo" }
  ]);

  assert.deepEqual(
    resolveOperationalRecipients(
      makeRestaurant({
        managerPhones: ["", "invalid"],
        managerContacts: [{ name: "Invalid", phone: "" }]
      })
    ),
    [{ recipientType: "owner", recipientPhone: ownerPhone, recipientName: "Nana" }]
  );
});

test("two managers receive each operational order event once while the owner is excluded", async () => {
  const originals = {
    findOne: OutboundMessage.findOne,
    create: OutboundMessage.create
  };
  const byKey = new Map();
  const created = [];

  OutboundMessage.findOne = (filter) => ({
    select: async () => byKey.get(filter.idempotencyKey) ?? null
  });
  OutboundMessage.create = async (input) => {
    const message = { _id: `queued-${created.length + 1}`, ...input };
    byKey.set(input.idempotencyKey, message);
    created.push(input);
    return message;
  };

  try {
    const sideEffects = require("../dist/services/orderSideEffects.service");
    const restaurant = makeRestaurant();
    const order = makeOrder();

    await sideEffects.notifyOwnerOfSubmittedOrder(restaurant, order);
    await sideEffects.notifyOwnerOfSubmittedOrder(restaurant, order);

    assert.equal(created.length, 2);
    assert.deepEqual(new Set(created.map((message) => message.to)), new Set([amaPhone, kojoPhone]));
    assert.equal(created.some((message) => message.to === ownerPhone), false);
    assert.equal(new Set(created.map((message) => message.idempotencyKey)).size, 2);
    assert.ok(created.every((message) => message.metadata.kind === "staff_order_notification"));
    assert.ok(created.every((message) => message.metadata.recipientType === "manager"));

    await sideEffects.notifyOwnerOfCustomerAmendment(
      restaurant,
      makeOrder({ customerAmendmentVersion: 2 })
    );
    await sideEffects.notifyOwnerOfCustomerCancellationRequest(
      restaurant,
      makeOrder({ customerCancellationRequestStatus: "pending" })
    );

    const amended = created.filter(
      (message) => message.metadata.kind === "staff_order_amended_notification"
    );
    const cancellationRequests = created.filter(
      (message) =>
        message.metadata.kind === "staff_order_cancellation_request_notification"
    );
    assert.equal(amended.length, 2);
    assert.equal(cancellationRequests.length, 2);
    assert.ok(amended.every((message) => message.idempotencyKey.includes(":v2:")));
    assert.ok(cancellationRequests.every((message) => message.metadata.recipientPhone === message.to));
  } finally {
    restore(OutboundMessage, "findOne", originals.findOne);
    restore(OutboundMessage, "create", originals.create);
  }
});

test("submitted orders use the owner only when no valid manager exists", async () => {
  const queueService = require("../dist/services/wasenderQueue.service");
  const sideEffectsPath = require.resolve("../dist/services/orderSideEffects.service");
  const originalEnqueue = queueService.enqueueWasenderMessage;
  const queued = [];
  queueService.enqueueWasenderMessage = async (input) => {
    queued.push(input);
    return { _id: "queued-owner" };
  };
  delete require.cache[sideEffectsPath];

  try {
    const sideEffects = require("../dist/services/orderSideEffects.service");
    await sideEffects.notifyOwnerOfSubmittedOrder(
      makeRestaurant({ managerPhones: [], managerContacts: [] }),
      makeOrder()
    );
    assert.equal(queued.length, 1);
    assert.equal(queued[0].to, ownerPhone);
    assert.equal(queued[0].metadata.recipientType, "owner");
    assert.equal(queued[0].metadata.recipientPhone, ownerPhone);
  } finally {
    queueService.enqueueWasenderMessage = originalEnqueue;
    delete require.cache[sideEffectsPath];
  }
});

test("manager quoted order context is exact-recipient scoped and stale-version protected", async () => {
  const originals = {
    orderFindOne: Order.findOne,
    outboundFindOne: OutboundMessage.findOne,
    confirm: orderService.confirmRestaurantOrder
  };
  let quotedVersion = 2;
  let confirmInput;

  OutboundMessage.findOne = async (filter) => {
    assert.equal(filter.restaurantId, restaurantId);
    assert.equal(filter.providerMessageId, "manager-message");
    assert.equal(filter.status, "sent");
    return {
      metadata: {
        kind: "staff_order_amended_notification",
        orderId,
        amendmentVersion: quotedVersion,
        recipientType: "manager",
        recipientPhone: amaPhone
      }
    };
  };
  Order.findOne = async (filter) => {
    assert.equal(String(filter._id), orderId);
    assert.equal(filter.restaurantId, restaurantId);
    return makeOrder({ customerAmendmentVersion: 2 });
  };
  orderService.confirmRestaurantOrder = async (...args) => {
    confirmInput = args;
    return { order: makeOrder({ status: "accepted", customerAmendmentVersion: 2 }), idempotent: false };
  };

  try {
    const trusted = await findTrustedQuotedOwnerOrderContext(
      restaurantId,
      "manager-message",
      { normalizedPhone: amaPhone, role: "manager" }
    );
    assert.equal(trusted.order.orderNumber, "ORD-104");
    assert.equal(trusted.stale, false);

    const wrongManager = await findTrustedQuotedOwnerOrderContext(
      restaurantId,
      "manager-message",
      { normalizedPhone: kojoPhone, role: "manager" }
    );
    assert.equal(wrongManager, null);

    const accepted = await ownerOrderResolution.resolveQuotedOwnerOrderDecision(
      restaurantId,
      "manager-message",
      "accept",
      undefined,
      amaPhone,
      "manager",
      "Ama"
    );
    assert.equal(accepted.success, true);
    assert.equal(confirmInput[0], orderId);
    assert.equal(confirmInput[1], restaurantId);
    assert.equal(confirmInput[2], 2);
    assert.deepEqual(confirmInput[3], { phone: amaPhone, role: "manager", name: "Ama" });

    quotedVersion = 1;
    confirmInput = undefined;
    const stale = await ownerOrderResolution.resolveQuotedOwnerOrderDecision(
      restaurantId,
      "manager-message",
      "accept",
      undefined,
      amaPhone,
      "manager",
      "Ama"
    );
    assert.equal(stale.success, false);
    assert.match(stale.message, /updated since this message/i);
    assert.equal(confirmInput, undefined);
  } finally {
    restore(Order, "findOne", originals.orderFindOne);
    restore(OutboundMessage, "findOne", originals.outboundFindOne);
    orderService.confirmRestaurantOrder = originals.confirm;
  }
});

test("the first manager decision wins atomically and a later manager cannot overwrite its audit", async () => {
  const originals = {
    findOne: Order.findOne,
    findOneAndUpdate: Order.findOneAndUpdate
  };
  let state = makeOrder();
  const updates = [];

  Order.findOne = async (filter) => {
    if (String(filter.restaurantId) !== restaurantId) return null;
    return { ...state };
  };
  Order.findOneAndUpdate = async (filter, update) => {
    if (!filter.status.$in.includes(state.status)) return null;
    updates.push(update);
    state = { ...state, ...update.$set };
    return { ...state };
  };

  try {
    const first = await orderService.confirmRestaurantOrder(
      orderId,
      restaurantId,
      0,
      { phone: "0500000002", role: "manager", name: "  Ama  Mensah " }
    );
    const second = await orderService.confirmRestaurantOrder(
      orderId,
      restaurantId,
      0,
      { phone: kojoPhone, role: "manager", name: "Kojo" }
    );

    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(updates.length, 1);
    assert.equal(state.restaurantDecisionByPhone, amaPhone);
    assert.equal(state.restaurantDecisionByRole, "manager");
    assert.equal(state.restaurantDecisionByName, "Ama Mensah");
    assert.ok(state.restaurantDecisionAt instanceof Date);
  } finally {
    restore(Order, "findOne", originals.findOne);
    restore(Order, "findOneAndUpdate", originals.findOneAndUpdate);
  }
});

test("concurrent accept versus reject has one winner and preserves the winner audit", async () => {
  const originals = {
    findOne: Order.findOne,
    findOneAndUpdate: Order.findOneAndUpdate,
    updateMany: OutboundMessage.updateMany
  };
  let state = makeOrder();
  let transitionCount = 0;

  Order.findOne = async () => ({ ...state });
  Order.findOneAndUpdate = async (filter, update) => {
    if (!filter.status.$in.includes(state.status)) return null;
    transitionCount += 1;
    state = { ...state, ...update.$set };
    return { ...state };
  };
  OutboundMessage.updateMany = async () => ({ modifiedCount: 0 });

  try {
    const results = await Promise.allSettled([
      orderService.confirmRestaurantOrder(orderId, restaurantId, 0, {
        phone: amaPhone,
        role: "manager",
        name: "Ama"
      }),
      orderService.rejectRestaurantOrder(orderId, "Sold out", restaurantId, 0, {
        phone: kojoPhone,
        role: "manager",
        name: "Kojo"
      })
    ]);

    assert.equal(transitionCount, 1);
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(state.status, "accepted");
    assert.equal(state.restaurantDecisionByName, "Ama");
    assert.equal(state.restaurantDecisionByPhone, amaPhone);
  } finally {
    restore(Order, "findOne", originals.findOne);
    restore(Order, "findOneAndUpdate", originals.findOneAndUpdate);
    restore(OutboundMessage, "updateMany", originals.updateMany);
  }
});

test("reject and owner manual accept persist authenticated actor identity", async () => {
  const originals = {
    findOne: Order.findOne,
    findOneAndUpdate: Order.findOneAndUpdate,
    updateMany: OutboundMessage.updateMany
  };
  const updates = [];

  Order.findOne = async () => makeOrder();
  Order.findOneAndUpdate = async (_filter, update) => {
    updates.push(update.$set);
    return makeOrder(update.$set);
  };
  OutboundMessage.updateMany = async () => ({ modifiedCount: 0 });

  try {
    await orderService.rejectRestaurantOrder(orderId, "Kitchen closed", restaurantId, 0, {
      phone: kojoPhone,
      role: "manager",
      name: "Kojo"
    });
    await orderService.confirmRestaurantOrder(orderId, restaurantId, 0, {
      phone: ownerPhone,
      role: "owner",
      name: "Nana"
    });

    assert.equal(updates[0].restaurantDecisionByPhone, kojoPhone);
    assert.equal(updates[0].restaurantDecisionByRole, "manager");
    assert.equal(updates[0].restaurantDecisionByName, "Kojo");
    assert.equal(updates[1].restaurantDecisionByPhone, ownerPhone);
    assert.equal(updates[1].restaurantDecisionByRole, "owner");
  } finally {
    restore(Order, "findOne", originals.findOne);
    restore(Order, "findOneAndUpdate", originals.findOneAndUpdate);
    restore(OutboundMessage, "updateMany", originals.updateMany);
  }
});

test("manager operations are allowed while owner intelligence and menu administration are denied", () => {
  for (const toolName of [
    "confirm_order",
    "reject_order",
    "list_orders",
    "set_item_availability"
  ]) {
    assert.equal(isToolAllowedForRole(toolName, "manager"), true, toolName);
    assert.equal(isToolAllowedForRole(toolName, "owner"), true, toolName);
  }

  for (const toolName of [
    "get_yesterday_orders",
    "get_sales_summary",
    "get_business_report",
    "get_item_performance",
    "get_business_summary",
    "list_customers",
    "invite_customers_to_marketing",
    "create_campaign_draft",
    "update_campaign_draft",
    "preview_campaign",
    "approve_campaign",
    "cancel_campaign",
    "list_campaigns",
    "add_menu_items",
    "update_menu_price",
    "start_menu_item_image_upload",
    "assign_pending_image_to_menu_item",
    "confirm_pending_image_assignment",
    "cancel_pending_image_assignment",
    "remove_menu_item_image"
  ]) {
    assert.equal(isToolAllowedForRole(toolName, "manager"), false, toolName);
    assert.equal(isToolAllowedForRole(toolName, "owner"), true, toolName);
  }

  const managerTools = new Set(
    getAgentToolDefinitionsForRole("manager").map((tool) => tool.function.name)
  );
  assert.equal(managerTools.has("get_business_report"), false);
  assert.equal(managerTools.has("confirm_order"), true);
  assert.equal(
    toolRegistry.confirm_order.schema.safeParse({
      orderReference: "ORD-104",
      actorPhone: kojoPhone,
      actorName: "Kojo"
    }).success,
    false
  );
});

test("order decisions remain tenant scoped", async () => {
  const originals = {
    findOne: Order.findOne,
    findOneAndUpdate: Order.findOneAndUpdate
  };
  let lookupFilter;
  let writes = 0;
  Order.findOne = async (filter) => {
    lookupFilter = filter;
    return null;
  };
  Order.findOneAndUpdate = async () => {
    writes += 1;
  };

  try {
    await assert.rejects(
      orderService.confirmRestaurantOrder(orderId, otherRestaurantId, 0, {
        phone: amaPhone,
        role: "manager",
        name: "Ama"
      }),
      /Order not found/
    );
    assert.equal(lookupFilter.restaurantId, otherRestaurantId);
    assert.equal(writes, 0);
  } finally {
    restore(Order, "findOne", originals.findOne);
    restore(Order, "findOneAndUpdate", originals.findOneAndUpdate);
  }
});

test("operational feedback is manager-first while reviews remain owner-only", async () => {
  const queueService = require("../dist/services/wasenderQueue.service");
  const feedbackServicePath = require.resolve("../dist/services/orderFeedback.service");
  const originals = {
    enqueue: queueService.enqueueWasenderMessage,
    restaurantFindOne: Restaurant.findOne,
    feedbackUpdateOne: OrderFeedback.updateOne
  };
  const queued = [];

  queueService.enqueueWasenderMessage = async (input) => {
    queued.push(input);
    return { _id: `queued-${queued.length}` };
  };
  Restaurant.findOne = () => ({ select: async () => makeRestaurant() });
  OrderFeedback.updateOne = async () => ({ modifiedCount: 1 });
  delete require.cache[feedbackServicePath];

  try {
    const { notifyOwnerOfOrderFeedback } = require("../dist/services/orderFeedback.service");
    const baseFeedback = {
      _id: new Types.ObjectId(feedbackId),
      restaurantId: new Types.ObjectId(restaurantId),
      orderId: new Types.ObjectId(orderId),
      orderNumber: "ORD-104",
      customerName: "Esi",
      customerPhone: "+233500000099",
      message: "The order was late",
      sentiment: "negative",
      requiresOwnerAttention: true
    };

    await notifyOwnerOfOrderFeedback({ ...baseFeedback, type: "complaint" });
    await notifyOwnerOfOrderFeedback({
      ...baseFeedback,
      _id: new Types.ObjectId("64b000000000000000000505"),
      type: "review",
      message: "Loved the food",
      sentiment: "positive",
      requiresOwnerAttention: false
    });

    const issues = queued.filter(
      (message) => message.metadata.kind === "order_feedback_staff_notification"
    );
    const reviews = queued.filter(
      (message) => message.metadata.kind === "order_feedback_owner_notification"
    );
    assert.deepEqual(new Set(issues.map((message) => message.to)), new Set([amaPhone, kojoPhone]));
    assert.equal(issues.some((message) => message.to === ownerPhone), false);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].to, ownerPhone);
    assert.equal(reviews[0].metadata.recipientType, "owner");
  } finally {
    queueService.enqueueWasenderMessage = originals.enqueue;
    restore(Restaurant, "findOne", originals.restaurantFindOne);
    restore(OrderFeedback, "updateOne", originals.feedbackUpdateOne);
    delete require.cache[feedbackServicePath];
  }
});
