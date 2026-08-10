const assert = require("node:assert/strict");
const test = require("node:test");
const { Types } = require("mongoose");

const {
  rememberConfirmedCustomerName
} = require("../dist/services/customerProfile.service");
const {
  loadCustomerMemorySummary
} = require("../dist/services/customerMemory.service");
const {
  submitOrderDraft
} = require("../dist/services/orderDraft.service");
const {
  CustomerProfile
} = require("../dist/models/customerProfile.model");
const {
  CustomerSession
} = require("../dist/models/customerSession.model");
const { Order } = require("../dist/models/order.model");
const orderService = require("../dist/services/order.service");
const {
  executeAgentTool
} = require("../dist/agent-tools/tool.executor");

const restaurantId = "64b000000000000000000001";
const customerPhone = "+233557038547";
const customerName = "Rebecca Lina Santa Maria";

const createProfile = (overrides = {}) => ({
  restaurantId,
  customerPhone,
  customerName: undefined,
  customerNameSource: undefined,
  orderCount: 0,
  averageOrderValue: 0,
  frequentlyOrderedItems: [],
  commonDeliveryAddresses: [],
  dietaryPreferences: [],
  isOptedOut: false,
  saveCalls: 0,
  async save() {
    this.saveCalls += 1;
    return this;
  },
  ...overrides
});

const createReadyDraft = (overrides = {}) => ({
  _id: new Types.ObjectId(),
  restaurantId: new Types.ObjectId(restaurantId),
  customerPhone,
  customerName,
  cartItems: [
    {
      menuItemId: new Types.ObjectId("64b000000000000000000101"),
      name: "Jollof Rice",
      quantity: 1,
      unitPrice: 30,
      totalPrice: 30
    }
  ],
  currentStep: "confirming_order",
  orderType: "pickup",
  deliveryFee: 0,
  deliveryFeeSource: "pickup",
  deliveryFeeResolved: true,
  conversationVersion: 1,
  expiresAt: new Date(Date.now() + 60_000),
  saveCalls: 0,
  async save() {
    this.saveCalls += 1;
    return this;
  },
  ...overrides
});

test("confirmed customer names are normalized without changing profile analytics", async () => {
  const originalFindOne = CustomerProfile.findOne;
  const originalCreate = CustomerProfile.create;
  let createInput;

  CustomerProfile.findOne = async () => null;
  CustomerProfile.create = async (input) => {
    createInput = input;
    return createProfile(input);
  };

  try {
    const profile = await rememberConfirmedCustomerName(
      restaurantId,
      "0557038547",
      "  Rebecca   Lina  Santa Maria  "
    );

    assert.deepEqual(createInput, {
      restaurantId,
      customerPhone,
      customerName,
      customerNameSource: "customer_confirmed"
    });
    assert.equal(profile.customerName, customerName);
    assert.equal(profile.customerNameSource, "customer_confirmed");
    assert.equal(Object.hasOwn(createInput, "orderCount"), false);
    assert.equal(Object.hasOwn(createInput, "averageOrderValue"), false);
    assert.equal(Object.hasOwn(createInput, "lastOrderAt"), false);
    assert.equal(Object.hasOwn(createInput, "frequentlyOrderedItems"), false);
    assert.equal(Object.hasOwn(createInput, "preferredOrderType"), false);
  } finally {
    CustomerProfile.findOne = originalFindOne;
    CustomerProfile.create = originalCreate;
  }
});

test("confirmed names are protected and completed-order names are upgraded", async () => {
  const originalFindOne = CustomerProfile.findOne;
  const protectedProfile = createProfile({
    customerName: "Rebecca",
    customerNameSource: "customer_confirmed"
  });
  const completedOrderProfile = createProfile({
    customerName: "Rebecca",
    customerNameSource: "completed_order"
  });

  try {
    CustomerProfile.findOne = async () => protectedProfile;
    const unchanged = await rememberConfirmedCustomerName(
      restaurantId,
      customerPhone,
      "Different Name"
    );

    assert.equal(unchanged.customerName, "Rebecca");
    assert.equal(unchanged.customerNameSource, "customer_confirmed");
    assert.equal(unchanged.saveCalls, 0);

    CustomerProfile.findOne = async () => completedOrderProfile;
    const upgraded = await rememberConfirmedCustomerName(
      restaurantId,
      customerPhone,
      "  Rebecca   Lina  Santa Maria "
    );

    assert.equal(upgraded.customerName, customerName);
    assert.equal(upgraded.customerNameSource, "customer_confirmed");
    assert.equal(upgraded.saveCalls, 1);
    assert.equal(upgraded.orderCount, 0);
    assert.equal(upgraded.averageOrderValue, 0);
  } finally {
    CustomerProfile.findOne = originalFindOne;
  }
});

