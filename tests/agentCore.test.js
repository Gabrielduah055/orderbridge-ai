const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveSenderIdentity } = require("../dist/services/senderIdentity.service");
const {
  isToolAllowedForRole,
  getAllowedToolNamesForRole
} = require("../dist/agent-tools/tool.permissions");
const {
  buildHermesSessionKey,
  sendHermesAgentMessage
} = require("../dist/services/hermesAgent.service");
const {
  handleMcpRequest,
  isMcpBearerTokenAuthorized,
  mcpTools
} = require("../dist/controllers/mcp.controller");
const {
  runAgentOrchestrator
} = require("../dist/services/ai/agentOrchestrator.service");
const {
  OpenRouterProvider
} = require("../dist/services/ai/providers/openRouter.provider");
const {
  getAgentToolDefinitionsForRole
} = require("../dist/services/ai/agentToolDefinitions.service");
const {
  validateSelectedAiProviderConfig
} = require("../dist/services/ai/ai.config");
const {
  resolveDeliveryFee,
  isPendingOrderActionable,
  formatRelativeOrderAge
} = require("../dist/services/order.service");
const {
  buildCompletedOrderProfileStats,
  updateConfirmedCustomerPreferences,
  updateCustomerProfileFromCompletedOrder
} = require("../dist/services/customerProfile.service");
const {
  CustomerProfile
} = require("../dist/models/customerProfile.model");
const {
  Order
} = require("../dist/models/order.model");
const {
  updateCustomerPreferencesSchema
} = require("../dist/middleware/validateRequest");
const {
  getNextSessionSendAt,
  getWasenderRetryDelayMs,
  isQueuedConversationalMessageStale
} = require("../dist/services/wasenderQueue.service");
const {
  parseExplicitQuantity,
  parseQuantityCorrection,
  getMissingDraftFields,
  getDraftMissingFieldCode,
  buildDraftView,
  buildStateAwareFollowUpMessage,
  resolveTrustedQuantity,
  addItemToDraft,
  getCartItemDisplayName,
  getMenuItemDisplayName,
  isOnlyThatCompletionMessage,
  updateRecentCartItemQuantity
} = require("../dist/services/orderDraft.service");
const {
  normalizeIncomingWebhook,
  extractWasenderProviderMessageId
} = require("../dist/services/wasender.service");
const {
  buildClarificationCandidate,
  resolveOrderItemClarification
} = require("../dist/services/agentClarification.service");
const {
  addPendingItemToDraft
} = require("../dist/services/orderDraft.service");
const { MenuItem } = require("../dist/models/MenuItem");
const { AgentClarification } = require("../dist/models/agentClarification.model");
const {
  buildOwnerNewOrderNotification,
  buildCustomerOrderConfirmedMessage,
  buildCustomerOrderRejectedMessage
} = require("../dist/services/orderSideEffects.service");
const {
  isPendingActionConfirmationMessage,
  isPendingActionCancellationMessage,
  shouldUseOpenRouterCustomerAgent
} = require("../dist/services/restaurantAgent.service");
const {
  parseSimpleOwnerDecision,
  parseOwnerSelectionReply,
  buildOwnerSelectionMessage
} = require("../dist/services/ownerOrderResolution.service");

const restaurant = {
  ownerName: "Gabriel",
  ownerPhone: "+233507879374",
  managerPhones: ["0507879375"],
  managerContacts: [{ name: "Ama", phone: "233507879376" }]
};

test("owner number resolves to owner", () => {
  const sender = resolveSenderIdentity(restaurant, "0507879374");

  assert.equal(sender.role, "owner");
  assert.equal(sender.verified, true);
  assert.equal(sender.name, "Gabriel");
  assert.equal(sender.normalizedPhone, "+233507879374");
});

test("manager number resolves to manager from managerPhones", () => {
  const sender = resolveSenderIdentity(restaurant, "+233507879375");

  assert.equal(sender.role, "manager");
  assert.equal(sender.verified, true);
});

test("manager number resolves to manager from managerContacts", () => {
  const sender = resolveSenderIdentity(restaurant, "0507879376");

  assert.equal(sender.role, "manager");
  assert.equal(sender.verified, true);
  assert.equal(sender.name, "Ama");
});

test("unknown number resolves to customer", () => {
  const sender = resolveSenderIdentity(restaurant, "233557038547");

  assert.equal(sender.role, "customer");
  assert.equal(sender.verified, false);
  assert.equal(sender.normalizedPhone, "+233557038547");
});

test("customers and managers cannot update menu prices", () => {
  assert.equal(isToolAllowedForRole("update_menu_price", "customer"), false);
  assert.equal(isToolAllowedForRole("update_menu_price", "manager"), false);
});

test("owner can prepare a menu price update", () => {
  assert.equal(isToolAllowedForRole("update_menu_price", "owner"), true);
});

test("only owner can add menu items through tools", () => {
  assert.equal(isToolAllowedForRole("add_menu_items", "owner"), true);
  assert.equal(isToolAllowedForRole("add_menu_items", "manager"), false);
  assert.equal(isToolAllowedForRole("add_menu_items", "customer"), false);
});

test("customer ordering uses draft tools instead of raw create order", () => {
  assert.equal(isToolAllowedForRole("create_order", "customer"), false);
  assert.equal(isToolAllowedForRole("start_order", "customer"), true);
  assert.equal(isToolAllowedForRole("add_order_item_by_name", "customer"), true);
  assert.equal(isToolAllowedForRole("update_order_draft", "customer"), true);
  assert.equal(isToolAllowedForRole("confirm_order_draft", "customer"), true);
});

test("explicit quantity parser does not infer quantity from item name alone", () => {
  assert.equal(parseExplicitQuantity("I want assorted fried rice"), null);
  assert.equal(parseExplicitQuantity("I want two assorted fried rice"), 2);
  assert.equal(parseExplicitQuantity("I want a plate of jollof"), 1);
  assert.equal(parseExplicitQuantity("Make it 3"), 3);
  assert.equal(parseExplicitQuantity("Add another one"), null);
  assert.equal(parseExplicitQuantity("that one"), null);
  assert.equal(parseExplicitQuantity("I will go for the GHS 60 package"), null);
  assert.equal(parseExplicitQuantity("2 portions"), 2);
});

test("clarification candidates preserve category context", () => {
  const candidate = buildClarificationCandidate({
    menuItemId: "64b000000000000000000301",
    name: "Chicken Spaghetti",
    categoryId: "64b000000000000000000401",
    categoryName: "Spaghetti",
    price: 45,
    available: true
  });

  assert.equal(String(candidate.menuItemId), "64b000000000000000000301");
  assert.equal(String(candidate.categoryId), "64b000000000000000000401");
  assert.equal(candidate.categoryName, "Spaghetti");
  assert.equal(candidate.available, true);
});

test("with chicken resolves active Spaghetti clarification without Chicken Noodles", async () => {
  const clarification = {
    candidates: [
      {
        menuItemId: "64b000000000000000000301",
        name: "Crave Special Spaghetti",
        categoryId: "64b000000000000000000401",
        categoryName: "Spaghetti",
        price: 60,
        available: true
      },
      {
        menuItemId: "64b000000000000000000302",
        name: "Beef Spaghetti",
        categoryId: "64b000000000000000000401",
        categoryName: "Spaghetti",
        price: 50,
        available: true
      },
      {
        menuItemId: "64b000000000000000000303",
        name: "Chicken Spaghetti",
        categoryId: "64b000000000000000000401",
        categoryName: "Spaghetti",
        price: 45,
        available: true
      }
    ],
    save: async () => {}
  };

  const resolved = await resolveOrderItemClarification(clarification, "With chicken");

  assert.equal(resolved.status, "matched");
  assert.equal(resolved.candidate.name, "Chicken Spaghetti");
  assert.notEqual(resolved.candidate.name, "Chicken Noodles");
  assert.equal(resolved.quantity, undefined);
  assert.equal(clarification.status, "resolved");
});

