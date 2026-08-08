const assert = require("node:assert/strict");
const test = require("node:test");

const { executeAgentTool } = require("../dist/agent-tools/tool.executor");
const { toolRegistry } = require("../dist/agent-tools/tool.registry");
const {
  getAgentToolDefinitionsForRole
} = require("../dist/services/ai/agentToolDefinitions.service");
const { buildAgentSystemPrompt } = require("../dist/services/ai/agentPrompt.service");
const { Order } = require("../dist/models/order.model");
const { OutboundMessage } = require("../dist/models/outboundMessage.model");
const { PendingAgentAction } = require("../dist/models/pendingAgentAction.model");
const orderService = require("../dist/services/order.service");
const {
  handleSavedOwnerSelectionReply,
  requestOwnerOrderRejectionReason
} = require("../dist/services/ownerOrderResolution.service");

const restaurantId = "64b000000000000000000001";
const otherRestaurantId = "64b000000000000000000002";
const orderId = "64b000000000000000000104";
const ownerPhone = "+233507879374";

const restaurant = {
  _id: restaurantId,
  name: "Golden Grill",
  timezone: "Africa/Accra"
};

const owner = {
  name: "Gabriel",
  phone: ownerPhone,
  normalizedPhone: ownerPhone,
  role: "owner",
  verified: true
};

const context = {
  restaurantId,
  restaurant,
  sender: owner,
  originalMessage: "Reject ORD-104"
};

const makeOrder = (overrides = {}) => ({
  _id: orderId,
  restaurantId,
  orderNumber: "ORD-104",
  customerName: "Ama",
  customerPhone: "+233241111111",
  status: "pending",
  customerConfirmedAt: new Date(),
  createdAt: new Date(),
  feedbackFollowUpStatus: "not_scheduled",
  restaurantRejectedAt: undefined,
  restaurantRejectionReason: undefined,
  saveCalls: 0,
  async save() {
    this.saveCalls += 1;
    return this;
  },
  ...overrides
});

test("reject_order requires a meaningful reason in schema and executor", async () => {
  assert.equal(
    toolRegistry.reject_order.schema.safeParse({ orderId }).success,
    false
  );
  assert.equal(
    toolRegistry.reject_order.schema.safeParse({ orderId, reason: "  " }).success,
    false
  );

  const result = await executeAgentTool("reject_order", { orderId }, context);
  assert.equal(result.success, false);
  assert.equal(result.code, "ORDER_REJECTION_REASON_REQUIRED");
  assert.match(result.message, /reason/i);
});

test("AI tool definitions require rejection reason and restrict staff progress statuses", () => {
  const tools = getAgentToolDefinitionsForRole("owner");
  const rejectTool = tools.find(({ function: definition }) => definition.name === "reject_order");
  const statusTool = tools.find(
    ({ function: definition }) => definition.name === "update_order_status"
  );

  assert.equal(rejectTool.function.parameters.required.includes("reason"), true);
  assert.deepEqual(
    statusTool.function.parameters.properties.status.enum,
    ["preparing", "ready", "out_for_delivery", "completed"]
  );
  assert.equal(
    toolRegistry.update_order_status.schema.safeParse({
      orderId,
      status: "pending"
    }).success,
    false
  );
});

test("backend rejection validation runs before order lookup", async () => {
  const originalFindOne = Order.findOne;
  let lookups = 0;
  Order.findOne = async () => {
    lookups += 1;
    return makeOrder();
  };

  try {
    await assert.rejects(
      () => orderService.rejectRestaurantOrder(orderId, undefined, restaurantId),
      (error) => error.code === "ORDER_REJECTION_REASON_REQUIRED"
    );
    assert.equal(lookups, 0);
  } finally {
    Order.findOne = originalFindOne;
  }
});

