const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildStaffOperationalState,
  createEmptyStaffOperationalState,
  staffOperationalStateLimits
} = require("../dist/services/ai/staffOperationalState.service");
const {
  buildAgentSystemPrompt
} = require("../dist/services/ai/agentPrompt.service");
const {
  runAgentOrchestrator
} = require("../dist/services/ai/agentOrchestrator.service");
const {
  handleUnquotedOwnerOrderDecision
} = require("../dist/services/ownerOrderResolution.service");
const { Order } = require("../dist/models/order.model");
const {
  PendingAgentAction
} = require("../dist/models/pendingAgentAction.model");

const restaurantId = "64b000000000000000000001";
const otherRestaurantId = "64b000000000000000000002";
const ownerPhone = "+233507879374";
const managerPhone = "+233241234567";
const now = new Date("2026-08-07T12:00:00.000Z");

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
const manager = {
  name: "Mavis",
  phone: managerPhone,
  normalizedPhone: managerPhone,
  role: "manager",
  verified: true
};

const makeQuery = (records) => ({
  sort() {
    return this;
  },
  limit(limit) {
    return Promise.resolve(records.slice(0, limit));
  }
});

const matchesPendingScope = (record, filter) =>
  String(record.restaurantId) === filter.restaurantId &&
  record.senderPhone === filter.senderPhone &&
  record.senderRole === filter.senderRole &&
  record.status === filter.status &&
  record.expiresAt > filter.expiresAt.$gt;

const makeDependencies = ({ pending = [], orders = [], capture = {} } = {}) => ({
  now: () => now,
  findPendingActions: (filter, projection) => {
    capture.pendingFilter = filter;
    capture.pendingProjection = projection;
    return makeQuery(pending.filter((record) => matchesPendingScope(record, filter)));
  },
  findOrders: (filter, projection) => {
    capture.orderFilters = [...(capture.orderFilters || []), filter];
    capture.orderProjection = projection;
    let matches = orders.filter(
      (record) => String(record.restaurantId) === filter.restaurantId
    );

    if (filter._id?.$in) {
      const ids = new Set(filter._id.$in.map(String));
      matches = matches.filter((record) => ids.has(String(record._id)));
    } else if (filter.ownerNotificationProviderMessageId) {
      matches = matches.filter(
        (record) =>
          record.ownerNotificationProviderMessageId ===
          filter.ownerNotificationProviderMessageId
      );
    } else if (filter.status?.$in) {
      matches = matches.filter((record) => filter.status.$in.includes(record.status));
    }

    if (filter.$or) {
      const cutoff = filter.$or[0].customerConfirmedAt.$gte;
      matches = matches.filter(
        (record) => (record.customerConfirmedAt ?? record.createdAt) >= cutoff
      );
    }

    return makeQuery(matches);
  }
});

const pendingAction = (overrides = {}) => ({
  _id: "64b000000000000000000101",
  restaurantId,
  senderPhone: ownerPhone,
  senderRole: "owner",
  action: "TOOL_CALL",
  toolName: "update_menu_price",
  summary: "Change Chicken Salad from GHS 55 to GHS 65",
  confirmationMessage: "Change Chicken Salad from GHS 55 to GHS 65?",
  data: { itemName: "Chicken Salad", price: 65 },
  status: "pending",
  createdAt: new Date("2026-08-07T11:55:00.000Z"),
  expiresAt: new Date("2026-08-07T12:05:00.000Z"),
  ...overrides
});

const orderRecord = (index, status, overrides = {}) => ({
  _id: `64b0000000000000000002${String(index).padStart(2, "0")}`,
  restaurantId,
  orderNumber: `ORD-${100 + index}`,
  status,
  customerName: `Customer ${index}`,
  total: 50 + index,
  createdAt: new Date(`2026-08-07T11:${String(40 + index).padStart(2, "0")}:00.000Z`),
  customerConfirmedAt: new Date(
    `2026-08-07T11:${String(40 + index).padStart(2, "0")}:00.000Z`
  ),
  ...overrides
});