test("yes confirms a single clarified item but does not create quantity 1", async () => {
  const clarification = {
    candidates: [
      {
        menuItemId: "64b000000000000000000303",
        name: "Chicken Spaghetti",
        categoryId: "64b000000000000000000401",
        categoryName: "Spaghetti",
        price: 45,
        available: true
      }
    ],
    save: async () => {}
  };

  const resolved = await resolveOrderItemClarification(
    clarification,
    "Yes, that is what I mean"
  );

  assert.equal(resolved.status, "matched");
  assert.equal(resolved.candidate.name, "Chicken Spaghetti");
  assert.equal(resolved.quantity, undefined);
  assert.equal(parseExplicitQuantity("Yes, that is what I mean"), null);
});

test("one explicit quantity adds the pending clarified item and clears it", async () => {
  const originalFindOne = MenuItem.findOne;
  const originalUpdateMany = AgentClarification.updateMany;
  const session = {
    pendingMenuItemId: "64b000000000000000000303",
    pendingMenuItemName: "Chicken Spaghetti",
    cartItems: [],
    currentStep: "collecting_quantity"
  };

  MenuItem.findOne = async () => ({
    _id: "64b000000000000000000303",
    name: "Chicken Spaghetti",
    price: 45,
    isAvailable: true
  });
  AgentClarification.updateMany = async () => ({ modifiedCount: 0 });

  try {
    const message = await addPendingItemToDraft(session, "64b000000000000000000001", 1);

    assert.equal(message, "Added 1 x Chicken Spaghetti to the order draft.");
    assert.equal(session.cartItems.length, 1);
    assert.equal(session.cartItems[0].quantity, 1);
    assert.equal(session.pendingMenuItemId, undefined);
    assert.equal(session.currentStep, "choosing_items");
  } finally {
    MenuItem.findOne = originalFindOne;
    AgentClarification.updateMany = originalUpdateMany;
  }
});

test("raw item names keep full category display identity in the draft", () => {
  const item = {
    _id: "64b000000000000000000303",
    name: "Chicken",
    categoryId: "64b000000000000000000401",
    categoryName: "Spaghetti",
    price: 45,
    isAvailable: true
  };
  const session = {
    cartItems: [],
    deliveryFeeResolved: false
  };

  addItemToDraft(session, item, 2);
  const view = buildDraftView(session, {});

  assert.equal(getMenuItemDisplayName(item, "Spaghetti"), "Chicken Spaghetti");
  assert.equal(session.cartItems.length, 1);
  assert.equal(session.cartItems[0].name, "Chicken");
  assert.equal(session.cartItems[0].categoryName, "Spaghetti");
  assert.equal(session.cartItems[0].displayName, "Chicken Spaghetti");
  assert.equal(getCartItemDisplayName(session.cartItems[0]), "Chicken Spaghetti");
  assert.equal(view.items[0].name, "Chicken Spaghetti");
  assert.equal(view.items[0].rawName, "Chicken");
});

test("recent quantity correction updates one cart item instead of adding another", () => {
  const session = {
    cartItems: [],
    deliveryFeeResolved: false
  };
  const item = {
    _id: "64b000000000000000000303",
    name: "Chicken",
    categoryId: "64b000000000000000000401",
    categoryName: "Spaghetti",
    price: 45,
    isAvailable: true
  };

  addItemToDraft(session, item, 2);

  assert.equal(parseQuantityCorrection("Oh no make it 5"), 5);

  const result = updateRecentCartItemQuantity(session, 5);

  assert.equal(result.status, "updated");
  assert.equal(result.message, "Updated Chicken Spaghetti from 2 portions to 5 portions.");
  assert.equal(session.cartItems.length, 1);
  assert.equal(session.cartItems[0].quantity, 5);
  assert.equal(session.cartItems[0].totalPrice, 225);
  assert.equal(session.lastModifiedPreviousQuantity, 2);
  assert.equal(session.lastModifiedCurrentQuantity, 5);
});

test("quantity correction without a safe recent item asks which item to change", () => {
  const session = {
    cartItems: [],
    deliveryFeeResolved: false
  };

  const result = updateRecentCartItemQuantity(session, 5);

  assert.equal(result.status, "needs_item");
  assert.equal(result.message, "Which item would you like me to change?");
});

test("stale recent item quantity correction is not applied", () => {
  const session = {
    cartItems: [
      {
        menuItemId: "64b000000000000000000303",
        name: "Chicken",
        categoryName: "Spaghetti",
        displayName: "Chicken Spaghetti",
        quantity: 2,
        unitPrice: 45,
        totalPrice: 90
      }
    ],
    lastModifiedMenuItemId: "64b000000000000000000303",
    lastModifiedAt: new Date("2026-07-28T12:00:00.000Z"),
    deliveryFeeResolved: false
  };

  const result = updateRecentCartItemQuantity(session, 5, new Date("2026-07-28T12:06:00.000Z"));

  assert.equal(result.status, "needs_item");
  assert.equal(result.message, "Which item would you like me to change?");
  assert.equal(session.cartItems[0].quantity, 2);
});

test("only-that completion intents are not menu item requests", () => {
  assert.equal(isOnlyThatCompletionMessage("I want only that"), true);
  assert.equal(isOnlyThatCompletionMessage("that's all"), true);
  assert.equal(isOnlyThatCompletionMessage("proceed with that"), true);
  assert.equal(isOnlyThatCompletionMessage("I want Chicken"), false);
});

test("delivery fee resolver uses configured sources only", () => {
  assert.deepEqual(resolveDeliveryFee({}, "delivery", "Crown Hospital", 120), {
    amount: null,
    source: "not_configured",
    resolved: false
  });
  assert.deepEqual(
    resolveDeliveryFee(
      { deliveryPricing: { type: "flat", flatFee: 10 } },
      "delivery",
      "Crown Hospital",
      120
    ),
    {
      amount: 10,
      source: "flat_fee",
      resolved: true
    }
  );
  assert.deepEqual(
    resolveDeliveryFee(
      {
        deliveryPricing: {
          type: "zone_based",
          zones: [{ name: "Madina", aliases: ["Crown Hospital"], fee: 12 }]
        }
      },
      "delivery",
      "Near Crown Hospital",
      120
    ),
    {
      amount: 12,
      source: "zone",
      resolved: true,
      zoneName: "Madina"
    }
  );
});

test("delivery fee resolver reports manual confirmation separately", () => {
  assert.deepEqual(
    resolveDeliveryFee(
      { deliveryPricing: { type: "manual_confirmation" } },
      "delivery",
      "Rehoboth Church",
      224
    ),
    {
      amount: null,
      source: "manual_confirmation",
      resolved: false
    }
  );
});