test("missing reason state is scoped and deterministic fallback never infers a reason", async () => {
  const originalOrderFindOne = Order.findOne;
  const originalOrderFindOneAndUpdate = Order.findOneAndUpdate;
  const originalOrderFind = Order.find;
  const originalOutboundUpdateMany = OutboundMessage.updateMany;
  const originalPendingCreate = PendingAgentAction.create;
  const originalPendingFindOne = PendingAgentAction.findOne;
  const pendingOrder = makeOrder();
  let createdAction;
  let rejectionUpdate;

  Order.findOne = async (filter) => {
    assert.equal(String(filter.restaurantId), restaurantId);
    return pendingOrder;
  };
  PendingAgentAction.create = async (input) => {
    createdAction = { _id: "reason-action-104", actionVersion: 1, ...input };
    return createdAction;
  };

  try {
    const request = await requestOwnerOrderRejectionReason({
      restaurantId,
      senderPhone: ownerPhone,
      senderRole: "owner",
      orderReference: "ORD-104"
    });
    assert.match(request.message, /reason.*ORD-104/i);
    assert.equal(createdAction.senderPhone, ownerPhone);
    assert.equal(createdAction.senderRole, "owner");
    assert.equal(createdAction.data.awaitingReason, true);
    assert.deepEqual(createdAction.data.orderIds, [orderId]);

    const pendingSelection = {
      ...createdAction,
      data: { ...createdAction.data },
      async save() {
        throw new Error("a conversational reply must not complete the pending action");
      }
    };
    PendingAgentAction.findOne = (filter) => ({
      sort: async () => {
        assert.equal(String(filter.restaurantId), restaurantId);
        assert.equal(filter.senderPhone, ownerPhone);
        assert.equal(filter.senderRole, "owner");
        return pendingSelection;
      }
    });
    Order.find = async (filter) => {
      assert.equal(String(filter.restaurantId), restaurantId);
      return [pendingOrder];
    };
    Order.findOneAndUpdate = async (filter, update) => {
      assert.equal(String(filter.restaurantId), restaurantId);
      rejectionUpdate = update.$set;
      return { ...pendingOrder, ...update.$set };
    };
    OutboundMessage.updateMany = async () => ({ modifiedCount: 0 });

    const result = await handleSavedOwnerSelectionReply(
      restaurantId,
      ownerPhone,
      "hold on let me check the kitchen",
      "owner"
    );

    assert.equal(result.handled, false);
    assert.equal(result.success, false);
    assert.equal(rejectionUpdate, undefined);
    assert.equal(pendingSelection.status, "pending");
  } finally {
    Order.findOne = originalOrderFindOne;
    Order.findOneAndUpdate = originalOrderFindOneAndUpdate;
    Order.find = originalOrderFind;
    OutboundMessage.updateMany = originalOutboundUpdateMany;
    PendingAgentAction.create = originalPendingCreate;
    PendingAgentAction.findOne = originalPendingFindOne;
  }
});

test("cancel and never mind cancel an awaiting rejection without mutation", async () => {
  const originalPendingFindOne = PendingAgentAction.findOne;
  const originalRejectOrder = orderService.rejectRestaurantOrder;
  const originalOrderFind = Order.find;
  const unchangedOrder = makeOrder();
  let rejectionCalls = 0;
  let orderLookups = 0;

  orderService.rejectRestaurantOrder = async () => {
    rejectionCalls += 1;
    throw new Error("reject_order must not run for cancellation");
  };
  Order.find = async () => {
    orderLookups += 1;
    return [unchangedOrder];
  };

  try {
    for (const message of ["cancel", "never mind"]) {
      const pendingSelection = {
        _id: `reason-${message}`,
        status: "pending",
        resultMessage: undefined,
        data: {
          decision: "reject",
          awaitingReason: true,
          orderIds: [orderId]
        },
        saveCalls: 0,
        async save() {
          this.saveCalls += 1;
          return this;
        }
      };
      PendingAgentAction.findOne = () => ({
        sort: async () => pendingSelection
      });

      const result = await handleSavedOwnerSelectionReply(
        restaurantId,
        ownerPhone,
        message,
        "owner"
      );

      assert.equal(result.handled, true);
      assert.equal(result.success, true);
      assert.equal(pendingSelection.status, "cancelled");
      assert.equal(pendingSelection.saveCalls, 1);
    }

    assert.equal(rejectionCalls, 0);
    assert.equal(orderLookups, 0);
    assert.equal(unchangedOrder.status, "pending");
  } finally {
    PendingAgentAction.findOne = originalPendingFindOne;
    orderService.rejectRestaurantOrder = originalRejectOrder;
    Order.find = originalOrderFind;
  }
});

test("saved multi-order selections process all exact choices", async () => {
  const originalOrderFind = Order.find;
  const originalPendingFindOne = PendingAgentAction.findOne;
  const originalConfirmOrder = orderService.confirmRestaurantOrder;
  const firstOrderId = "64b000000000000000000104";
  const secondOrderId = "64b000000000000000000105";

  try {
    for (const message of ["all", "1 and 2"]) {
      const confirmedOrderIds = [];
      const pendingSelection = {
        _id: `selection-${message}`,
        actionVersion: 1,
        status: "pending",
        data: {
          decision: "accept",
          orderIds: [firstOrderId, secondOrderId],
          awaitingReason: false
        },
        async save() {
          return this;
        }
      };

      PendingAgentAction.findOne = () => ({
        sort: async () => pendingSelection
      });
      Order.find = async () => [
        makeOrder({ _id: firstOrderId, orderNumber: "ORD-104" }),
        makeOrder({ _id: secondOrderId, orderNumber: "ORD-105" })
      ];
      orderService.confirmRestaurantOrder = async (selectedOrderId) => {
        confirmedOrderIds.push(selectedOrderId);
        return {
          order: makeOrder({
            _id: selectedOrderId,
            orderNumber: selectedOrderId === firstOrderId ? "ORD-104" : "ORD-105",
            status: "accepted"
          }),
          idempotent: false
        };
      };

      const result = await handleSavedOwnerSelectionReply(
        restaurantId,
        ownerPhone,
        message,
        "owner"
      );

      assert.equal(result.success, true);
      assert.deepEqual(confirmedOrderIds, [firstOrderId, secondOrderId]);
      assert.equal(pendingSelection.status, "completed");
    }
  } finally {
    Order.find = originalOrderFind;
    PendingAgentAction.findOne = originalPendingFindOne;
    orderService.confirmRestaurantOrder = originalConfirmOrder;
  }
});

