const assert = require("node:assert/strict");
const test = require("node:test");
const { Types } = require("mongoose");

const { executeAgentTool } = require("../dist/agent-tools/tool.executor");
const orderService = require("../dist/services/order.service");
const {
  getQueuedOwnerOrderNotificationStaleReason
} = require("../dist/services/wasenderQueue.service");
const {
  findTrustedQuotedOwnerOrderContext
} = require("../dist/services/ownerOrderNotificationContext.service");
const {
  notifyCustomerOfCancellationResolution,
  notifyOwnerOfCustomerCancellationRequest
} = require("../dist/services/orderSideEffects.service");
const { Order } = require("../dist/models/order.model");
const { OutboundMessage } = require("../dist/models/outboundMessage.model");
const { PendingAgentAction } = require("../dist/models/pendingAgentAction.model");

const restaurantId = "64b000000000000000000001";
const orderId = "64b000000000000000000104";
const menuItemId = "64b000000000000000000301";
const customerPhone = "+233500000099";
const ownerPhone = "+233500000001";

const restaurant = {
  _id: new Types.ObjectId(restaurantId),
  name: "Golden Grill",
  ownerPhone,
  wasenderSessionId: "session-1",
  wasenderApiToken: "token-1"
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
  ownerAmendmentNotifiedVersion: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides
});

const customerContext = (message, quotedMessageId) => ({
  restaurantId,
  restaurant,
  sender: {
    phone: customerPhone,
    normalizedPhone: customerPhone,
    role: "customer",
    verified: true,
    name: "Ama"
  },
  originalMessage: message,
  quotedMessageId
});

const ownerContext = (message, quotedMessageId) => ({
  restaurantId,
  restaurant,
  sender: {
    phone: ownerPhone,
    normalizedPhone: ownerPhone,
    role: "owner",
    verified: true
  },
  originalMessage: message,
  quotedMessageId
});

