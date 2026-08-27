const assert = require("node:assert/strict");
const test = require("node:test");
const { Types } = require("mongoose");

const { executeAgentTool } = require("../dist/agent-tools/tool.executor");
const { toolRegistry } = require("../dist/agent-tools/tool.registry");
const orderService = require("../dist/services/order.service");
const { Order } = require("../dist/models/order.model");
const { Restaurant } = require("../dist/models/Restaurant");
const { MenuItem } = require("../dist/models/MenuItem");
const { MenuCategory } = require("../dist/models/MenuCategory");

const restaurantId = "64b000000000000000000001";
const orderId = "64b000000000000000000104";
const menuItemId = "64b000000000000000000301";
const customerPhone = "+233500000099";

const restaurant = {
  _id: restaurantId,
  name: "Test Kitchen",
  ownerPhone: "+233500000001",
  wasenderSessionId: "session-1",
  wasenderApiToken: "token-1",
  deliveryEnabled: true,
  deliveryPricing: { type: "flat", flatFee: 10 }
};

const makeOrder = (overrides = {}) => ({
  _id: new Types.ObjectId(orderId),
  restaurantId: new Types.ObjectId(restaurantId),
  orderNumber: "ORD-104",
  customerName: "Ama",
  customerPhone,
  items: [
    {
      menuItemId: new Types.ObjectId(menuItemId),
      name: "Jollof Rice",
      quantity: 1,
      unitPrice: 30,
      totalPrice: 30
    }
  ],
  subtotal: 30,
  deliveryFee: 10,
  deliveryFeeSource: "flat_fee",
  deliveryFeePending: false,
  total: 40,
  orderType: "delivery",
  deliveryAddress: "Osu",
  status: "awaiting_restaurant_confirmation",
  paymentMethod: "cash",
  paymentStatus: "unpaid",
  feedbackFollowUpStatus: "not_scheduled",
  feedbackFollowUpVersion: 0,
  customerAmendmentVersion: 0,
  ownerAmendmentNotifiedVersion: 0,
  createdAt: new Date("2026-08-27T12:00:00Z"),
  updatedAt: new Date("2026-08-27T12:00:00Z"),
  ...overrides
});

const customerContext = (message) => ({
  restaurantId,
  restaurant,
  sender: {
    phone: customerPhone,
    normalizedPhone: customerPhone,
    role: "customer",
    verified: true,
    name: "Ama"
  },
  originalMessage: message
});

test("pending rejection schema still accepts visible order references", () => {
  assert.equal(
    toolRegistry.reject_order.schema.safeParse({
      orderReference: "ORD-104",
      reason: "We do not deliver to that location"
    }).success,
    true
  );
});

test("customer cancellation emits a structured owner-notification event", async () => {
  const originalFindOne = Order.findOne;
  const originalCancel = orderService.cancelCustomerOrder;
  const order = makeOrder();

  Order.findOne = async () => order;
  orderService.cancelCustomerOrder = async () => ({
    order: { ...order, status: "cancelled", customerCancelledAt: new Date() }
  });

  try {
    const result = await executeAgentTool(
      "cancel_order",
      { orderReference: "ORD-104" },
      customerContext("Cancel order ORD-104")
    );

    assert.equal(result.success, true);
    assert.equal(result.data.orderEvent, "cancelled");
    assert.equal(result.data.notifyOwner, true);
    assert.equal(result.data.order.status, "cancelled");
  } finally {
    Order.findOne = originalFindOne;
    orderService.cancelCustomerOrder = originalCancel;
  }
});