test("one successful order tool only closes a single-order saved selection", async () => {
  const originalOrderFindOne = Order.findOne;
  const originalConfirmOrder = orderService.confirmRestaurantOrder;
  const originalPendingUpdateMany = PendingAgentAction.updateMany;
  let cleanupFilter;
  const acceptedOrder = makeOrder({
    status: "accepted",
    items: [
      { name: "Jollof Rice", quantity: 1, unitPrice: 25, totalPrice: 25 }
    ]
  });

  Order.findOne = async () => acceptedOrder;
  orderService.confirmRestaurantOrder = async () => ({
    order: acceptedOrder,
    idempotent: false
  });
  PendingAgentAction.updateMany = async (filter) => {
    cleanupFilter = filter;
    return { modifiedCount: 1 };
  };

  try {
    const result = await executeAgentTool(
      "confirm_order",
      { orderId },
      { ...context, originalMessage: "accept" }
    );

    assert.equal(result.success, true);
    assert.deepEqual(cleanupFilter["data.orderIds"], {
      $size: 1,
      $all: [orderId]
    });
  } finally {
    Order.findOne = originalOrderFindOne;
    orderService.confirmRestaurantOrder = originalConfirmOrder;
    PendingAgentAction.updateMany = originalPendingUpdateMany;
  }
});

test("rejection stores the owner's exact reason and duplicate execution is idempotent", async () => {
  const originalFindOne = Order.findOne;
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  const originalOutboundUpdateMany = OutboundMessage.updateMany;
  let current = makeOrder();
  let atomicUpdates = 0;
  let feedbackCancellations = 0;

  Order.findOne = async (filter) => {
    assert.equal(String(filter.restaurantId), restaurantId);
    return current;
  };
  Order.findOneAndUpdate = async (filter, update) => {
    assert.equal(String(filter.restaurantId), restaurantId);
    if (current.status !== "pending") {
      return null;
    }
    atomicUpdates += 1;
    current = makeOrder({
      status: update.$set.status,
      feedbackFollowUpStatus: update.$set.feedbackFollowUpStatus,
      restaurantRejectedAt: update.$set.restaurantRejectedAt,
      restaurantRejectionReason: update.$set.restaurantRejectionReason
    });
    return current;
  };
  OutboundMessage.updateMany = async () => {
    feedbackCancellations += 1;
    return { modifiedCount: 0 };
  };

  try {
    const first = await orderService.rejectRestaurantOrder(
      orderId,
      "Chicken is finished.",
      restaurantId
    );
    const duplicate = await orderService.rejectRestaurantOrder(
      orderId,
      "Chicken is finished.",
      restaurantId
    );

    assert.equal(first.idempotent, false);
    assert.equal(duplicate.idempotent, true);
    assert.equal(first.order.restaurantRejectionReason, "Chicken is finished.");
    assert.equal(atomicUpdates, 1);
    assert.equal(feedbackCancellations, 1);
  } finally {
    Order.findOne = originalFindOne;
    Order.findOneAndUpdate = originalFindOneAndUpdate;
    OutboundMessage.updateMany = originalOutboundUpdateMany;
  }
});