test("staff pending actions are scoped by restaurant, phone, role, and expiry", async () => {
  const capture = {};
  const valid = pendingAction();
  const second = pendingAction({
    _id: "64b000000000000000000102",
    toolName: "set_item_availability",
    summary: "Mark Chicken Salad unavailable"
  });
  const state = await buildStaffOperationalState(
    { restaurant, sender: owner },
    makeDependencies({
      capture,
      pending: [
        valid,
        second,
        pendingAction({ _id: "other-restaurant", restaurantId: otherRestaurantId }),
        pendingAction({ _id: "other-phone", senderPhone: managerPhone }),
        pendingAction({ _id: "other-role", senderRole: "manager" }),
        pendingAction({
          _id: "expired",
          expiresAt: new Date("2026-08-07T11:59:00.000Z")
        })
      ]
    })
  );

  assert.deepEqual(capture.pendingFilter, {
    restaurantId,
    senderPhone: ownerPhone,
    senderRole: "owner",
    status: "pending",
    expiresAt: { $gt: now }
  });
  assert.deepEqual(
    state.pendingActions.map(({ actionId }) => actionId),
    [String(valid._id), String(second._id)]
  );
  assert.equal(state.pendingActions[0].toolName, "update_menu_price");
  assert.equal(state.pendingActions[0].requiresConfirmation, true);
  assert.equal(capture.pendingProjection.imageSecureUrl, undefined);
  assert.equal(capture.pendingProjection.imagePublicId, undefined);
});

test("manager pending state uses the manager phone and role scope", async () => {
  const capture = {};
  const state = await buildStaffOperationalState(
    { restaurant, sender: manager },
    makeDependencies({
      capture,
      pending: [
        pendingAction({
          _id: "manager-action",
          senderPhone: managerPhone,
          senderRole: "manager",
          toolName: "set_item_availability"
        }),
        pendingAction({ _id: "owner-action" })
      ]
    })
  );

  assert.equal(capture.pendingFilter.senderPhone, managerPhone);
  assert.equal(capture.pendingFilter.senderRole, "manager");
  assert.deepEqual(
    state.pendingActions.map(({ actionId }) => actionId),
    ["manager-action"]
  );
  assert.equal(state.permissions.includes("set_item_availability"), true);
  assert.equal(state.permissions.includes("update_menu_price"), false);
});

test("manager order-selection state is persisted with the manager role", async () => {
  const originalOrderUpdateMany = Order.updateMany;
  const originalOrderFind = Order.find;
  const originalPendingCreate = PendingAgentAction.create;
  const freshDate = new Date();
  const freshOrders = [
    {
      _id: "64b000000000000000000211",
      status: "pending",
      customerName: "Ama",
      items: [{ name: "Chicken Salad" }],
      subtotal: 65,
      createdAt: freshDate,
      customerConfirmedAt: freshDate
    },
    {
      _id: "64b000000000000000000212",
      status: "pending",
      customerName: "Kojo",
      items: [{ name: "Fried Rice" }],
      subtotal: 75,
      createdAt: freshDate,
      customerConfirmedAt: freshDate
    }
  ];
  let createdAction;

  Order.updateMany = async () => ({ modifiedCount: 0 });
  Order.find = () => ({ sort: async () => freshOrders });
  PendingAgentAction.create = async (input) => {
    createdAction = input;
    return { _id: "selection-created", ...input };
  };

  try {
    const result = await handleUnquotedOwnerOrderDecision(
      restaurantId,
      managerPhone,
      "reject",
      "manager"
    );

    assert.equal(result.success, true);
    assert.equal(createdAction.senderPhone, managerPhone);
    assert.equal(createdAction.senderRole, "manager");
    assert.equal(createdAction.action, "OWNER_ORDER_SELECTION");
  } finally {
    Order.updateMany = originalOrderUpdateMany;
    Order.find = originalOrderFind;
    PendingAgentAction.create = originalPendingCreate;
  }
});