test("pre-acceptance customer cancellation is immediate and atomic", async () => {
  const originalFindOne = Order.findOne;
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  const pending = makeOrder();
  let update;
  Order.findOne = async () => pending;
  Order.findOneAndUpdate = async (_filter, value) => {
    update = value;
    return makeOrder({ status: "cancelled", customerCancelledAt: new Date() });
  };

  try {
    const result = await orderService.cancelCustomerOrder(
      restaurantId,
      orderId,
      customerPhone
    );
    assert.equal(result.mode, "cancelled");
    assert.equal(update.$set.status, "cancelled");
    assert.equal(update.$set.customerCancelledAt instanceof Date, true);
  } finally {
    Order.findOne = originalFindOne;
    Order.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

for (const status of ["accepted", "preparing"]) {
  test(`${status} customer cancellation creates a request without cancelling`, async () => {
    const originalFindOne = Order.findOne;
    const originalFindOneAndUpdate = Order.findOneAndUpdate;
    const active = makeOrder({ status });
    let update;
    Order.findOne = async () => active;
    Order.findOneAndUpdate = async (_filter, value) => {
      update = value;
      return makeOrder({
        status,
        customerCancellationRequestStatus: "pending",
        customerCancellationRequestedAt: new Date()
      });
    };

    try {
      const result = await orderService.cancelCustomerOrder(
        restaurantId,
        orderId,
        customerPhone
      );
      assert.equal(result.mode, "requested");
      assert.equal(result.order.status, status);
      assert.equal(update.$set.status, undefined);
      assert.equal(update.$set.customerCancellationRequestStatus, "pending");
    } finally {
      Order.findOne = originalFindOne;
      Order.findOneAndUpdate = originalFindOneAndUpdate;
    }
  });
}

test("duplicate customer cancellation request is idempotent", async () => {
  const originalFindOne = Order.findOne;
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  let updates = 0;
  Order.findOne = async () =>
    makeOrder({
      status: "accepted",
      customerCancellationRequestStatus: "pending"
    });
  Order.findOneAndUpdate = async () => {
    updates += 1;
  };

  try {
    const result = await orderService.cancelCustomerOrder(
      restaurantId,
      orderId,
      customerPhone
    );
    assert.equal(result.mode, "requested");
    assert.equal(result.idempotent, true);
    assert.equal(updates, 0);
  } finally {
    Order.findOne = originalFindOne;
    Order.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

for (const decision of ["approve", "decline"]) {
  test(`owner can ${decision} a pending customer cancellation request`, async () => {
    const originalFindOne = Order.findOne;
    const originalFindOneAndUpdate = Order.findOneAndUpdate;
    const originalUpdateMany = OutboundMessage.updateMany;
    let update;
    Order.findOne = async () =>
      makeOrder({
        status: "preparing",
        customerCancellationRequestStatus: "pending"
      });
    Order.findOneAndUpdate = async (_filter, value) => {
      update = value;
      return makeOrder({
        status: decision === "approve" ? "cancelled" : "preparing",
        customerCancellationRequestStatus:
          decision === "approve" ? "approved" : "declined"
      });
    };
    OutboundMessage.updateMany = async () => ({ modifiedCount: 0 });

    try {
      const result = await orderService.resolveCustomerCancellationRequest(
        restaurantId,
        orderId,
        { decision, resolvedByPhone: ownerPhone }
      );
      assert.equal(result.decision, decision === "approve" ? "approved" : "declined");
      assert.equal(
        result.order.status,
        decision === "approve" ? "cancelled" : "preparing"
      );
      assert.equal(
        update.$set.customerCancellationRequestStatus,
        decision === "approve" ? "approved" : "declined"
      );
    } finally {
      Order.findOne = originalFindOne;
      Order.findOneAndUpdate = originalFindOneAndUpdate;
      OutboundMessage.updateMany = originalUpdateMany;
    }
  });
}

test("trusted owner tool resolves only the selected cancellation request", async () => {
  const originalFindOne = Order.findOne;
  const originalResolve = orderService.resolveCustomerCancellationRequest;
  const pending = makeOrder({
    status: "preparing",
    customerCancellationRequestStatus: "pending"
  });
  let resolutionInput;
  Order.findOne = async () => pending;
  orderService.resolveCustomerCancellationRequest = async (...args) => {
    resolutionInput = args;
    return {
      order: makeOrder({
        status: "cancelled",
        customerCancellationRequestStatus: "approved"
      }),
      decision: "approved",
      idempotent: false
    };
  };
  try {
    const result = await executeAgentTool(
      "resolve_customer_cancellation_request",
      { orderReference: "ORD-104", decision: "approve" },
      ownerContext("Approve cancellation for ORD-104")
    );
    assert.equal(result.success, true);
    assert.equal(result.data.orderEvent, "cancellation_resolved");
    assert.equal(result.data.notifyCustomer, true);
    assert.equal(resolutionInput[1], orderId);
    assert.equal(resolutionInput[2].resolvedByPhone, ownerPhone);
  } finally {
    Order.findOne = originalFindOne;
    orderService.resolveCustomerCancellationRequest = originalResolve;
  }
});

test("cancellation request and resolution notifications are idempotently queued", async () => {
  const originalFindOne = OutboundMessage.findOne;
  const originalCreate = OutboundMessage.create;
  const queued = [];
  OutboundMessage.findOne = () => ({ select: async () => null });
  OutboundMessage.create = async (input) => {
    queued.push(input);
    return { _id: `queued-${queued.length}`, ...input };
  };

  try {
    await notifyOwnerOfCustomerCancellationRequest(
      restaurant,
      makeOrder({
        status: "preparing",
        customerCancellationRequestStatus: "pending"
      })
    );
    await notifyCustomerOfCancellationResolution(
      restaurant,
      makeOrder({
        status: "cancelled",
        customerCancellationRequestStatus: "approved"
      })
    );
    assert.equal(queued[0].metadata.kind, "owner_order_cancellation_request_notification");
    assert.match(queued[0].text, /CANCELLATION REQUEST/);
    assert.equal(queued[1].metadata.kind, "customer_order_cancellation_resolution_notification");
    assert.match(queued[1].text, /approved/i);
  } finally {
    OutboundMessage.findOne = originalFindOne;
    OutboundMessage.create = originalCreate;
  }
});

test("original version zero and old amendment messages become stale", async () => {
  const originalFindOne = Order.findOne;
  Order.findOne = async () =>
    makeOrder({ status: "awaiting_restaurant_confirmation", customerAmendmentVersion: 2 });
  try {
    assert.match(
      await getQueuedOwnerOrderNotificationStaleReason(
        {
          kind: "owner_order_notification",
          orderId,
          amendmentVersion: 0
        },
        restaurantId
      ),
      /version is 2/
    );
    assert.match(
      await getQueuedOwnerOrderNotificationStaleReason(
        {
          kind: "owner_order_amended_notification",
          orderId,
          amendmentVersion: 1
        },
        restaurantId
      ),
      /version is 2/
    );
    assert.equal(
      await getQueuedOwnerOrderNotificationStaleReason(
        {
          kind: "owner_order_amended_notification",
          orderId,
          amendmentVersion: 2
        },
        restaurantId
      ),
      null
    );
  } finally {
    Order.findOne = originalFindOne;
  }
});

test("quoted owner notification context carries and compares amendment version", async () => {
  const originalOrderFindOne = Order.findOne;
  const originalOutboundFindOne = OutboundMessage.findOne;
  Order.findOne = async (filter) =>
    filter.ownerNotificationProviderMessageId
      ? null
      : makeOrder({ customerAmendmentVersion: 2 });
  OutboundMessage.findOne = async () => ({
    metadata: {
      kind: "owner_order_amended_notification",
      orderId,
      amendmentVersion: 1
    }
  });
  try {
    const context = await findTrustedQuotedOwnerOrderContext(
      restaurantId,
      "provider-old-v1"
    );
    assert.equal(context.expectedAmendmentVersion, 1);
    assert.equal(context.currentAmendmentVersion, 2);
    assert.equal(context.stale, true);
  } finally {
    Order.findOne = originalOrderFindOne;
    OutboundMessage.findOne = originalOutboundFindOne;
  }
});

test("quoted stale notification cannot accept the latest amended order", async () => {
  const originalOrderFindOne = Order.findOne;
  const originalOutboundFindOne = OutboundMessage.findOne;
  const originalConfirm = orderService.confirmRestaurantOrder;
  const originalPendingUpdateMany = PendingAgentAction.updateMany;
  let confirmations = 0;
  Order.findOne = async (filter) =>
    filter.ownerNotificationProviderMessageId
      ? null
      : makeOrder({ customerAmendmentVersion: 2 });
  OutboundMessage.findOne = async () => ({
    metadata: {
      kind: "owner_order_amended_notification",
      orderId,
      amendmentVersion: 1
    }
  });
  orderService.confirmRestaurantOrder = async () => {
    confirmations += 1;
  };
  PendingAgentAction.updateMany = async () => ({ modifiedCount: 0 });
  try {
    const result = await executeAgentTool(
      "confirm_order",
      { orderReference: "ORD-104" },
      ownerContext("Accept", "provider-old-v1")
    );
    assert.equal(result.success, false);
    assert.equal(result.code, "ORDER_NOTIFICATION_VERSION_STALE");
    assert.equal(confirmations, 0);
  } finally {
    Order.findOne = originalOrderFindOne;
    OutboundMessage.findOne = originalOutboundFindOne;
    orderService.confirmRestaurantOrder = originalConfirm;
    PendingAgentAction.updateMany = originalPendingUpdateMany;
  }
});

test("quoted current amendment can be accepted", async () => {
  const originalOrderFindOne = Order.findOne;
  const originalOutboundFindOne = OutboundMessage.findOne;
  const originalConfirm = orderService.confirmRestaurantOrder;
  const originalPendingUpdateMany = PendingAgentAction.updateMany;
  const current = makeOrder({ customerAmendmentVersion: 2 });
  let confirmations = 0;
  Order.findOne = async (filter) =>
    filter.ownerNotificationProviderMessageId ? null : current;
  OutboundMessage.findOne = async () => ({
    metadata: {
      kind: "owner_order_amended_notification",
      orderId,
      amendmentVersion: 2
    }
  });
  orderService.confirmRestaurantOrder = async () => {
    confirmations += 1;
    return { order: makeOrder({ status: "accepted", customerAmendmentVersion: 2 }), idempotent: false };
  };
  PendingAgentAction.updateMany = async () => ({ modifiedCount: 0 });
  try {
    const result = await executeAgentTool(
      "confirm_order",
      { orderReference: "ORD-104" },
      ownerContext("Accept", "provider-current-v2")
    );
    assert.equal(result.success, true);
    assert.equal(confirmations, 1);
  } finally {
    Order.findOne = originalOrderFindOne;
    OutboundMessage.findOne = originalOutboundFindOne;
    orderService.confirmRestaurantOrder = originalConfirm;
    PendingAgentAction.updateMany = originalPendingUpdateMany;
  }
});

test("acceptance atomically requires the version shown to the owner", async () => {
  const originalFindOne = Order.findOne;
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  const current = makeOrder({ customerAmendmentVersion: 2 });
  let filter;
  Order.findOne = async () => current;
  Order.findOneAndUpdate = async (value) => {
    filter = value;
    return makeOrder({ status: "accepted", customerAmendmentVersion: 2 });
  };
  try {
    const result = await orderService.confirmRestaurantOrder(
      orderId,
      restaurantId,
      2
    );
    assert.equal(result.order.status, "accepted");
    assert.equal(filter.customerAmendmentVersion, 2);
  } finally {
    Order.findOne = originalFindOne;
    Order.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("quoted stale notification cannot reject the latest amended order", async () => {
  const originalOrderFindOne = Order.findOne;
  const originalOutboundFindOne = OutboundMessage.findOne;
  const originalReject = orderService.rejectRestaurantOrder;
  let rejections = 0;
  Order.findOne = async (filter) =>
    filter.ownerNotificationProviderMessageId
      ? null
      : makeOrder({ customerAmendmentVersion: 2 });
  OutboundMessage.findOne = async () => ({
    metadata: {
      kind: "owner_order_amended_notification",
      orderId,
      amendmentVersion: 1
    }
  });
  orderService.rejectRestaurantOrder = async () => {
    rejections += 1;
  };
  try {
    const result = await executeAgentTool(
      "reject_order",
      { orderReference: "ORD-104" },
      ownerContext(
        "Reject because we cannot fulfil it",
        "provider-old-v1-reject"
      )
    );
    assert.equal(result.success, false);
    assert.equal(result.code, "ORDER_NOTIFICATION_VERSION_STALE");
    assert.equal(rejections, 0);
  } finally {
    Order.findOne = originalOrderFindOne;
    OutboundMessage.findOne = originalOutboundFindOne;
    orderService.rejectRestaurantOrder = originalReject;
  }
});

test("submitted-order quantity must be explicit and match the model proposal", async () => {
  const originalFindOne = Order.findOne;
  const originalAmend = orderService.amendCustomerSubmittedOrder;
  let amendments = 0;
  Order.findOne = async () => makeOrder();
  orderService.amendCustomerSubmittedOrder = async (_restaurant, _order, _phone, input) => {
    amendments += 1;
    return {
      order: makeOrder({ customerAmendmentVersion: 1 }),
      amendmentVersion: 1,
      input
    };
  };
  try {
    const guessed = await executeAgentTool(
      "amend_submitted_order",
      { orderReference: "ORD-104", itemName: "Jollof Rice", newQuantity: 3 },
      customerContext("Make the jollof more")
    );
    assert.equal(guessed.success, false);
    assert.equal(guessed.code, "ORDER_QUANTITY_REQUIRED");

    const explicit = await executeAgentTool(
      "amend_submitted_order",
      { orderReference: "ORD-104", itemName: "Jollof Rice", newQuantity: 5 },
      customerContext("Change my jollof from 2 to 5 on ORD-104")
    );
    assert.equal(explicit.success, true);
    assert.equal(amendments, 1);
  } finally {
    Order.findOne = originalFindOne;
    orderService.amendCustomerSubmittedOrder = originalAmend;
  }
});

test("submitted-order removal requires explicit customer removal wording", async () => {
  const originalFindOne = Order.findOne;
  const originalAmend = orderService.amendCustomerSubmittedOrder;
  let amendments = 0;
  Order.findOne = async () => makeOrder();
  orderService.amendCustomerSubmittedOrder = async () => {
    amendments += 1;
    return {
      order: makeOrder({ customerAmendmentVersion: 1 }),
      amendmentVersion: 1
    };
  };
  try {
    const invented = await executeAgentTool(
      "amend_submitted_order",
      { orderReference: "ORD-104", itemName: "Jollof Rice", newQuantity: 0 },
      customerContext("I want to change my jollof")
    );
    assert.equal(invented.code, "ORDER_ITEM_REMOVAL_NOT_GROUNDED");

    const explicit = await executeAgentTool(
      "amend_submitted_order",
      { orderReference: "ORD-104", itemName: "Jollof Rice", newQuantity: 0 },
      customerContext("Remove the jollof rice from ORD-104")
    );
    assert.equal(explicit.success, true);
    assert.equal(amendments, 1);
  } finally {
    Order.findOne = originalFindOne;
    orderService.amendCustomerSubmittedOrder = originalAmend;
  }
});