test("blank and placeholder names are never persisted", async () => {
  const originalFindOne = CustomerProfile.findOne;
  let profileQueries = 0;

  CustomerProfile.findOne = async () => {
    profileQueries += 1;
    return null;
  };

  try {
    for (const name of ["", "   ", "Customer", "user", " Guest ", "UNKNOWN", "N/A"]) {
      await assert.rejects(
        rememberConfirmedCustomerName(restaurantId, customerPhone, name),
        /valid customer name/
      );
    }

    assert.equal(profileQueries, 0);
  } finally {
    CustomerProfile.findOne = originalFindOne;
  }
});

test("successful draft submission immediately persists the name for the next-turn memory", async () => {
  const originalSessionFindOne = CustomerSession.findOne;
  const originalProfileFindOne = CustomerProfile.findOne;
  const originalProfileCreate = CustomerProfile.create;
  const originalOrderFind = Order.find;
  const draft = createReadyDraft();
  let persistedProfile;
  let createOrderInput;

  CustomerSession.findOne = async () => draft;
  CustomerProfile.findOne = async () => null;
  CustomerProfile.create = async (input) => {
    persistedProfile = createProfile(input);
    return persistedProfile;
  };

  try {
    const result = await submitOrderDraft(
      { _id: new Types.ObjectId(restaurantId) },
      customerPhone,
      {
        createOrder: async (_scopedRestaurantId, input) => {
          createOrderInput = input;
          return {
            _id: new Types.ObjectId("64b000000000000000000201"),
            restaurantId: new Types.ObjectId(restaurantId),
            customerPhone,
            customerName: input.customerName
          };
        },
        rememberCustomerName: rememberConfirmedCustomerName
      }
    );

    assert.equal(result.idempotent, false);
    assert.equal(createOrderInput.customerName, customerName);
    assert.equal(result.order.customerName, customerName);
    assert.equal(persistedProfile.customerName, customerName);
    assert.equal(persistedProfile.customerNameSource, "customer_confirmed");
    assert.equal(persistedProfile.orderCount, 0);
    assert.equal(persistedProfile.averageOrderValue, 0);
    assert.ok(draft.convertedOrderId);
    assert.equal(draft.customerName, undefined);

    CustomerProfile.findOne = (filter) => ({
      select: async () => {
        assert.deepEqual(filter, {
          restaurantId,
          customerPhone
        });
        return persistedProfile;
      }
    });
    Order.find = () => ({
      select() {
        return this;
      },
      sort() {
        return this;
      },
      async limit() {
        return [];
      }
    });

    const nextTurnMemory = await loadCustomerMemorySummary(
      restaurantId,
      customerPhone
    );

    assert.deepEqual(nextTurnMemory, { name: customerName });
  } finally {
    CustomerSession.findOne = originalSessionFindOne;
    CustomerProfile.findOne = originalProfileFindOne;
    CustomerProfile.create = originalProfileCreate;
    Order.find = originalOrderFind;
  }
});

test("failed draft submissions do not persist a customer name", async () => {
  const originalSessionFindOne = CustomerSession.findOne;
  let rememberCalls = 0;
  let createCalls = 0;

  try {
    CustomerSession.findOne = async () => createReadyDraft({
      customerName: undefined
    });

    await assert.rejects(
      submitOrderDraft(
        { _id: new Types.ObjectId(restaurantId) },
        customerPhone,
        {
          createOrder: async () => {
            createCalls += 1;
          },
          rememberCustomerName: async () => {
            rememberCalls += 1;
          }
        }
      ),
      /customerName/
    );

    assert.equal(createCalls, 0);
    assert.equal(rememberCalls, 0);

    CustomerSession.findOne = async () => createReadyDraft();
    await assert.rejects(
      submitOrderDraft(
        { _id: new Types.ObjectId(restaurantId) },
        customerPhone,
        {
          createOrder: async () => {
            createCalls += 1;
            throw new Error("order write failed");
          },
          rememberCustomerName: async () => {
            rememberCalls += 1;
          }
        }
      ),
      /order write failed/
    );

    assert.equal(createCalls, 1);
    assert.equal(rememberCalls, 0);
  } finally {
    CustomerSession.findOne = originalSessionFindOne;
  }
});