test("image workflow normalizes awaiting-image, awaiting-item, and confirmation safely", async () => {
  const cases = [
    {
      action: "MENU_ITEM_IMAGE_CONTEXT",
      data: {
        stage: "awaiting_image",
        itemId: "64b000000000000000000301",
        itemName: "Chicken Salad"
      },
      expected: {
        stage: "awaiting_image",
        imageUploaded: false,
        itemName: "Chicken Salad"
      }
    },
    {
      action: "IMAGE_ASSIGNMENT",
      data: { stage: "awaiting_item" },
      expected: {
        stage: "awaiting_item",
        imageUploaded: true,
        itemName: undefined
      }
    },
    {
      action: "IMAGE_ASSIGNMENT",
      data: { stage: "awaiting_confirmation", itemName: "Chicken Salad" },
      selectedMenuItemId: "64b000000000000000000301",
      expected: {
        stage: "awaiting_confirmation",
        imageUploaded: true,
        itemName: "Chicken Salad"
      }
    }
  ];

  for (const [index, imageCase] of cases.entries()) {
    const state = await buildStaffOperationalState(
      {
        restaurant: {
          ...restaurant,
          wasenderApiToken: "wasender-secret-token",
          webhookSecret: "webhook-secret-value"
        },
        sender: owner
      },
      makeDependencies({
        pending: [
          pendingAction({
            _id: `image-${index}`,
            ...imageCase,
            data: {
              ...imageCase.data,
              rawWebhookPayload: "raw-webhook-secret",
              databaseUrl: "mongodb://secret-connection"
            },
            imageSecureUrl: "https://res.cloudinary.com/secret-image.jpg",
            imagePublicId: "private/image-id"
          })
        ]
      })
    );

    assert.equal(state.imageWorkflow.stage, imageCase.expected.stage);
    assert.equal(
      state.imageWorkflow.imageUploaded,
      imageCase.expected.imageUploaded
    );
    assert.equal(state.imageWorkflow.itemName, imageCase.expected.itemName);
    const serialized = JSON.stringify(state);
    assert.equal(serialized.includes("res.cloudinary.com"), false);
    assert.equal(serialized.includes("private/image-id"), false);
    assert.equal(serialized.includes("wasender-secret-token"), false);
    assert.equal(serialized.includes("webhook-secret-value"), false);
    assert.equal(serialized.includes("raw-webhook-secret"), false);
    assert.equal(serialized.includes("mongodb://secret-connection"), false);
    assert.equal(serialized.includes("imageSecureUrl"), false);
    assert.equal(serialized.includes("imagePublicId"), false);
  }
});

test("order context and order-selection references are restaurant-scoped and bounded", async () => {
  const fresh = Array.from({ length: 7 }, (_, index) =>
    orderRecord(index + 1, "pending")
  );
  const active = Array.from({ length: 7 }, (_, index) =>
    orderRecord(index + 11, "preparing")
  );
  const selection = pendingAction({
    _id: "selection-action",
    action: "OWNER_ORDER_SELECTION",
    toolName: undefined,
    data: {
      decision: "reject",
      orderIds: [String(fresh[0]._id), String(fresh[1]._id)]
    }
  });
  const capture = {};
  const state = await buildStaffOperationalState(
    { restaurant, sender: owner },
    makeDependencies({
      capture,
      pending: [selection],
      orders: [
        ...fresh,
        ...active,
        orderRecord(99, "pending", { restaurantId: otherRestaurantId })
      ]
    })
  );

  assert.equal(
    state.orders.freshPending.length,
    staffOperationalStateLimits.freshPendingOrders
  );
  assert.equal(
    state.orders.recentActive.length,
    staffOperationalStateLimits.recentActiveOrders
  );
  assert.deepEqual(
    state.recentReferences.orderSelection.candidates.map(
      ({ position, orderNumber }) => ({ position, orderNumber })
    ),
    [
      { position: 1, orderNumber: "ORD-101" },
      { position: 2, orderNumber: "ORD-102" }
    ]
  );
  assert.equal(
    capture.orderFilters.every((filter) => filter.restaurantId === restaurantId),
    true
  );
  assert.equal(state.permissions.includes("confirm_order"), true);
  assert.equal(state.permissions.includes("update_menu_price"), true);
});