test("duplicate order acceptance is atomically idempotent", async () => {
  const originalFindOne = Order.findOne;
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  let current = makeOrder();
  let atomicUpdates = 0;

  Order.findOne = async () => current;
  Order.findOneAndUpdate = async (_filter, update) => {
    if (current.status !== "pending") {
      return null;
    }
    atomicUpdates += 1;
    current = makeOrder({
      status: update.$set.status,
      restaurantConfirmedAt: update.$set.restaurantConfirmedAt
    });
    return current;
  };

  try {
    const first = await orderService.confirmRestaurantOrder(orderId, restaurantId);
    const duplicate = await orderService.confirmRestaurantOrder(orderId, restaurantId);
    assert.equal(first.idempotent, false);
    assert.equal(duplicate.idempotent, true);
    assert.equal(atomicUpdates, 1);
  } finally {
    Order.findOne = originalFindOne;
    Order.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("staff status transitions reject terminal orders and keep repeated completion harmless", async () => {
  const originalFindOne = Order.findOne;

  try {
    const accepted = makeOrder({ status: "accepted" });
    Order.findOne = async () => accepted;
    const preparing = await orderService.updateRestaurantOrderStatus(
      restaurantId,
      orderId,
      "preparing"
    );
    assert.equal(preparing.order.status, "preparing");
    assert.equal(preparing.idempotent, false);
    assert.equal(accepted.saveCalls, 1);

    Order.findOne = async () => makeOrder({ status: "rejected" });
    await assert.rejects(
      () => orderService.updateRestaurantOrderStatus(restaurantId, orderId, "completed"),
      (error) => error.code === "ORDER_STATUS_TRANSITION_INVALID"
    );

    Order.findOne = async () => makeOrder({ status: "cancelled" });
    await assert.rejects(
      () => orderService.updateRestaurantOrderStatus(restaurantId, orderId, "completed"),
      (error) => error.code === "ORDER_STATUS_TRANSITION_INVALID"
    );

    const completed = makeOrder({ status: "completed" });
    Order.findOne = async () => completed;
    const repeated = await orderService.updateRestaurantOrderStatus(
      restaurantId,
      orderId,
      "completed"
    );
    assert.equal(repeated.idempotent, true);
    assert.equal(completed.saveCalls, 0);
  } finally {
    Order.findOne = originalFindOne;
  }
});

test("cross-restaurant order lookup fails without leaking the other tenant", async () => {
  const originalFindOne = Order.findOne;
  let capturedFilter;
  Order.findOne = (filter) => {
    capturedFilter = filter;
    return Promise.resolve(null);
  };

  try {
    const result = await executeAgentTool(
      "confirm_order",
      { orderId },
      { ...context, restaurantId: otherRestaurantId }
    );
    assert.equal(result.success, false);
    assert.equal(result.code, "ORDER_NOT_FOUND");
    assert.equal(String(capturedFilter.restaurantId), otherRestaurantId);
    assert.doesNotMatch(result.message, new RegExp(restaurantId));
  } finally {
    Order.findOne = originalFindOne;
  }
});

test("backend rejects a tool order that differs from the explicit current reference", async () => {
  const originalFindOne = Order.findOne;
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  let mutations = 0;
  Order.findOne = async () => makeOrder({ orderNumber: "ORD-105" });
  Order.findOneAndUpdate = async () => {
    mutations += 1;
    return null;
  };

  try {
    const result = await executeAgentTool(
      "confirm_order",
      { orderId },
      { ...context, originalMessage: "Accept ORD-104" }
    );
    assert.equal(result.success, false);
    assert.equal(result.code, "ORDER_REFERENCE_MISMATCH");
    assert.equal(mutations, 0);
  } finally {
    Order.findOne = originalFindOne;
    Order.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("backend binds short quoted decisions to the restaurant-scoped quoted order", async () => {
  const originalFindOne = Order.findOne;
  let lookup = 0;
  Order.findOne = async (filter) => {
    lookup += 1;
    assert.equal(String(filter.restaurantId), restaurantId);
    return lookup === 1
      ? makeOrder({ _id: "64b000000000000000000105", orderNumber: "ORD-105" })
      : makeOrder({ _id: orderId, orderNumber: "ORD-104" });
  };

  try {
    const result = await executeAgentTool(
      "confirm_order",
      { orderId: "64b000000000000000000105" },
      {
        ...context,
        originalMessage: "accept",
        quotedMessageId: "provider-order-104"
      }
    );
    assert.equal(result.success, false);
    assert.equal(result.code, "ORDER_REFERENCE_MISMATCH");
    assert.equal(lookup, 2);
  } finally {
    Order.findOne = originalFindOne;
  }
});

test("staff prompt forbids invented rejection reasons and false order success", async () => {
  const staffState = {
      pendingActions: [],
      imageWorkflow: null,
      orders: { freshPending: [], recentActive: [] },
      recentReferences: {},
      permissions: ["confirm_order", "reject_order", "update_order_status"]
    };
  const prompt = await buildAgentSystemPrompt(
    restaurant,
    owner,
    staffState.permissions,
    {
      buildRestaurantContext: async () => ({
        restaurant: { id: restaurantId, name: restaurant.name, status: "active" },
        sender: {
          name: owner.name,
          phone: owner.normalizedPhone,
          role: owner.role,
          verified: owner.verified
        },
        people: {},
        settings: {},
        summary: {},
        permissions: staffState.permissions
      }),
      findDraft: async () => null,
      findClarification: async () => null,
      loadCustomerMemory: async () => null
    },
    staffState
  );

  assert.match(prompt, /never invent or substitute a reason/i);
  assert.match(prompt, /never claim an order was accepted, rejected, or completed/i);
  assert.match(prompt, /quotedOrder/i);
});