test("manual delivery fee stays pending without becoming zero in draft view", () => {
  const session = {
    cartItems: [
      {
        name: "Jollof Rice",
        quantity: 1,
        unitPrice: 60,
        totalPrice: 60
      }
    ],
    orderType: "delivery",
    deliveryAddress: "Madina",
    deliveryFeeSource: "manual_confirmation",
    deliveryFeeResolved: false,
    customerName: "Rebecca"
  };
  const view = buildDraftView(session, {
    deliveryPricing: { type: "manual_confirmation" }
  });

  assert.equal(view.deliveryFee, null);
  assert.equal(view.deliveryFeePending, true);
  assert.equal(view.deliveryFeeLabel, "To be communicated");
  assert.equal(view.foodTotal, 60);
  assert.equal(view.total, 60);
  assert.deepEqual(view.missingFields, []);
  assert.equal(view.readyToConfirm, true);
});

test("category context survives in the customer draft view", () => {
  const view = buildDraftView(
    {
      cartItems: [],
      orderType: null,
      deliveryFeeResolved: false,
      pendingCategoryId: "64b000000000000000000401",
      pendingCategoryName: "Spaghetti"
    },
    {}
  );

  assert.deepEqual(view.pendingCategory, {
    id: "64b000000000000000000401",
    name: "Spaghetti"
  });
});

test("model-supplied quantity is not trusted without explicit customer quantity", () => {
  assert.equal(resolveTrustedQuantity(1, "With chicken"), null);
  assert.equal(resolveTrustedQuantity(1, "one portion"), 1);
});

test("missing customer name gets structured draft error code", () => {
  const missing = getMissingDraftFields({
    cartItems: [{ totalPrice: 60 }],
    orderType: "pickup",
    deliveryFeeResolved: true
  });

  assert.equal(missing.includes("customerName"), true);
  assert.equal(getDraftMissingFieldCode(missing), "CUSTOMER_NAME_REQUIRED");
});

test("state-aware follow-ups use active order step", () => {
  assert.equal(
    buildStateAwareFollowUpMessage("collecting_quantity"),
    "Are you still there? I just need the number of portions you would like."
  );
  assert.equal(
    buildStateAwareFollowUpMessage("collecting_name"),
    "Are you still there? I just need the name for the order."
  );
  assert.equal(buildStateAwareFollowUpMessage("idle"), null);
});

test("Wasender queue respects retry_after from account protection", () => {
  assert.equal(
    getWasenderRetryDelayMs({
      success: false,
      status: 429,
      data: {
        retry_after: 2
      }
    }),
    2000
  );
});

test("Wasender queue spaces sends per session", () => {
  const now = new Date("2026-07-27T17:29:50.000Z");
  const lastSentAt = new Date("2026-07-27T17:29:48.000Z");
  const nextSendAt = getNextSessionSendAt(lastSentAt, now, 5000);

  assert.equal(nextSendAt.toISOString(), "2026-07-27T17:29:53.000Z");
  assert.equal(getNextSessionSendAt(lastSentAt, new Date("2026-07-27T17:29:54.000Z"), 5000), null);
});

test("stale conversational replies are cancelled while transactional messages continue", () => {
  const session = {
    conversationVersion: 3,
    currentStep: "collecting_quantity"
  };

  assert.equal(
    isQueuedConversationalMessageStale(
      {
        conversationVersion: 1,
        expectedDraftStep: "idle",
        responsePurpose: "greeting"
      },
      session
    ),
    true
  );
  assert.equal(
    isQueuedConversationalMessageStale(
      {
        conversationVersion: 3,
        expectedDraftStep: "collecting_quantity",
        responsePurpose: "quantity_clarification"
      },
      session
    ),
    false
  );
  assert.equal(
    isQueuedConversationalMessageStale(
      {
        kind: "receipt_delivery",
        conversationVersion: 1
      },
      session
    ),
    false
  );
});

test("Wasender normalizer extracts quoted reply and provider message IDs from known shapes", () => {
  const webhook = normalizeIncomingWebhook({
    event: "messages.received",
    data: {
      messages: {
        key: {
          id: "inbound-1",
          remoteJid: "233557038547@s.whatsapp.net",
          fromMe: false
        },
        message: {
          extendedTextMessage: {
            text: "Accept",
            contextInfo: {
              stanzaId: "owner-notification-1"
            }
          }
        }
      }
    },
    sessionId: "session-1"
  });

  assert.equal(webhook.message, "Accept");
  assert.equal(webhook.quotedMessageId, "owner-notification-1");
  assert.equal(extractWasenderProviderMessageId({ data: { key: { id: "sent-1" } } }), "sent-1");
});

test("restaurant acceptance and rejection are owner or manager only", () => {
  assert.equal(isToolAllowedForRole("confirm_order", "owner"), true);
  assert.equal(isToolAllowedForRole("confirm_order", "manager"), true);
  assert.equal(isToolAllowedForRole("confirm_order", "customer"), false);
  assert.equal(isToolAllowedForRole("reject_order", "owner"), true);
  assert.equal(isToolAllowedForRole("reject_order", "manager"), true);
  assert.equal(isToolAllowedForRole("reject_order", "customer"), false);
});

test("unsupported promotion tool is not exposed", () => {
  assert.equal(isToolAllowedForRole("create_promotion", "owner"), false);
  assert.equal(getAllowedToolNamesForRole("owner").includes("create_promotion"), false);
});

test("customer message reaches Hermes with stable session key", async () => {
  const originalFetch = global.fetch;
  const originalAgentUrl = process.env.HERMES_AGENT_URL;
  const originalApiKey = process.env.HERMES_API_KEY;
  const calls = [];

  process.env.HERMES_AGENT_URL = "https://hermes.example/v1/responses";
  process.env.HERMES_API_KEY = "hermes-api-secret";
  global.fetch = async (_url, options) => {
    calls.push(options);

    return {
      ok: true,
      json: async () => ({
        id: "resp_1",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Hello from Hermes" }]
          }
        ]
      })
    };
  };

  try {
    const sender = resolveSenderIdentity(restaurant, "233557038547");
    const result = await sendHermesAgentMessage(
      { _id: "64b000000000000000000001", name: "Test Kitchen" },
      sender,
      "Hi"
    );
    const body = JSON.parse(calls[0].body);

    assert.equal(result.message, "Hello from Hermes");
    assert.equal(calls[0].headers.Authorization, "Bearer hermes-api-secret");
    assert.equal(
      calls[0].headers["X-Hermes-Session-Key"],
      "64b000000000000000000001:+233557038547"
    );
    assert.equal(body.input, "Hi");
    assert.match(body.instructions, /"senderRole":"customer"/);
    assert.match(body.instructions, /"sessionKey":"64b000000000000000000001:\+233557038547"/);
  } finally {
    global.fetch = originalFetch;
    process.env.HERMES_AGENT_URL = originalAgentUrl;
    process.env.HERMES_API_KEY = originalApiKey;
  }
});

test("conversation continuity reuses Hermes session key", async () => {
  const originalFetch = global.fetch;
  const originalAgentUrl = process.env.HERMES_AGENT_URL;
  const originalApiKey = process.env.HERMES_API_KEY;
  const sessionKeys = [];

  process.env.HERMES_AGENT_URL = "https://hermes.example/v1/responses";
  process.env.HERMES_API_KEY = "hermes-api-secret";
  global.fetch = async (_url, options) => {
    sessionKeys.push(options.headers["X-Hermes-Session-Key"]);

    return {
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "ok" }]
          }
        ]
      })
    };
  };

  try {
    const sender = resolveSenderIdentity(restaurant, "233557038547");
    const testRestaurant = { _id: "64b000000000000000000001", name: "Test Kitchen" };

    await sendHermesAgentMessage(testRestaurant, sender, "What food do you have?");
    await sendHermesAgentMessage(testRestaurant, sender, "Which one would you recommend?");

    assert.equal(sessionKeys.length, 2);
    assert.equal(sessionKeys[0], sessionKeys[1]);
  } finally {
    global.fetch = originalFetch;
    process.env.HERMES_AGENT_URL = originalAgentUrl;
    process.env.HERMES_API_KEY = originalApiKey;
  }
});