test("quoted order reference resolves the trusted provider relationship within the restaurant", async () => {
  const quotedMessageId = "provider-message-for-ord-102";
  const orders = [
    orderRecord(1, "pending"),
    orderRecord(2, "pending", {
      ownerNotificationProviderMessageId: quotedMessageId
    }),
    orderRecord(3, "pending")
  ];
  const capture = {};
  const state = await buildStaffOperationalState(
    { restaurant, sender: owner, quotedMessageId },
    makeDependencies({ capture, orders })
  );

  assert.equal(state.orders.freshPending.length, 3);
  assert.deepEqual(state.recentReferences.quotedOrder, {
    id: String(orders[1]._id),
    orderNumber: "ORD-102",
    status: "pending",
    customerName: "Customer 2",
    total: 52,
    createdAt: orders[1].createdAt.toISOString()
  });
  assert.equal(
    capture.orderFilters.every((filter) => filter.restaurantId === restaurantId),
    true
  );
  assert.equal(
    capture.orderFilters.some(
      (filter) => filter.ownerNotificationProviderMessageId === quotedMessageId
    ),
    true
  );
  assert.equal(capture.orderProjection.ownerNotificationProviderMessageId, undefined);
  assert.equal(JSON.stringify(state).includes(quotedMessageId), false);
});

test("quoted order reference never crosses restaurant boundaries", async () => {
  const quotedMessageId = "provider-message-from-other-restaurant";
  const state = await buildStaffOperationalState(
    { restaurant, sender: owner, quotedMessageId },
    makeDependencies({
      orders: [
        orderRecord(2, "pending", {
          restaurantId: otherRestaurantId,
          ownerNotificationProviderMessageId: quotedMessageId
        })
      ]
    })
  );

  assert.equal(state.recentReferences.quotedOrder, undefined);
});

test("missing or unknown quoted IDs produce no quoted order reference", async () => {
  const orders = [
    orderRecord(2, "pending", {
      ownerNotificationProviderMessageId: "known-provider-message"
    })
  ];
  const withoutQuote = await buildStaffOperationalState(
    { restaurant, sender: owner },
    makeDependencies({ orders })
  );
  const withUnknownQuote = await buildStaffOperationalState(
    { restaurant, sender: owner, quotedMessageId: "unknown-provider-message" },
    makeDependencies({ orders })
  );

  assert.equal(withoutQuote.recentReferences.quotedOrder, undefined);
  assert.equal(withUnknownQuote.recentReferences.quotedOrder, undefined);
});

test("fresh pending state includes actionable orders with missing or null confirmation time", async () => {
  const capture = {};
  const missingConfirmation = orderRecord(1, "pending");
  delete missingConfirmation.customerConfirmedAt;
  const nullConfirmation = orderRecord(2, "pending", {
    customerConfirmedAt: null
  });
  const staleNullConfirmation = orderRecord(3, "pending", {
    customerConfirmedAt: null,
    createdAt: new Date("2026-08-07T10:00:00.000Z")
  });
  const state = await buildStaffOperationalState(
    { restaurant, sender: owner },
    makeDependencies({
      capture,
      orders: [missingConfirmation, nullConfirmation, staleNullConfirmation]
    })
  );

  assert.deepEqual(
    state.orders.freshPending.map(({ orderNumber }) => orderNumber),
    ["ORD-101", "ORD-102"]
  );
  const freshFilter = capture.orderFilters.find((filter) => filter.$or);
  assert.deepEqual(freshFilter.$or[1], {
    customerConfirmedAt: null,
    createdAt: { $gte: new Date("2026-08-07T11:00:00.000Z") }
  });
});

test("empty staff state remains safe and permission-aware after loading failure", () => {
  const state = createEmptyStaffOperationalState("manager");

  assert.deepEqual(state.pendingActions, []);
  assert.equal(state.imageWorkflow, null);
  assert.deepEqual(state.orders, { freshPending: [], recentActive: [] });
  assert.equal(state.permissions.includes("confirm_order"), true);
  assert.equal(state.permissions.includes("update_menu_price"), false);
});

const promptContext = (sender, permissions) => ({
  restaurant: {
    id: restaurantId,
    name: restaurant.name,
    status: "active"
  },
  sender: {
    name: sender.name,
    phone: sender.normalizedPhone,
    role: sender.role,
    verified: sender.verified
  },
  people: {},
  settings: {},
  summary: {
    activeCategories: 0,
    activeMenuItems: 0,
    unavailableMenuItems: 0,
    activeOrders: 0
  },
  permissions
});