test("new order submission succeeds when customer-name persistence fails", async () => {
  const originalSessionFindOne = CustomerSession.findOne;
  const originalConsoleError = console.error;
  const draft = createReadyDraft();
  const createdOrder = {
    _id: new Types.ObjectId("64b000000000000000000202"),
    restaurantId: new Types.ObjectId(restaurantId),
    customerPhone,
    customerName
  };
  let createCalls = 0;
  const persistenceLogs = [];

  CustomerSession.findOne = async () => draft;
  console.error = (...args) => {
    persistenceLogs.push(args);
  };

  try {
    const result = await submitOrderDraft(
      { _id: new Types.ObjectId(restaurantId) },
      customerPhone,
      {
        createOrder: async () => {
          createCalls += 1;
          return createdOrder;
        },
        rememberCustomerName: async () => {
          throw new Error("profile unavailable");
        }
      }
    );

    assert.equal(result.idempotent, false);
    assert.equal(result.order, createdOrder);
    assert.equal(String(draft.convertedOrderId), String(createdOrder._id));
    assert.equal(createCalls, 1);
    assert.deepEqual(persistenceLogs, [
      [
        "Customer name persistence failed",
        {
          restaurantId,
          orderId: String(createdOrder._id)
        }
      ]
    ]);
  } finally {
    CustomerSession.findOne = originalSessionFindOne;
    console.error = originalConsoleError;
  }
});

test("idempotent submission succeeds when customer-name persistence fails", async () => {
  const originalSessionFindOne = CustomerSession.findOne;
  const originalOrderFindOne = Order.findOne;
  const originalConsoleError = console.error;
  const existingOrder = {
    _id: new Types.ObjectId("64b000000000000000000203"),
    restaurantId: new Types.ObjectId(restaurantId),
    customerPhone,
    customerName
  };
  const draft = createReadyDraft({
    customerName: undefined,
    convertedOrderId: existingOrder._id,
    convertedAt: new Date()
  });
  let createCalls = 0;
  let rememberCalls = 0;

  CustomerSession.findOne = async () => draft;
  Order.findOne = async () => existingOrder;
  console.error = () => undefined;

  try {
    const result = await submitOrderDraft(
      { _id: new Types.ObjectId(restaurantId) },
      customerPhone,
      {
        createOrder: async () => {
          createCalls += 1;
        },
        rememberCustomerName: async () => {
          rememberCalls += 1;
          throw new Error("profile unavailable");
        }
      }
    );

    assert.equal(result.idempotent, true);
    assert.equal(result.order, existingOrder);
    assert.equal(createCalls, 0);
    assert.equal(rememberCalls, 1);
  } finally {
    CustomerSession.findOne = originalSessionFindOne;
    Order.findOne = originalOrderFindOne;
    console.error = originalConsoleError;
  }
});

test("confirm_order_draft preserves submission and owner notification when name persistence fails", async () => {
  const originalSessionFindOne = CustomerSession.findOne;
  const originalProfileFindOne = CustomerProfile.findOne;
  const originalCreateOrder = orderService.createOrder;
  const originalConsoleError = console.error;
  const draft = createReadyDraft();
  const createdOrder = {
    _id: new Types.ObjectId("64b000000000000000000204"),
    restaurantId: new Types.ObjectId(restaurantId),
    orderNumber: "ORD-204",
    customerPhone,
    customerName,
    status: "awaiting_restaurant_confirmation",
    orderType: "pickup",
    subtotal: 30,
    deliveryFee: 0,
    total: 30,
    createdAt: new Date(),
    feedbackFollowUpStatus: "not_scheduled",
    items: [
      {
        name: "Jollof Rice",
        quantity: 1,
        unitPrice: 30,
        totalPrice: 30
      }
    ]
  };
  let createCalls = 0;

  CustomerSession.findOne = async () => draft;
  CustomerProfile.findOne = async () => {
    throw new Error("profile unavailable");
  };
  orderService.createOrder = async () => {
    createCalls += 1;
    return createdOrder;
  };
  console.error = () => undefined;

  try {
    const result = await executeAgentTool(
      "confirm_order_draft",
      {},
      {
        restaurantId,
        restaurant: {
          _id: new Types.ObjectId(restaurantId),
          name: "Golden Spoon"
        },
        sender: {
          role: "customer",
          phone: customerPhone,
          normalizedPhone: customerPhone,
          verified: false
        },
        originalMessage: "Yes, submit it"
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.data.orderSubmitted, true);
    assert.equal(result.data.notifyOwner, true);
    assert.equal(result.data.idempotent, false);
    assert.equal(result.data.order.id, String(createdOrder._id));
    assert.equal(createCalls, 1);
    assert.equal(String(draft.convertedOrderId), String(createdOrder._id));
  } finally {
    CustomerSession.findOne = originalSessionFindOne;
    CustomerProfile.findOne = originalProfileFindOne;
    orderService.createOrder = originalCreateOrder;
    console.error = originalConsoleError;
  }
});