test("same phone uses different Hermes session keys per restaurant", () => {
  const sender = resolveSenderIdentity(restaurant, "233557038547");

  assert.notEqual(
    buildHermesSessionKey("64b000000000000000000001", sender),
    buildHermesSessionKey("64b000000000000000000002", sender)
  );
});

test("customer cannot update price even if Hermes requests the tool", () => {
  assert.equal(isToolAllowedForRole("update_menu_price", "customer"), false);
});

test("MCP tools require sessionKey instead of the old signed context field", () => {
  const updatePriceTool = mcpTools.find((tool) => tool.name === "update_price");
  const oldContextField = ["context", "Token"].join("");

  assert.ok(updatePriceTool);
  assert.deepEqual(updatePriceTool.inputSchema.required, ["sessionKey"]);
  assert.equal(updatePriceTool.inputSchema.properties[oldContextField], undefined);
  assert.equal(updatePriceTool.inputSchema.properties.sessionKey.type, "string");
});

test("MCP authentication uses only MCP_SHARED_SECRET", async () => {
  const originalSecret = process.env.MCP_SHARED_SECRET;
  const oldHermesServerKeyName = ["HERMES_API", "SERVER_KEY"].join("_");
  const originalServerKey = process.env[oldHermesServerKeyName];

  process.env.MCP_SHARED_SECRET = "mcp-secret";
  process.env[oldHermesServerKeyName] = "old-shared-secret";

  try {
    assert.equal(isMcpBearerTokenAuthorized("old-shared-secret"), false);
    assert.equal(isMcpBearerTokenAuthorized("mcp-secret"), true);

    let statusCode;
    let body;
    const req = {
      header: (name) => (name.toLowerCase() === "authorization" ? "Bearer wrong" : undefined),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
    };
    const res = {
      status: (code) => {
        statusCode = code;
        return res;
      },
      json: (value) => {
        body = value;
        return res;
      }
    };

    await handleMcpRequest(req, res);

    assert.equal(statusCode, 401);
    assert.deepEqual(body, { error: "Unauthorized" });
  } finally {
    process.env.MCP_SHARED_SECRET = originalSecret;
    process.env[oldHermesServerKeyName] = originalServerKey;
  }
});

test("Hermes API failure returns null for safe upstream handling", async () => {
  const originalFetch = global.fetch;
  const originalAgentUrl = process.env.HERMES_AGENT_URL;
  const originalApiKey = process.env.HERMES_API_KEY;

  process.env.HERMES_AGENT_URL = "https://hermes.example/v1/responses";
  process.env.HERMES_API_KEY = "hermes-api-secret";
  global.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({})
  });

  try {
    const sender = resolveSenderIdentity(restaurant, "233557038547");
    const result = await sendHermesAgentMessage(
      { _id: "64b000000000000000000001", name: "Test Kitchen" },
      sender,
      "Hi"
    );

    assert.equal(result, null);
  } finally {
    global.fetch = originalFetch;
    process.env.HERMES_AGENT_URL = originalAgentUrl;
    process.env.HERMES_API_KEY = originalApiKey;
  }
});

const fakeRestaurant = {
  _id: "64b000000000000000000001",
  name: "Test Kitchen",
  managerContacts: [],
  managerPhones: [],
  ownerPhone: "+233507879374"
};

const fakeOwner = {
  phone: "0507879374",
  normalizedPhone: "+233507879374",
  role: "owner",
  verified: true,
  name: "Gabriel"
};

const buildTestPrompt = async () => "Test system prompt";
const getEmptyHistory = async () => [];
const saveNoop = async () => {};
const restoreEnv = (key, value) => {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
};

test("OpenRouter owner menu request runs get_menu before final response", async () => {
  const executed = [];
  const provider = {
    name: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    calls: 0,
    complete: async () => {
      provider.calls += 1;

      if (provider.calls === 1) {
        return {
          toolCalls: [
            {
              id: "call_1",
              name: "get_menu",
              arguments: { availableOnly: false }
            }
          ]
        };
      }

      return {
        text: "Here is the real menu from the backend.",
        toolCalls: []
      };
    }
  };

  const result = await runAgentOrchestrator(
    {
      restaurant: fakeRestaurant,
      sender: fakeOwner,
      message: "Show me today's menu."
    },
    {
      provider,
      getHistory: getEmptyHistory,
      saveMessage: saveNoop,
      buildSystemPrompt: buildTestPrompt,
      executeTool: async (toolName, args) => {
        executed.push({ toolName, args });

        return {
          success: true,
          message: "Menu retrieved successfully.",
          data: [{ name: "Rice", items: [{ name: "Jollof Rice", price: 70 }] }]
        };
      }
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.message, "Here is the real menu from the backend.");
  assert.deepEqual(executed, [{ toolName: "get_menu", args: { availableOnly: false } }]);
});

test("OpenRouter tool loop ignores model-supplied trusted identity arguments", async () => {
  let receivedArgs;
  const provider = {
    name: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    calls: 0,
    complete: async () => {
      provider.calls += 1;

      if (provider.calls === 1) {
        return {
          toolCalls: [
            {
              id: "call_1",
              name: "update_menu_price",
              arguments: {
                restaurantId: "64b000000000000000000999",
                senderRole: "owner",
                itemName: "Jollof Rice",
                newPrice: 70
              }
            }
          ]
        };
      }

      return {
        text: "Should I change Jollof Rice to GHS 70?",
        toolCalls: []
      };
    }
  };

  await runAgentOrchestrator(
    {
      restaurant: fakeRestaurant,
      sender: fakeOwner,
      message: "Change Jollof Rice to GHS 70."
    },
    {
      provider,
      getHistory: getEmptyHistory,
      saveMessage: saveNoop,
      buildSystemPrompt: buildTestPrompt,
      executeTool: async (_toolName, args) => {
        receivedArgs = args;

        return {
          success: true,
          requiresConfirmation: true,
          pendingActionId: "pending_1",
          message: "Should I change Jollof Rice to GHS 70?"
        };
      }
    }
  );

  assert.deepEqual(receivedArgs, { itemName: "Jollof Rice", newPrice: 70 });
});

test("OpenRouter customer role cannot execute owner tools through orchestrator", async () => {
  const customer = {
    phone: "0557038547",
    normalizedPhone: "+233557038547",
    role: "customer",
    verified: false
  };
  let toolExecuted = false;
  const provider = {
    name: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    calls: 0,
    complete: async () => {
      provider.calls += 1;

      if (provider.calls === 1) {
        return {
          toolCalls: [
            {
              id: "call_1",
              name: "update_menu_price",
              arguments: { itemName: "Jollof Rice", newPrice: 1 }
            }
          ]
        };
      }

      return {
        text: "That action is not available for your role.",
        toolCalls: []
      };
    }
  };

  const result = await runAgentOrchestrator(
    {
      restaurant: fakeRestaurant,
      sender: customer,
      message: "Change the price."
    },
    {
      provider,
      getHistory: getEmptyHistory,
      saveMessage: saveNoop,
      buildSystemPrompt: buildTestPrompt,
      executeTool: async () => {
        toolExecuted = true;

        return { success: true, message: "should not run" };
      }
    }
  );

  assert.equal(toolExecuted, false);
  assert.equal(result.executedTools[0].success, false);
  assert.equal(result.executedTools[0].code, "TOOL_FORBIDDEN");
});

test("OpenRouter tool loop stops at configured maximum rounds", async () => {
  const originalMaxRounds = process.env.OPENROUTER_MAX_TOOL_ROUNDS;
  process.env.OPENROUTER_MAX_TOOL_ROUNDS = "2";
  const provider = {
    name: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    complete: async () => ({
      toolCalls: [
        {
          id: `call_${Date.now()}`,
          name: "get_menu",
          arguments: {}
        }
      ]
    })
  };

  try {
    const result = await runAgentOrchestrator(
      {
        restaurant: fakeRestaurant,
        sender: fakeOwner,
        message: "Loop please"
      },
      {
        provider,
        getHistory: getEmptyHistory,
        saveMessage: saveNoop,
        buildSystemPrompt: buildTestPrompt,
        executeTool: async () => ({
          success: true,
          message: "Menu retrieved successfully.",
          data: []
        })
      }
    );

    assert.equal(result.success, false);
    assert.equal(result.executedTools.length, 2);
    assert.match(result.message, /couldn't complete/i);
  } finally {
    restoreEnv("OPENROUTER_MAX_TOOL_ROUNDS", originalMaxRounds);
  }
});

test("OpenRouter provider errors return a safe response from orchestrator", async () => {
  const provider = {
    name: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    complete: async () => {
      throw new Error("timeout");
    }
  };

  const result = await runAgentOrchestrator(
    {
      restaurant: fakeRestaurant,
      sender: fakeOwner,
      message: "Show me orders"
    },
    {
      provider,
      getHistory: getEmptyHistory,
      saveMessage: saveNoop,
      buildSystemPrompt: buildTestPrompt
    }
  );

  assert.equal(result.success, false);
  assert.match(result.message, /trouble reaching the restaurant system/i);
});

test("OpenRouter provider normalizes malformed tool arguments", async () => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.OPENROUTER_MODEL;
  const originalFetch = global.fetch;

  process.env.AI_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "google/gemini-3.1-flash-lite";
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      id: "or_1",
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call_1",
                function: {
                  name: "update_order_draft",
                  arguments: "{\"customerName\":\"Mavis\","
                }
              }
            ]
          }
        }
      ]
    })
  });

  try {
    const provider = new OpenRouterProvider();
    const result = await provider.complete({
      messages: [{ role: "user", content: "name is Mavis" }],
      tools: [],
      toolChoice: "auto"
    });

    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "update_order_draft");
    assert.equal(result.toolCalls[0].invalidArguments, true);
    assert.deepEqual(result.toolCalls[0].arguments, {});
  } finally {
    restoreEnv("AI_PROVIDER", originalProvider);
    restoreEnv("OPENROUTER_API_KEY", originalApiKey);
    restoreEnv("OPENROUTER_MODEL", originalModel);
    global.fetch = originalFetch;
  }
});