test("submitted order amendment emits a versioned owner-notification event", async () => {
  const originalFindOne = Order.findOne;
  const originalAmend = orderService.amendCustomerSubmittedOrder;
  const order = makeOrder();
  let amendmentInput;

  Order.findOne = async () => order;
  orderService.amendCustomerSubmittedOrder = async (...args) => {
    amendmentInput = args;
    return {
      order: {
        ...order,
        items: [{ ...order.items[0], quantity: 3, totalPrice: 90 }],
        subtotal: 90,
        total: 100,
        customerAmendmentVersion: 1
      },
      amendmentVersion: 1
    };
  };

  try {
    const result = await executeAgentTool(
      "amend_submitted_order",
      {
        orderReference: "ORD-104",
        itemName: "Jollof Rice",
        newQuantity: 3
      },
      customerContext("Change the Jollof Rice on ORD-104 to 3")
    );

    assert.equal(result.success, true);
    assert.equal(result.data.orderEvent, "amended");
    assert.equal(result.data.notifyOwner, true);
    assert.equal(result.data.amendmentVersion, 1);
    assert.equal(amendmentInput[1], orderId);
    assert.equal(amendmentInput[3].newQuantity, 3);
  } finally {
    Order.findOne = originalFindOne;
    orderService.amendCustomerSubmittedOrder = originalAmend;
  }
});

test("customer can amend item quantity only before restaurant acceptance", async () => {
  const originalRestaurantFindById = Restaurant.findById;
  const originalOrderFindOne = Order.findOne;
  const originalOrderFindOneAndUpdate = Order.findOneAndUpdate;
  const originalMenuItemFind = MenuItem.find;
  const originalMenuCategoryFind = MenuCategory.find;
  const order = makeOrder();
  let capturedUpdate;

  Restaurant.findById = () => ({ select: async () => restaurant });
  Order.findOne = async () => order;
  MenuItem.find = async () => [
    {
      _id: new Types.ObjectId(menuItemId),
      restaurantId: new Types.ObjectId(restaurantId),
      categoryId: new Types.ObjectId("64b000000000000000000401"),
      name: "Jollof Rice",
      price: 30,
      isAvailable: true
    }
  ];
  MenuCategory.find = async () => [];
  Order.findOneAndUpdate = async (_filter, update) => {
    capturedUpdate = update;
    return makeOrder({
      items: [{ ...order.items[0], quantity: 3, totalPrice: 90 }],
      subtotal: 90,
      total: 100,
      customerAmendmentVersion: 1,
      customerAmendedAt: update.$set.customerAmendedAt
    });
  };

  try {
    const result = await orderService.amendCustomerSubmittedOrder(
      restaurantId,
      orderId,
      customerPhone,
      { itemName: "Jollof Rice", newQuantity: 3 }
    );

    assert.equal(result.amendmentVersion, 1);
    assert.equal(capturedUpdate.$set.items[0].quantity, 3);
    assert.equal(capturedUpdate.$set.subtotal, 90);
    assert.equal(capturedUpdate.$set.total, 100);
    assert.equal(capturedUpdate.$set.customerAmendmentVersion, 1);
  } finally {
    Restaurant.findById = originalRestaurantFindById;
    Order.findOne = originalOrderFindOne;
    Order.findOneAndUpdate = originalOrderFindOneAndUpdate;
    MenuItem.find = originalMenuItemFind;
    MenuCategory.find = originalMenuCategoryFind;
  }
});

test("accepted orders cannot be amended", async () => {
  const originalRestaurantFindById = Restaurant.findById;
  const originalOrderFindOne = Order.findOne;

  Restaurant.findById = () => ({ select: async () => restaurant });
  Order.findOne = async () => makeOrder({ status: "accepted" });

  try {
    await assert.rejects(
      () =>
        orderService.amendCustomerSubmittedOrder(
          restaurantId,
          orderId,
          customerPhone,
          { deliveryAddress: "East Legon" }
        ),
      (error) => error.code === "ORDER_NOT_AMENDABLE"
    );
  } finally {
    Restaurant.findById = originalRestaurantFindById;
    Order.findOne = originalOrderFindOne;
  }
});