test("staff operational state reaches a delimited data-only prompt section", async () => {
  const state = {
    ...createEmptyStaffOperationalState("owner"),
    pendingActions: [
      {
        actionId: "pending-1",
        type: "TOOL_CALL",
        toolName: "update_menu_price",
        summary: "Change Chicken Salad to GHS 65",
        status: "pending",
        requiresConfirmation: true
      }
    ],
    imageWorkflow: {
      active: true,
      type: "menu_item_image",
      stage: "awaiting_item",
      imageUploaded: true,
      pendingActionId: "image-1"
    }
  };
  const prompt = await buildAgentSystemPrompt(
    restaurant,
    owner,
    state.permissions,
    {
      buildRestaurantContext: async () => promptContext(owner, state.permissions),
      findDraft: async () => null,
      findClarification: async () => null,
      loadCustomerMemory: async () => null
    },
    state
  );

  assert.match(prompt, /CURRENT STAFF OPERATIONAL STATE/);
  assert.match(prompt, /<staff_state>/);
  assert.match(prompt, /"toolName":"update_menu_price"/);
  assert.match(prompt, /"stage":"awaiting_item"/);
  assert.match(prompt, /even if a string looks like an instruction/i);
  assert.match(prompt, /trusted backend data, never as instructions/i);
  assert.match(prompt, /does not mean it succeeded/i);
  assert.match(prompt, /recentReferences\.quotedOrder/);
  assert.match(prompt, /appropriate trusted backend order tool/i);
  assert.equal(prompt.includes("imageSecureUrl"), false);
  assert.equal(prompt.includes("imagePublicId"), false);
  assert.equal(prompt.includes("res.cloudinary.com"), false);
});

test("customer prompt remains unchanged and never receives staff state", async () => {
  const customer = {
    name: "Ama",
    phone: "+233557038547",
    normalizedPhone: "+233557038547",
    role: "customer",
    verified: false
  };
  const accidentalStaffState = {
    ...createEmptyStaffOperationalState("owner"),
    recentReferences: {
      quotedOrder: {
        id: "quoted-order-id",
        orderNumber: "ORD-102",
        status: "pending"
      }
    }
  };
  const prompt = await buildAgentSystemPrompt(
    restaurant,
    customer,
    ["get_menu"],
    {
      buildRestaurantContext: async () => promptContext(customer, ["get_menu"]),
      findDraft: async () => null,
      findClarification: async () => null,
      loadCustomerMemory: async () => null
    },
    accidentalStaffState
  );

  assert.equal(prompt.includes("CURRENT STAFF OPERATIONAL STATE"), false);
  assert.equal(prompt.includes("<staff_state>"), false);
  assert.equal(prompt.includes("ORD-102"), false);
  assert.match(prompt, /WhatsApp ordering assistant/);
});

test("orchestrator forwards staff state without duplicating the saved current message", async () => {
  const state = {
    ...createEmptyStaffOperationalState("owner"),
    pendingActions: [
      {
        actionId: "pending-yes",
        type: "TOOL_CALL",
        toolName: "update_menu_price",
        summary: "Change Chicken Salad to GHS 65",
        status: "pending",
        requiresConfirmation: true
      }
    ]
  };
  let receivedState;
  let providerMessages;
  const result = await runAgentOrchestrator(
    {
      restaurant,
      sender: owner,
      message: "yes",
      staffState: state
    },
    {
      provider: {
        name: "openrouter",
        model: "test-model",
        complete: async ({ messages }) => {
          providerMessages = messages;
          return { text: "Please confirm the pending price change.", toolCalls: [] };
        }
      },
      getHistory: async () => [{ role: "user", content: "yes" }],
      saveMessage: async () => {},
      buildSystemPrompt: async (_restaurant, _sender, _permissions, _deps, staffState) => {
        receivedState = staffState;
        return `<staff_state>${JSON.stringify(staffState)}</staff_state>`;
      }
    }
  );

  assert.equal(result.success, true);
  assert.deepEqual(receivedState, state);
  assert.equal(
    providerMessages.filter(
      ({ role, content }) => role === "user" && content === "yes"
    ).length,
    1
  );
  assert.match(providerMessages[0].content, /pending-yes/);
});