test("OpenRouter orchestrator feeds malformed tool arguments back as tool validation", async () => {
  const provider = {
    name: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    calls: 0,
    complete: async () => {
      provider.calls += 1;

      if (provider.calls === 1) {
        return {
          toolCalls: [
            {
              id: "call_1",
              name: "update_order_draft",
              arguments: {},
              invalidArguments: true
            }
          ]
        };
      }

      return {
        text: "Please send your name and address again.",
        toolCalls: []
      };
    }
  };

  const toolRecords = [];
  const result = await runAgentOrchestrator(
    {
      restaurant: fakeRestaurant,
      sender: {
        phone: "0557038547",
        normalizedPhone: "+233557038547",
        role: "customer",
        verified: false
      },
      message: "Name is Mavis and address is Rehoboth"
    },
    {
      provider,
      getHistory: getEmptyHistory,
      saveMessage: async (message) => {
        if (message.direction === "tool") {
          toolRecords.push(JSON.parse(message.content));
        }
      },
      buildSystemPrompt: buildTestPrompt,
      executeTool: async () => {
        throw new Error("executeTool should not be called for malformed arguments");
      }
    }
  );

  assert.equal(result.success, true);
  assert.equal(toolRecords[0].code, "TOOL_INVALID_ARGUMENTS");
});