test("owner cancellation and amendment notifications use idempotent event keys", async () => {
  const queueService = require("../dist/services/wasenderQueue.service");
  const sideEffectsPath = require.resolve("../dist/services/orderSideEffects.service");
  const originalEnqueue = queueService.enqueueWasenderMessage;
  const queued = [];

  queueService.enqueueWasenderMessage = async (input) => {
    queued.push(input);
    return { _id: `queued-${queued.length}` };
  };
  delete require.cache[sideEffectsPath];

  try {
    const sideEffects = require("../dist/services/orderSideEffects.service");
    await sideEffects.notifyOwnerOfCustomerCancellation(
      restaurant,
      makeOrder({ status: "cancelled", customerCancelledAt: new Date() })
    );
    await sideEffects.notifyOwnerOfCustomerAmendment(
      restaurant,
      makeOrder({ customerAmendmentVersion: 2 })
    );

    assert.equal(queued[0].idempotencyKey, `owner-order-cancelled:${orderId}`);
    assert.equal(queued[0].metadata.kind, "owner_order_cancelled_notification");
    assert.equal(queued[1].idempotencyKey, `owner-order-amended:${orderId}:2`);
    assert.equal(queued[1].metadata.amendmentVersion, 2);
  } finally {
    queueService.enqueueWasenderMessage = originalEnqueue;
    delete require.cache[sideEffectsPath];
  }
});

test("webhook side-effect dispatcher notifies owner for cancellation and amendment", async () => {
  const sideEffects = require("../dist/services/orderSideEffects.service");
  const controllerPath = require.resolve("../dist/controllers/wasender.controller");
  const originalFindOne = Order.findOne;
  const originalCancellation = sideEffects.notifyOwnerOfCustomerCancellation;
  const originalAmendment = sideEffects.notifyOwnerOfCustomerAmendment;
  const events = [];

  Order.findOne = async () => makeOrder();
  sideEffects.notifyOwnerOfCustomerCancellation = async () => {
    events.push("cancelled");
    return { ownerNotification: "queued" };
  };
  sideEffects.notifyOwnerOfCustomerAmendment = async () => {
    events.push("amended");
    return { ownerNotification: "queued" };
  };
  delete require.cache[controllerPath];

  try {
    const { sendCustomerOrderSideEffects } = require("../dist/controllers/wasender.controller");
    await sendCustomerOrderSideEffects(restaurant, {
      success: true,
      message: "Cancelled",
      data: {
        order: { id: orderId },
        orderEvent: "cancelled",
        notifyOwner: true
      }
    });
    await sendCustomerOrderSideEffects(restaurant, {
      success: true,
      message: "Updated",
      data: {
        order: { id: orderId },
        orderEvent: "amended",
        notifyOwner: true
      }
    });

    assert.deepEqual(events, ["cancelled", "amended"]);
  } finally {
    Order.findOne = originalFindOne;
    sideEffects.notifyOwnerOfCustomerCancellation = originalCancellation;
    sideEffects.notifyOwnerOfCustomerAmendment = originalAmendment;
    delete require.cache[controllerPath];
  }
});

test("queue delivery tracking records cancellation and amendment notification success", async () => {
  const { updateOrderSideEffectAfterSend } = require("../dist/services/wasenderQueue.service");
  const originalUpdateOne = Order.updateOne;
  const updates = [];

  Order.updateOne = async (filter, update) => {
    updates.push({ filter, update });
    return { matchedCount: 1 };
  };

  try {
    await updateOrderSideEffectAfterSend(
      {
        metadata: {
          restaurantId,
          orderId,
          kind: "owner_order_cancelled_notification"
        }
      },
      { success: true, status: 200 }
    );
    await updateOrderSideEffectAfterSend(
      {
        metadata: {
          restaurantId,
          orderId,
          kind: "owner_order_amended_notification",
          amendmentVersion: 3
        }
      },
      { success: true, status: 200 }
    );

    assert.ok(updates[0].update.$set.ownerCancellationNotifiedAt instanceof Date);
    assert.equal(updates[1].update.$max.ownerAmendmentNotifiedVersion, 3);
  } finally {
    Order.updateOne = originalUpdateOne;
  }
});

test("customer role exposes submitted-order amendment but staff roles do not", () => {
  const { getAllowedToolNamesForRole } = require("../dist/agent-tools/tool.permissions");

  assert.equal(getAllowedToolNamesForRole("customer").includes("amend_submitted_order"), true);
  assert.equal(getAllowedToolNamesForRole("owner").includes("amend_submitted_order"), false);
  assert.equal(getAllowedToolNamesForRole("manager").includes("amend_submitted_order"), false);
});