test("OpenRouter orchestrator classifies provider timeout", async () => {
  const provider = {
    name: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    complete: async () => {
      const error = new Error("The operation timed out");
      error.name = "AbortError";
      throw error;
    }
  };

  const result = await runAgentOrchestrator(
    {
      restaurant: fakeRestaurant,
      sender: fakeOwner,
      message: "Show me orders"
    },
    {
      provider,
      getHistory: getEmptyHistory,
      saveMessage: saveNoop,
      buildSystemPrompt: buildTestPrompt
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.errorCode, "PROVIDER_TIMEOUT");
  assert.match(result.message, /trouble reaching the restaurant system/i);
});

test("OpenRouter orchestrator captures structured order data from confirmation tool", async () => {
  const provider = {
    name: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    calls: 0,
    complete: async () => {
      provider.calls += 1;

      if (provider.calls === 1) {
        return {
          toolCalls: [
            {
              id: "call_1",
              name: "confirm_order_draft",
              arguments: {}
            }
          ]
        };
      }

      return {
        text: "Your order has been placed.",
        toolCalls: []
      };
    }
  };

  const result = await runAgentOrchestrator(
    {
      restaurant: fakeRestaurant,
      sender: {
        phone: "0557038547",
        normalizedPhone: "+233557038547",
        role: "customer",
        verified: false
      },
      message: "Confirm my order"
    },
    {
      provider,
      getHistory: getEmptyHistory,
      saveMessage: saveNoop,
      buildSystemPrompt: buildTestPrompt,
      executeTool: async () => ({
        success: true,
        message: "Your order has been submitted to the restaurant for confirmation.",
        data: {
          order: {
            orderNumber: "ORD-123",
            total: 90
          },
          orderEvent: "submitted",
          notifyOwner: true,
          receiptRequired: false
        }
      })
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.data.order.orderNumber, "ORD-123");
  assert.equal(result.data.orderEvent, "submitted");
  assert.equal(result.data.notifyOwner, true);
  assert.equal(result.data.receiptRequired, false);
});

test("owner notification text uses real order data and pending status", () => {
  const message = buildOwnerNewOrderNotification(
    { name: "Golden Grill" },
    {
      _id: "64b000000000000000000111",
      orderNumber: "ORD-123",
      customerName: "Gabriel",
      customerPhone: "+233557038547",
      orderType: "delivery",
      deliveryAddress: "Madina",
      subtotal: 165,
      deliveryFee: null,
      deliveryFeePending: true,
      items: [
        {
          name: "Jollof Rice",
          quantity: 2,
          unitPrice: 60,
          totalPrice: 120
        },
        {
          name: "Chicken Noodles",
          quantity: 1,
          unitPrice: 45,
          totalPrice: 45
        }
      ],
      total: 165,
      paymentMethod: "unknown",
      paymentStatus: "unpaid"
    }
  );

  assert.match(message, /New order awaiting your confirmation/);
  assert.match(message, /Golden Grill/);
  assert.match(message, /Order: ORD-123/);
  assert.match(message, /Customer: Gabriel/);
  assert.match(message, /2 x Jollof Rice - GHS 120\.00/);
  assert.match(message, /Delivery fee: Pending confirmation/);
  assert.match(message, /Food total: GHS 165\.00/);
  assert.match(message, /Total: GHS 165\.00/);
  assert.match(message, /Status: Awaiting confirmation/);
  assert.match(message, /Reply to this message with:/);
  assert.match(message, /\bAccept\b/);
  assert.match(message, /\bReject\b/);
});

test("owner simple decisions and saved selections parse safely", () => {
  assert.equal(parseSimpleOwnerDecision("Accept"), "accept");
  assert.equal(parseSimpleOwnerDecision("Reject"), "reject");
  assert.equal(parseSimpleOwnerDecision("Accept ORD-123"), null);
  assert.deepEqual(parseOwnerSelectionReply("1", 2), { type: "indexes", indexes: [1] });
  assert.deepEqual(parseOwnerSelectionReply("both", 2), { type: "all" });
  assert.deepEqual(parseOwnerSelectionReply("cancel", 2), { type: "cancel" });
});

test("owner selection message preserves numbered order list", () => {
  const now = new Date("2026-07-28T12:00:00.000Z");
  const orders = [
    {
      customerName: "Rebecca",
      items: [{ name: "Jollof Rice" }],
      subtotal: 60,
      customerConfirmedAt: new Date("2026-07-28T11:58:00.000Z"),
      createdAt: new Date("2026-07-28T11:58:00.000Z")
    },
    {
      customerName: "Ama",
      items: [{ name: "Fried Rice" }],
      subtotal: 80,
      customerConfirmedAt: new Date("2026-07-28T11:55:00.000Z"),
      createdAt: new Date("2026-07-28T11:55:00.000Z")
    }
  ];
  const message = buildOwnerSelectionMessage("accept", orders, now);

  assert.match(message, /Which order should I accept/);
  assert.match(message, /1\. Rebecca - Jollof Rice - GHS 60\.00 - 2 minutes ago/);
  assert.match(message, /2\. Ama - Fried Rice - GHS 80\.00 - 5 minutes ago/);
  assert.match(message, /Reply 1, 2, or both/);
});

test("bulk accepted order side effects process each order exactly once", async () => {
  const sideEffects = require("../dist/services/orderSideEffects.service");
  const { Order } = require("../dist/models/order.model");
  const controllerPath = require.resolve("../dist/controllers/wasender.controller");
  const originalFindOne = Order.findOne;
  const originalNotifyConfirmed = sideEffects.notifyCustomerOfConfirmedOrderAndSendReceipt;
  const acceptedOrders = [
    {
      _id: "64b000000000000000000201",
      orderNumber: "ORD-201",
      customerName: "Rebecca"
    },
    {
      _id: "64b000000000000000000202",
      orderNumber: "ORD-202",
      customerName: "Ama"
    }
  ];
  const notificationCounts = new Map();
  const receiptCounts = new Map();

  delete require.cache[controllerPath];

  Order.findOne = async (query) => {
    return acceptedOrders.find((order) => String(order._id) === String(query._id)) ?? null;
  };
  sideEffects.notifyCustomerOfConfirmedOrderAndSendReceipt = async (_restaurant, order) => {
    notificationCounts.set(String(order._id), (notificationCounts.get(String(order._id)) ?? 0) + 1);
    receiptCounts.set(String(order._id), (receiptCounts.get(String(order._id)) ?? 0) + 1);

    return {
      customerNotification: "queued",
      receiptDelivery: "queued"
    };
  };

  try {
    const { sendCustomerOrderSideEffects } = require("../dist/controllers/wasender.controller");
    const restaurantRecord = {
      _id: "64b000000000000000000001",
      name: "Golden Grill"
    };
    const response = {
      success: true,
      message: "2 orders accepted.",
      data: {
        orders: acceptedOrders,
        orderEvent: "confirmed",
        notifyCustomer: true,
        receiptRequired: true
      }
    };
    const timeout = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("bulk side effects did not finish")), 250);
    });

    await Promise.race([sendCustomerOrderSideEffects(restaurantRecord, response), timeout]);

    assert.deepEqual(
      acceptedOrders.map((order) => notificationCounts.get(String(order._id))),
      [1, 1]
    );
    assert.deepEqual(
      acceptedOrders.map((order) => receiptCounts.get(String(order._id))),
      [1, 1]
    );
  } finally {
    Order.findOne = originalFindOne;
    sideEffects.notifyCustomerOfConfirmedOrderAndSendReceipt = originalNotifyConfirmed;
    delete require.cache[controllerPath];
  }
});

test("same customer webhook turns are processed sequentially", async () => {
  const { runCustomerConversationSequentially } = require("../dist/controllers/wasender.controller");
  const events = [];
  let releaseFirst;
  let resolveFirstStarted;
  const firstStarted = new Promise((resolve) => {
    resolveFirstStarted = resolve;
  });
  const first = runCustomerConversationSequentially(
      "64b000000000000000000001",
      "+233500000001",
      async () => {
        events.push("first-start");
        resolveFirstStarted();
        await new Promise((release) => {
          releaseFirst = release;
        });
        events.push("first-end");
      }
  );

  await firstStarted;

  const second = runCustomerConversationSequentially(
    "64b000000000000000000001",
    "+233500000001",
    async () => {
      events.push("second-start");
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["first-start"]);

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
});

test("different customer webhook turns can run concurrently", async () => {
  const { runCustomerConversationSequentially } = require("../dist/controllers/wasender.controller");
  const events = [];
  let releaseFirst;
  const first = runCustomerConversationSequentially(
    "64b000000000000000000001",
    "+233500000001",
    async () => {
      events.push("first-start");
      await new Promise((release) => {
        releaseFirst = release;
      });
      events.push("first-end");
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 0));

  await runCustomerConversationSequentially(
    "64b000000000000000000001",
    "+233500000002",
    async () => {
      events.push("second-start");
    }
  );

  assert.deepEqual(events, ["first-start", "second-start"]);

  releaseFirst();
  await first;
});

test("OpenRouter max-round fallback returns recoverable clarification message", async () => {
  const originalMaxRounds = process.env.OPENROUTER_MAX_TOOL_ROUNDS;
  process.env.OPENROUTER_MAX_TOOL_ROUNDS = "2";
  const provider = {
    name: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    complete: async () => ({
      toolCalls: [
        {
          id: `call_${Date.now()}`,
          name: "add_order_item_by_name",
          arguments: { itemName: "spaghetti" }
        }
      ]
    })
  };

  try {
    const result = await runAgentOrchestrator(
      {
        restaurant: fakeRestaurant,
        sender: {
          phone: "0557038547",
          normalizedPhone: "+233557038547",
          role: "customer",
          verified: false
        },
        message: "I want spaghetti"
      },
      {
        provider,
        getHistory: getEmptyHistory,
        saveMessage: saveNoop,
        buildSystemPrompt: buildTestPrompt,
        executeTool: async () => ({
          success: false,
          code: "MULTIPLE_MENU_ITEMS_FOUND",
          message: "Please choose one Spaghetti option: Crave Special, Beef, Chicken."
        })
      }
    );

    assert.equal(result.success, false);
    assert.equal(
      result.message,
      "Please choose one Spaghetti option: Crave Special, Beef, Chicken."
    );
  } finally {
    restoreEnv("OPENROUTER_MAX_TOOL_ROUNDS", originalMaxRounds);
  }
});

test("pending order expiry helpers exclude old orders", () => {
  const now = new Date("2026-07-28T12:00:00.000Z");
  const fresh = {
    status: "awaiting_restaurant_confirmation",
    customerConfirmedAt: new Date("2026-07-28T11:30:00.000Z"),
    createdAt: new Date("2026-07-28T11:30:00.000Z")
  };
  const old = {
    status: "awaiting_restaurant_confirmation",
    customerConfirmedAt: new Date("2026-07-28T10:00:00.000Z"),
    createdAt: new Date("2026-07-28T10:00:00.000Z")
  };

  assert.equal(isPendingOrderActionable(fresh, now, 60), true);
  assert.equal(isPendingOrderActionable(old, now, 60), false);
  assert.equal(formatRelativeOrderAge(old, now), "2 hours ago");
});

test("customer decision messages do not invent receipt on rejection", () => {
  const restaurantRecord = { name: "Golden Grill" };
  const order = {
    _id: "64b000000000000000000111",
    orderNumber: "ORD-123",
    restaurantRejectionReason: "Chicken is unavailable"
  };

  assert.equal(
    buildCustomerOrderConfirmedMessage(restaurantRecord, order, true),
    "Good news. Golden Grill has accepted order ORD-123 and will begin preparing it. Your receipt is attached."
  );
  assert.equal(
    buildCustomerOrderRejectedMessage(restaurantRecord, order),
    "Golden Grill could not accept order ORD-123 at this time. The restaurant gave this reason: Chicken is unavailable."
  );
});

test("OpenRouter orchestrator blocks model success claim after failed tool", async () => {
  const provider = {
    name: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    calls: 0,
    complete: async () => {
      provider.calls += 1;

      if (provider.calls === 1) {
        return {
          toolCalls: [
            {
              id: "call_1",
              name: "confirm_order_draft",
              arguments: {}
            }
          ]
        };
      }

      return {
        text: "Done, your order has been placed.",
        toolCalls: []
      };
    }
  };

  const result = await runAgentOrchestrator(
    {
      restaurant: fakeRestaurant,
      sender: {
        phone: "0557038547",
        normalizedPhone: "+233557038547",
        role: "customer",
        verified: false
      },
      message: "Confirm my order"
    },
    {
      provider,
      getHistory: getEmptyHistory,
      saveMessage: saveNoop,
      buildSystemPrompt: buildTestPrompt,
      executeTool: async () => ({
        success: false,
        code: "ORDER_DRAFT_INCOMPLETE",
        message: "The order draft is missing: deliveryAddress."
      })
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.message, "The order draft is missing: deliveryAddress.");
});

test("OpenRouter tool definitions are role filtered", () => {
  const ownerTools = getAgentToolDefinitionsForRole("owner").map((tool) => tool.function.name);
  const customerTools = getAgentToolDefinitionsForRole("customer").map((tool) => tool.function.name);

  assert.equal(ownerTools.includes("get_menu"), true);
  assert.equal(ownerTools.includes("list_orders"), true);
  assert.equal(ownerTools.includes("update_menu_price"), true);
  assert.equal(ownerTools.includes("confirm_order"), true);
  assert.equal(ownerTools.includes("reject_order"), true);
  assert.equal(customerTools.includes("get_restaurant_profile"), true);
  assert.equal(customerTools.includes("get_menu"), true);
  assert.equal(customerTools.includes("search_menu_items"), true);
  assert.equal(customerTools.includes("get_delivery_information"), true);
  assert.equal(customerTools.includes("start_order"), true);
  assert.equal(customerTools.includes("add_order_item_by_name"), true);
  assert.equal(customerTools.includes("remove_order_item_by_name"), true);
  assert.equal(customerTools.includes("update_order_draft"), true);
  assert.equal(customerTools.includes("get_order_draft"), true);
  assert.equal(customerTools.includes("confirm_order_draft"), true);
  assert.equal(customerTools.includes("cancel_order_draft"), true);
  assert.equal(customerTools.includes("get_latest_customer_order"), true);
  assert.equal(customerTools.includes("update_menu_price"), false);
  assert.equal(customerTools.includes("confirm_order"), false);
  assert.equal(customerTools.includes("reject_order"), false);
  assert.equal(customerTools.includes("get_sales_summary"), false);
});

test("customer OpenRouter routing is controlled by explicit feature switch", () => {
  assert.equal(shouldUseOpenRouterCustomerAgent("openrouter", true), true);
  assert.equal(shouldUseOpenRouterCustomerAgent("openrouter", false), false);
  assert.equal(shouldUseOpenRouterCustomerAgent("hermes", true), false);
});

test("OpenRouter selected provider config fails clearly when missing", () => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.OPENROUTER_MODEL;

  process.env.AI_PROVIDER = "openrouter";
  delete process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_MODEL = "google/gemini-3.1-flash-lite";

  try {
    assert.throws(
      () => validateSelectedAiProviderConfig(),
      /OPENROUTER_API_KEY/
    );
  } finally {
    restoreEnv("AI_PROVIDER", originalProvider);
    restoreEnv("OPENROUTER_API_KEY", originalApiKey);
    restoreEnv("OPENROUTER_MODEL", originalModel);
  }
});

test("pending action confirmation accepts natural owner replies", () => {
  [
    "yes",
    "Yes update that",
    "yes change it",
    "go ahead",
    "okay proceed",
    "save it",
    "change it",
    "update the price"
  ].forEach((message) => {
    assert.equal(isPendingActionConfirmationMessage(message), true, message);
  });
});

test("pending action confirmation avoids new mutation requests", () => {
  [
    "can you change beef to 60 cedis",
    "update beef to 60",
    "change jollof rice to 70",
    "show me the menu"
  ].forEach((message) => {
    assert.equal(isPendingActionConfirmationMessage(message), false, message);
  });
});

test("pending action cancellation accepts natural owner replies", () => {
  [
    "no",
    "no don't save",
    "cancel that",
    "stop",
    "not now",
    "leave it"
  ].forEach((message) => {
    assert.equal(isPendingActionCancellationMessage(message), true, message);
  });
});

test("customer profile model has restaurant-scoped lookup and marketing indexes", () => {
  const indexes = CustomerProfile.schema.indexes();
  const scopedIndex = indexes.find(
    ([fields]) =>
      fields.restaurantId === 1 &&
      fields.customerPhone === 1 &&
      Object.keys(fields).length === 2
  );
  const marketingIndex = indexes.find(
    ([fields]) =>
      fields.restaurantId === 1 &&
      fields.marketingConsent === 1 &&
      fields.isOptedOut === 1
  );

  assert.equal(scopedIndex[1].unique, true);
  assert.ok(marketingIndex);
});

test("customer profile statistics use completed orders only", () => {
  const jollofId = "64b000000000000000000301";
  const chickenId = "64b000000000000000000302";
  const stats = buildCompletedOrderProfileStats([
    {
      status: "completed",
      customerName: "Ama",
      items: [
        {
          menuItemId: jollofId,
          name: "Jollof Rice",
          quantity: 2,
          unitPrice: 30,
          totalPrice: 60
        }
      ],
      total: 70,
      orderType: "delivery",
      deliveryAddress: "Madina  Estate",
      completedAt: new Date("2026-07-20T12:00:00.000Z"),
      createdAt: new Date("2026-07-20T11:00:00.000Z"),
      updatedAt: new Date("2026-07-20T12:00:00.000Z")
    },
    {
      status: "cancelled",
      customerName: "Wrong name",
      items: [
        {
          menuItemId: chickenId,
          name: "Chicken",
          quantity: 99,
          unitPrice: 10,
          totalPrice: 990
        }
      ],
      total: 990,
      orderType: "pickup",
      createdAt: new Date("2026-07-21T11:00:00.000Z"),
      updatedAt: new Date("2026-07-21T12:00:00.000Z")
    },
    {
      status: "completed",
      customerName: "Ama Mensah",
      items: [
        {
          menuItemId: jollofId,
          name: "Jollof Rice",
          quantity: 1,
          unitPrice: 30,
          totalPrice: 30
        },
        {
          menuItemId: chickenId,
          name: "Grilled Chicken",
          quantity: 1,
          unitPrice: 20,
          totalPrice: 20
        }
      ],
      total: 50,
      orderType: "delivery",
      deliveryAddress: "madina estate",
      completedAt: new Date("2026-07-22T12:00:00.000Z"),
      createdAt: new Date("2026-07-22T11:00:00.000Z"),
      updatedAt: new Date("2026-07-22T12:00:00.000Z")
    }
  ]);

  assert.equal(stats.orderCount, 2);
  assert.equal(stats.customerName, "Ama Mensah");
  assert.equal(stats.averageOrderValue, 60);
  assert.equal(stats.preferredOrderType, "delivery");
  assert.equal(stats.lastOrderAt.toISOString(), "2026-07-22T12:00:00.000Z");
  assert.deepEqual(
    stats.frequentlyOrderedItems.map((item) => ({
      name: item.name,
      orderCount: item.orderCount,
      totalQuantity: item.totalQuantity
    })),
    [
      { name: "Jollof Rice", orderCount: 2, totalQuantity: 3 },
      { name: "Grilled Chicken", orderCount: 1, totalQuantity: 1 }
    ]
  );
  assert.deepEqual(
    stats.commonDeliveryAddresses.map((entry) => ({
      address: entry.address,
      orderCount: entry.orderCount
    })),
    [{ address: "madina estate", orderCount: 2 }]
  );
});

test("customer preference validation requires explicit confirmation", () => {
  assert.equal(
    updateCustomerPreferencesSchema.safeParse({
      dietaryPreferences: ["vegetarian"]
    }).success,
    false
  );
  assert.equal(
    updateCustomerPreferencesSchema.safeParse({
      confirmed: true
    }).success,
    false
  );
  assert.equal(
    updateCustomerPreferencesSchema.safeParse({
      confirmed: true,
      marketingConsent: true,
      isOptedOut: true
    }).success,
    false
  );
  assert.equal(
    updateCustomerPreferencesSchema.safeParse({
      confirmed: true,
      dietaryPreferences: ["vegetarian"],
      spicePreference: "medium",
      marketingConsent: true
    }).success,
    true
  );
});

test("non-completed orders never update customer profiles", async () => {
  const originalFindOneAndUpdate = CustomerProfile.findOneAndUpdate;
  let writes = 0;

  CustomerProfile.findOneAndUpdate = async () => {
    writes += 1;
  };

  try {
    const result = await updateCustomerProfileFromCompletedOrder({
      status: "accepted"
    });

    assert.equal(result, null);
    assert.equal(writes, 0);
  } finally {
    CustomerProfile.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("completed status updates persist completion time and refresh the profile", async () => {
  const originalFindById = Order.findById;
  const originalFind = Order.find;
  const originalProfileFindOne = CustomerProfile.findOne;
  const originalFindOneAndUpdate = CustomerProfile.findOneAndUpdate;
  const order = {
    _id: "64b000000000000000000101",
    restaurantId: "64b000000000000000000001",
    customerName: "Ama",
    customerPhone: "0557038547",
    status: "ready",
    items: [
      {
        menuItemId: "64b000000000000000000301",
        name: "Jollof Rice",
        quantity: 1,
        unitPrice: 30,
        totalPrice: 30
      }
    ],
    total: 30,
    orderType: "pickup",
    createdAt: new Date("2026-07-22T11:00:00.000Z"),
    updatedAt: new Date("2026-07-22T11:30:00.000Z"),
    save: async function () {
      this.updatedAt = new Date("2026-07-22T12:00:00.000Z");
      return this;
    }
  };
  let profileUpdate;

  Order.findById = async () => order;
  Order.find = () => ({
    sort: async () => [order]
  });
  CustomerProfile.findOne = () => ({
    select: async () => null
  });
  CustomerProfile.findOneAndUpdate = async (_filter, update) => {
    profileUpdate = update;
    return update.$set;
  };

  try {
    const result = await updateOrderStatus(String(order._id), "completed");

    assert.equal(result.order.status, "completed");
    assert.equal(result.order.customerPhone, "+233557038547");
    assert.ok(result.order.completedAt instanceof Date);
    assert.equal(profileUpdate.$set.orderCount, 1);
    assert.equal(profileUpdate.$set.averageOrderValue, 30);
    assert.equal(
      profileUpdate.$set.preferredOrderTypeSource,
      "completed_order"
    );
  } finally {
    Order.findById = originalFindById;
    Order.find = originalFind;
    CustomerProfile.findOne = originalProfileFindOne;
    CustomerProfile.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("unconfirmed preferences are rejected without a profile write", async () => {
  const originalFindOneAndUpdate = CustomerProfile.findOneAndUpdate;
  let writes = 0;

  CustomerProfile.findOneAndUpdate = async () => {
    writes += 1;
  };

  try {
    await assert.rejects(
      updateConfirmedCustomerPreferences(
        "64b000000000000000000001",
        "0557038547",
        {
          confirmed: false,
          dietaryPreferences: ["vegetarian"]
        }
      ),
      /explicitly confirmed/
    );
    assert.equal(writes, 0);
  } finally {
    CustomerProfile.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("confirmed preferences normalize facts and record conservative consent", async () => {
  const originalFindOneAndUpdate = CustomerProfile.findOneAndUpdate;
  let capturedFilter;
  let capturedUpdate;

  CustomerProfile.findOneAndUpdate = async (filter, update) => {
    capturedFilter = filter;
    capturedUpdate = update;
    return { ...filter, ...update.$set };
  };

  try {
    const profile = await updateConfirmedCustomerPreferences(
      "64b000000000000000000001",
      "0557038547",
      {
        confirmed: true,
        customerName: "  Ama   Mensah ",
        dietaryPreferences: [" Vegetarian ", "vegetarian", "No Peanuts"],
        spicePreference: " medium ",
        isOptedOut: true
      }
    );

    assert.equal(capturedFilter.customerPhone, "+233557038547");
    assert.equal(capturedUpdate.$set.customerName, "Ama Mensah");
    assert.deepEqual(capturedUpdate.$set.dietaryPreferences, [
      "Vegetarian",
      "No Peanuts"
    ]);
    assert.equal(capturedUpdate.$set.spicePreference, "medium");
    assert.equal(capturedUpdate.$set.isOptedOut, true);
    assert.equal(capturedUpdate.$set.marketingConsent, false);
    assert.ok(capturedUpdate.$set.preferencesConfirmedAt instanceof Date);
    assert.equal(profile.customerNameSource, "customer_confirmed");
  } finally {
    CustomerProfile.findOneAndUpdate = originalFindOneAndUpdate;
  }
});
