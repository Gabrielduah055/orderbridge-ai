const assert = require("node:assert/strict");
const test = require("node:test");

const { AgentConversationMessage } = require("../dist/models/agentConversation.model");
const { Order } = require("../dist/models/order.model");
const {
  handleRestaurantAgentMessage,
  isExplicitCustomerClarificationResetMessage,
  isExactOrderCheckInReply,
  shouldUseOpenRouterCustomerAgent
} = require("../dist/services/restaurantAgent.service");
const {
  handleCustomerCompatibilityMessage
} = require("../dist/services/customerAgentCompatibility.service");
const {
  getOpenRouterConfig
} = require("../dist/services/ai/ai.config");
const {
  runAgentOrchestrator
} = require("../dist/services/ai/agentOrchestrator.service");
const {
  buildAgentSystemPrompt
} = require("../dist/services/ai/agentPrompt.service");
const {
  getAgentToolDefinitionsForRole
} = require("../dist/services/ai/agentToolDefinitions.service");
const {
  enqueueTrustedMenuItemImageReply,
  getTrustedMenuItemImageDelivery
} = require("../dist/controllers/wasender.controller");
const {
  customerAgentScenarios
} = require("../dist/evals/customerAgent.scenarios");
const {
  evaluateCustomerAgentDecision,
  runCustomerAgentEvaluation
} = require("../dist/evals/customerAgent.evaluator");
const {
  buildLiveCustomerEvalSystemPrompt
} = require("../dist/evals/runCustomerAgentEval");

const restaurantId = "64b000000000000000000888";
const customerPhone = "+233500000099";
const imageUrl = "https://res.cloudinary.com/demo/image/upload/chicken.jpg";

const makeRestaurant = () => ({
  _id: restaurantId,
  name: "Golden Grill",
  ownerName: "Gabriel",
  ownerPhone: "+233500000001",
  managerPhones: [],
  managerContacts: [],
  status: "active",
  timezone: "Africa/Accra",
  wasenderSessionId: "golden-session",
  deliveryEnabled: true
});

const queryResult = (value) => ({
  sort() {
    return Promise.resolve(value);
  },
  then(resolve, reject) {
    return Promise.resolve(value).then(resolve, reject);
  }
});

const makeAgentResult = (overrides = {}) => ({
  success: true,
  message: "AI handled the customer turn.",
  provider: "openrouter",
  model: "test-model",
  executedTools: [],
  ...overrides
});

const withCustomerRoutingHarness = async (callback, env = {}) => {
  const originalEnvironment = {
    AI_PROVIDER: process.env.AI_PROVIDER,
    OPENROUTER_CUSTOMER_AGENT_ENABLED:
      process.env.OPENROUTER_CUSTOMER_AGENT_ENABLED,
    OPENROUTER_CUSTOMER_LEGACY_FALLBACK:
      process.env.OPENROUTER_CUSTOMER_LEGACY_FALLBACK
  };
  const originalCreate = AgentConversationMessage.create;
  const originalOrderFind = Order.find;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const savedMessages = [];
  const logs = [];

  process.env.AI_PROVIDER = "openrouter";
  delete process.env.OPENROUTER_CUSTOMER_AGENT_ENABLED;
  process.env.OPENROUTER_CUSTOMER_LEGACY_FALLBACK = "false";
  Object.assign(process.env, env);
  AgentConversationMessage.create = async (input) => {
    savedMessages.push(input);
    return input;
  };
  Order.find = () => queryResult([]);
  console.info = (...args) => logs.push({ level: "info", args });
  console.warn = (...args) => logs.push({ level: "warn", args });

  try {
    return await callback({ savedMessages, logs });
  } finally {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    AgentConversationMessage.create = originalCreate;
    Order.find = originalOrderFind;
    console.info = originalInfo;
    console.warn = originalWarn;
  }
};

test("OpenRouter customer routing defaults on and explicit false remains an emergency rollback", () => {
  const original = process.env.OPENROUTER_CUSTOMER_AGENT_ENABLED;

  try {
    delete process.env.OPENROUTER_CUSTOMER_AGENT_ENABLED;
    assert.equal(getOpenRouterConfig().customerAgentEnabled, true);
    assert.equal(shouldUseOpenRouterCustomerAgent("openrouter", true), true);

    process.env.OPENROUTER_CUSTOMER_AGENT_ENABLED = "false";
    assert.equal(getOpenRouterConfig().customerAgentEnabled, false);
    assert.equal(shouldUseOpenRouterCustomerAgent("openrouter", false), false);
    assert.equal(shouldUseOpenRouterCustomerAgent("hermes", true), false);
  } finally {
    if (original === undefined) {
      delete process.env.OPENROUTER_CUSTOMER_AGENT_ENABLED;
    } else {
      process.env.OPENROUTER_CUSTOMER_AGENT_ENABLED = original;
    }
  }
});

test("customer WhatsApp text uses the shared AI-first path without the extra enable flag", async () => {
  await withCustomerRoutingHarness(async ({ logs }) => {
    let orchestratorInput;
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: customerPhone,
        message: "where's my order?"
      },
      {
        runOrchestrator: async (input) => {
          orchestratorInput = input;
          return makeAgentResult({
            executedTools: [{ name: "get_latest_customer_order", success: true }]
          });
        }
      }
    );

    assert.equal(orchestratorInput.sender.role, "customer");
    assert.equal(response.source, "openrouter_agent");
    assert.equal(
      logs.some(({ args }) => args[0] === "[customerAgent] ai-first turn started"),
      true
    );
  });
});

for (const message of [
  "show me my order",
  "show me Chicken Salad",
  "any pic of Chicken Salad?"
]) {
  test(`${JSON.stringify(message)} reaches AI instead of the broad menu image parser`, async () => {
    await withCustomerRoutingHarness(async () => {
      const seen = [];
      const response = await handleRestaurantAgentMessage(
        { restaurant: makeRestaurant(), senderPhone: customerPhone, message },
        {
          runOrchestrator: async (input) => {
            seen.push(input.message);
            return makeAgentResult();
          }
        }
      );

      assert.deepEqual(seen, [message]);
      assert.equal(response.source, "openrouter_agent");
    });
  });
}

for (const message of ["the second dish", "I mean the Chicken Salad"]) {
  test(`${JSON.stringify(message)} preserves clarification state for the customer AI`, async () => {
    await withCustomerRoutingHarness(async () => {
      let cancellationCalls = 0;
      let orchestratorCalls = 0;

      await handleRestaurantAgentMessage(
        { restaurant: makeRestaurant(), senderPhone: customerPhone, message },
        {
          cancelCustomerClarifications: async () => {
            cancellationCalls += 1;
          },
          runOrchestrator: async () => {
            orchestratorCalls += 1;
            return makeAgentResult();
          }
        }
      );

      assert.equal(cancellationCalls, 0);
      assert.equal(orchestratorCalls, 1);
    });
  });
}

test("an explicit menu restart may clear stale clarification before the customer AI turn", async () => {
  await withCustomerRoutingHarness(async () => {
    const cancellations = [];
    let orchestratorCalls = 0;

    await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: customerPhone,
        message: "show me the menu"
      },
      {
        cancelCustomerClarifications: async (input) => {
          cancellations.push(input);
        },
        runOrchestrator: async () => {
          orchestratorCalls += 1;
          return makeAgentResult({
            executedTools: [{ name: "get_menu", success: true }]
          });
        }
      }
    );

    assert.deepEqual(cancellations, [{ restaurantId, senderPhone: customerPhone }]);
    assert.equal(orchestratorCalls, 1);
  });
});

test("only exact numbered check-in replies use the deterministic pre-AI boundary", () => {
  assert.equal(isExactOrderCheckInReply("1"), true);
  assert.equal(isExactOrderCheckInReply("3."), true);
  assert.equal(isExactOrderCheckInReply("I want 2 fried rice"), false);
  assert.equal(isExactOrderCheckInReply("I received it and it was nice"), false);
});

test("a pending check-in cannot hijack an unrelated new customer order", async () => {
  await withCustomerRoutingHarness(async () => {
    let feedbackCalls = 0;
    const orchestratorMessages = [];

    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: customerPhone,
        message: "I want 2 fried rice"
      },
      {
        handleCustomerFeedback: async () => {
          feedbackCalls += 1;
          return { handled: true, success: true, message: "wrong path" };
        },
        runOrchestrator: async (input) => {
          orchestratorMessages.push(input.message);
          return makeAgentResult({
            executedTools: [
              { name: "add_order_item_by_name", success: true }
            ]
          });
        }
      }
    );

    assert.equal(feedbackCalls, 0);
    assert.deepEqual(orchestratorMessages, ["I want 2 fried rice"]);
    assert.equal(response.source, "openrouter_agent");
  });
});

for (const scenario of [
  { step: "collecting_quantity", message: "2" },
  { step: "selecting_item_from_category", message: "1" },
  { step: "choosing_items", message: "2" }
]) {
  test(`an exact ${scenario.message} reaches customer AI while the draft is ${scenario.step}`, async () => {
    await withCustomerRoutingHarness(async () => {
      let feedbackCalls = 0;
      const orchestratorMessages = [];

      const response = await handleRestaurantAgentMessage(
        {
          restaurant: makeRestaurant(),
          senderPhone: customerPhone,
          message: scenario.message
        },
        {
          findCustomerDraft: async () => ({ currentStep: scenario.step }),
          handleCustomerFeedback: async () => {
            feedbackCalls += 1;
            return { handled: true, success: true, message: "wrong old-order mutation" };
          },
          runOrchestrator: async (input) => {
            orchestratorMessages.push(input.message);
            return makeAgentResult();
          }
        }
      );

      assert.equal(feedbackCalls, 0);
      assert.deepEqual(orchestratorMessages, [scenario.message]);
      assert.equal(response.source, "openrouter_agent");
    });
  });
}

test("an exact numbered response remains safely handled before customer AI", async () => {
  await withCustomerRoutingHarness(async () => {
    let feedbackCalls = 0;
    let orchestratorCalls = 0;

    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: customerPhone,
        message: "1"
      },
      {
        findCustomerDraft: async () => null,
        handleCustomerFeedback: async () => {
          feedbackCalls += 1;
          return {
            handled: true,
            success: true,
            message: "Thanks for confirming. Your order is now marked complete."
          };
        },
        runOrchestrator: async () => {
          orchestratorCalls += 1;
          return makeAgentResult();
        }
      }
    );

    assert.equal(feedbackCalls, 1);
    assert.equal(orchestratorCalls, 0);
    assert.match(response.message, /marked complete/i);
  });
});

test("a bare quantity-like number with an active draft and check-in mutates neither workflow", async () => {
  await withCustomerRoutingHarness(async () => {
    const draft = {
      currentStep: "collecting_quantity",
      pendingMenuItemName: "Special Noodles",
      cartItems: []
    };
    let feedbackCalls = 0;
    let orchestratorCalls = 0;

    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: customerPhone,
        message: "1"
      },
      {
        findCustomerDraft: async () => draft,
        loadCustomerCheckIns: async () => [
          {
            orderNumber: "ORD-123",
            orderType: "delivery",
            status: "accepted",
            checkInStatus: "requested",
            awaitingComplaint: false,
            receiptClarificationPending: false
          }
        ],
        handleCustomerFeedback: async () => {
          feedbackCalls += 1;
          return { handled: true, success: true, message: "wrong mutation" };
        },
        runOrchestrator: async () => {
          orchestratorCalls += 1;
          return makeAgentResult();
        }
      }
    );

    assert.equal(feedbackCalls, 0);
    assert.equal(orchestratorCalls, 0);
    assert.equal(response.data.workflowClarificationRequired, true);
    assert.match(response.message, /quantity.*Special Noodles/i);
    assert.match(response.message, /ORD-123/);
    assert.equal(draft.cartItems.length, 0);
  });
});

test("a quoted numbered reply can safely select the old feedback workflow", async () => {
  await withCustomerRoutingHarness(async () => {
    const draft = {
      currentStep: "collecting_quantity",
      pendingMenuItemName: "Special Noodles",
      cartItems: []
    };
    let feedbackInput;
    let orchestratorCalls = 0;

    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: customerPhone,
        message: "1",
        quotedMessageId: "provider-feedback-message-1"
      },
      {
        findCustomerDraft: async () => draft,
        loadCustomerCheckIns: async () => [
          {
            orderNumber: "ORD-123",
            orderType: "delivery",
            status: "accepted",
            checkInStatus: "requested",
            awaitingComplaint: false,
            receiptClarificationPending: false
          }
        ],
        resolveQuotedCustomerFeedback: async () =>
          "64b000000000000000000123",
        handleCustomerFeedback: async (input) => {
          feedbackInput = input;
          return {
            handled: true,
            success: true,
            message: "Thanks for confirming the earlier order."
          };
        },
        runOrchestrator: async () => {
          orchestratorCalls += 1;
          return makeAgentResult();
        }
      }
    );

    assert.equal(response.success, true);
    assert.equal(
      feedbackInput.trustedOrderId,
      "64b000000000000000000123"
    );
    assert.equal(orchestratorCalls, 0);
    assert.equal(draft.cartItems.length, 0);
    assert.equal(draft.currentStep, "collecting_quantity");
  });
});

for (const feedbackMessage of [
  "I have received my previous order. I really enjoyed the meal.",
  "I received the previous order but the food was cold.",
  "I still haven't received my previous order."
]) {
  test(`explicit natural feedback ${JSON.stringify(feedbackMessage)} leaves a concurrent draft unchanged`, async () => {
    await withCustomerRoutingHarness(async () => {
      const draft = {
        currentStep: "choosing_order_type",
        cartItems: [
          {
            name: "Special Noodles",
            quantity: 1
          }
        ]
      };
      const before = structuredClone(draft);
      let feedbackCalls = 0;
      let orchestratorCalls = 0;

      const response = await handleRestaurantAgentMessage(
        {
          restaurant: makeRestaurant(),
          senderPhone: customerPhone,
          message: feedbackMessage
        },
        {
          findCustomerDraft: async () => draft,
          handleCustomerFeedback: async () => {
            feedbackCalls += 1;
            return {
              handled: true,
              success: true,
              message: "Thanks for the feedback. We shared it with the restaurant."
            };
          },
          runOrchestrator: async () => {
            orchestratorCalls += 1;
            return makeAgentResult();
          }
        }
      );

      assert.equal(response.success, true);
      assert.equal(feedbackCalls, 1);
      assert.equal(orchestratorCalls, 0);
      assert.deepEqual(draft, before);
    });
  });
}

test("exact not-received response remains deterministic without an active draft", async () => {
  await withCustomerRoutingHarness(async () => {
    let feedbackCalls = 0;
    let orchestratorCalls = 0;

    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: customerPhone,
        message: "3"
      },
      {
        findCustomerDraft: async () => null,
        handleCustomerFeedback: async ({ message }) => {
          feedbackCalls += 1;
          assert.equal(message, "3");
          return {
            handled: true,
            success: true,
            message: "I've alerted the restaurant. This order remains open."
          };
        },
        runOrchestrator: async () => {
          orchestratorCalls += 1;
          return makeAgentResult();
        }
      }
    );

    assert.equal(feedbackCalls, 1);
    assert.equal(orchestratorCalls, 0);
    assert.match(response.message, /remains open/i);
  });
});

test("explicit legacy fallback runs only after an AI failure", async () => {
  await withCustomerRoutingHarness(
    async ({ logs }) => {
      let legacyCalls = 0;
      const response = await handleRestaurantAgentMessage(
        {
          restaurant: makeRestaurant(),
          senderPhone: customerPhone,
          message: "please help"
        },
        {
          runOrchestrator: async () =>
            makeAgentResult({ success: false, message: "AI unavailable" }),
          handleLegacyCustomerMessage: async () => {
            legacyCalls += 1;
            return { success: true, message: "Legacy rollback response" };
          }
        }
      );

      assert.equal(legacyCalls, 1);
      assert.equal(response.source, "legacy_customer");
      assert.equal(
        logs.some(({ args }) => args[0] === "[customerAgent] legacy fallback used"),
        true
      );
    },
    { OPENROUTER_CUSTOMER_LEGACY_FALLBACK: "true" }
  );
});

test("legacy fallback is suppressed after a successful AI customer mutation", async () => {
  await withCustomerRoutingHarness(
    async ({ logs }) => {
      let legacyCalls = 0;
      const response = await handleRestaurantAgentMessage(
        {
          restaurant: makeRestaurant(),
          senderPhone: customerPhone,
          message: "add 2 chicken salad"
        },
        {
          runOrchestrator: async () =>
            makeAgentResult({
              success: false,
              message: "Please continue.",
              executedTools: [
                { name: "add_order_item_by_name", success: true }
              ]
            }),
          handleLegacyCustomerMessage: async () => {
            legacyCalls += 1;
            return { success: true, message: "should not run" };
          }
        }
      );

      assert.equal(legacyCalls, 0);
      assert.equal(response.source, "openrouter_agent");
      assert.equal(
        logs.some(
          ({ args }) =>
            args[0] === "[customerAgent] legacy fallback suppressed after mutation"
        ),
        true
      );
    },
    { OPENROUTER_CUSTOMER_LEGACY_FALLBACK: "true" }
  );
});

test("customer HTTP compatibility service validates scope then routes through the shared agent", async () => {
  const calls = [];
  const response = await handleCustomerCompatibilityMessage(
    {
      restaurantId,
      customerPhone,
      customerName: "Ruth",
      message: "gimme 2 jollof"
    },
    {
      findRestaurant: async () => makeRestaurant(),
      handleRestaurantMessage: async (input) => {
        calls.push(input);
        return { success: true, message: "AI-first", source: "openrouter_agent" };
      }
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].customerName, "Ruth");
  assert.equal(calls[0].message, "gimme 2 jollof");
  assert.equal(response.source, "openrouter_agent");
});

const runImageOrchestrator = async ({ responses, history = [], executeTool }) => {
  let index = 0;
  const providerRequests = [];
  const savedMessages = [];
  const provider = {
    name: "openrouter",
    model: "test-model",
    async complete(request) {
      providerRequests.push(request);
      return responses[index++];
    }
  };

  const result = await runAgentOrchestrator(
    {
      restaurant: makeRestaurant(),
      sender: {
        phone: customerPhone,
        normalizedPhone: customerPhone,
        role: "customer",
        verified: false
      },
      message: "any pic of it?"
    },
    {
      provider,
      getHistory: async () => history,
      saveMessage: async (message) => savedMessages.push(message),
      buildSystemPrompt: async () => "customer production prompt",
      executeTool
    }
  );

  return { result, providerRequests, savedMessages };
};

test("one customer turn cannot mutate both feedback and the active order", async () => {
  const executedBackendTools = [];
  const { result } = await runImageOrchestrator({
    responses: [
      {
        text: null,
        toolCalls: [
          {
            id: "feedback-mutation",
            name: "respond_to_order_check_in",
            arguments: { outcome: "received_satisfied" }
          },
          {
            id: "draft-mutation",
            name: "update_order_draft",
            arguments: { orderType: "pickup" }
          }
        ]
      },
      {
        text: "Please clarify which workflow you mean.",
        toolCalls: []
      }
    ],
    executeTool: async (toolName) => {
      executedBackendTools.push(toolName);
      return {
        success: true,
        message: "Mutation completed."
      };
    }
  });

  assert.deepEqual(executedBackendTools, ["respond_to_order_check_in"]);
  assert.equal(result.executedTools[0].success, true);
  assert.equal(result.executedTools[1].success, false);
  assert.equal(
    result.executedTools[1].code,
    "CUSTOMER_WORKFLOW_CONFLICT"
  );
});

test("contextual image lookup keeps URL outside model text and prepares trusted media", async () => {
  const { result, savedMessages } = await runImageOrchestrator({
    history: [
      { role: "user", content: "Tell me about Chicken Salad." },
      { role: "assistant", content: "Chicken Salad is fresh and filling." }
    ],
    responses: [
      {
        toolCalls: [
          {
            id: "image-search",
            name: "search_menu_items",
            arguments: { query: "Chicken Salad", includeImage: true }
          }
        ]
      },
      { text: "Here is Chicken Salad.", toolCalls: [] }
    ],
    executeTool: async () => ({
      success: true,
      message: "Menu search completed.",
      data: [
        {
          id: "menu-chicken",
          name: "Chicken Salad",
          price: 35,
          available: true,
          imageUrl
        }
      ]
    })
  });

  assert.equal(result.data.menuItemImage.imageUrl, imageUrl);
  assert.equal(result.data.menuItemImage.caption, "Chicken Salad");
  assert.equal(result.data.menuItemImage.menuItemId, "menu-chicken");
  const toolContent = savedMessages.find(({ direction }) => direction === "tool").content;
  assert.doesNotMatch(toolContent, /cloudinary|https?:\/\//i);
  assert.match(toolContent, /"hasImage":true/);
});

test("ambiguous contextual image reference clarifies without choosing a random item", async () => {
  const { result } = await runImageOrchestrator({
    history: [
      { role: "assistant", content: "We have Jollof, Fried Rice, and Chicken Salad." }
    ],
    responses: [
      { text: "Which item would you like to see?", toolCalls: [] }
    ],
    executeTool: async () => {
      throw new Error("ambiguous image request must not execute a tool");
    }
  });

  assert.match(result.message, /which item/i);
  assert.deepEqual(result.executedTools, []);
  assert.equal(result.data, undefined);
});

test("false image-access claim is retried through the trusted menu lookup", async () => {
  let toolCalls = 0;
  const { result, providerRequests } = await runImageOrchestrator({
    responses: [
      { text: "I don't have access to images of menu items.", toolCalls: [] },
      {
        toolCalls: [
          {
            id: "retry-image-search",
            name: "search_menu_items",
            arguments: { query: "Chicken Salad", includeImage: true }
          }
        ]
      },
      { text: "Here is Chicken Salad.", toolCalls: [] }
    ],
    executeTool: async () => {
      toolCalls += 1;
      return {
        success: true,
        message: "Menu search completed.",
        data: [{ id: "menu-chicken", name: "Chicken Salad", imageUrl }]
      };
    }
  });

  assert.equal(providerRequests.length, 3);
  assert.equal(toolCalls, 1);
  assert.equal(result.data.menuItemImage.imageUrl, imageUrl);
});

test("grounded no-image result exposes hasImage false but never an image URL", async () => {
  const { result, savedMessages } = await runImageOrchestrator({
    responses: [
      {
        toolCalls: [
          {
            id: "no-image-search",
            name: "search_menu_items",
            arguments: { query: "Chicken Salad", includeImage: true }
          }
        ]
      },
      {
        text: "I don't have a picture of Chicken Salad at the moment.",
        toolCalls: []
      }
    ],
    executeTool: async () => ({
      success: true,
      message: "Menu search completed.",
      data: [{ id: "menu-chicken", name: "Chicken Salad", imageUrl: undefined }]
    })
  });

  assert.equal(result.success, true);
  assert.equal(result.data, undefined);
  const toolContent = savedMessages.find(({ direction }) => direction === "tool").content;
  assert.match(toolContent, /"hasImage":false/);
  assert.doesNotMatch(toolContent, /https?:\/\//i);
});

test("trusted backend image payload queues one media message with a safe reply caption", async () => {
  const calls = [];
  await enqueueTrustedMenuItemImageReply(
    {
      restaurantId,
      sessionId: "session",
      to: customerPhone,
      delivery: {
        menuItemId: "menu-chicken",
        imageUrl,
        caption: "Chicken Salad",
        source: "search_menu_items_tool"
      },
      agentMessage: `Here it is: ${imageUrl}`,
      eventId: "webhook-message-1",
      apiKey: "restaurant-token"
    },
    async (input) => {
      calls.push(input);
      return input;
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "image");
  assert.equal(calls[0].imageUrl, imageUrl);
  assert.equal(calls[0].caption, "Here is Chicken Salad.");
  assert.doesNotMatch(calls[0].caption, /https?:\/\//i);
  assert.equal(
    calls[0].idempotencyKey,
    `send_restaurant_agent_image:webhook-message-1:${customerPhone}`
  );
});

test("explicit clarification resets are intentionally narrow", () => {
  assert.equal(isExplicitCustomerClarificationResetMessage("start over"), true);
  assert.equal(isExplicitCustomerClarificationResetMessage("Please show me the menu!"), true);
  assert.equal(isExplicitCustomerClarificationResetMessage("the second dish"), false);
  assert.equal(isExplicitCustomerClarificationResetMessage("I mean the Chicken Salad"), false);
});

test("only an explicitly trusted media payload is accepted for outbound delivery", () => {
  assert.equal(
    getTrustedMenuItemImageDelivery({
      menuItemImage: {
        menuItemId: "menu-chicken",
        imageUrl,
        caption: "Chicken Salad",
        source: "search_menu_items_tool"
      }
    }).imageUrl,
    imageUrl
  );
  assert.equal(
    getTrustedMenuItemImageDelivery({
      menuItemImage: { imageUrl, caption: "Chicken Salad", source: "model_text" }
    }),
    undefined
  );
});

test("customer role tool definitions exclude every staff-only operation", () => {
  const names = new Set(
    getAgentToolDefinitionsForRole("customer").map((tool) => tool.function.name)
  );

  for (const forbidden of [
    "update_menu_price",
    "set_item_availability",
    "get_business_report",
    "confirm_order",
    "reject_order",
    "start_menu_item_image_upload"
  ]) {
    assert.equal(names.has(forbidden), false, forbidden);
  }
  assert.equal(names.has("search_menu_items"), true);
  assert.equal(names.has("add_order_item_by_name"), true);
});

test("customer eval suite is bounded, decision-only, and accepts correct mocked decisions", async () => {
  assert.equal(customerAgentScenarios.length >= 30, true);
  assert.equal(customerAgentScenarios.length <= 40, true);
  let decisions = 0;
  const result = await runCustomerAgentEvaluation(
    customerAgentScenarios,
    async (scenario) => {
      decisions += 1;
      if (scenario.expectNoTool) {
        return {
          text: scenario.expectedTextPattern
            ? scenario.name.includes("check-ins")
              ? "Which order do you mean: ORD-100 or ORD-101?"
              : "Which item would you like to see?"
            : "Happy to help.",
          toolCalls: []
        };
      }

      const name = scenario.expectedTool ?? scenario.expectedOneOfTools[0];
      return {
        toolCalls: [
          {
            id: `mock-${decisions}`,
            name,
            arguments: { ...(scenario.expectedArguments ?? {}) }
          }
        ]
      };
    }
  );

  assert.equal(decisions, customerAgentScenarios.length);
  assert.equal(result.failed, 0);
});

test("customer evaluator rejects an invented quantity", () => {
  const scenario = customerAgentScenarios.find(
    ({ name }) => name === "Item without quantity"
  );
  const reasons = evaluateCustomerAgentDecision(scenario, {
    toolCalls: [
      {
        id: "invented-quantity",
        name: "add_order_item_by_name",
        arguments: { itemName: "assorted fried rice", quantity: 1 }
      }
    ]
  });

  assert.equal(reasons.some((reason) => /forbidden argument/i.test(reason)), true);
});

test("live customer eval prompt uses production customer state hierarchy", async () => {
  const scenario = customerAgentScenarios.find(
    ({ name }) => name === "Quantity follow-up"
  );
  const prompt = await buildLiveCustomerEvalSystemPrompt(scenario);

  assert.match(prompt, /"customerState"/);
  assert.match(prompt, /"activeDraft"/);
  assert.match(prompt, /"pendingItem"/);
  assert.match(prompt, /Assorted Fried Rice/);
  assert.match(prompt, /Active draft and clarification records are more authoritative/);
  assert.match(prompt, /Customer memory.*must never override/i);
});

test("production customer prompt receives the active trusted clarification", async () => {
  const prompt = await buildAgentSystemPrompt(
    makeRestaurant(),
    { role: "customer", normalizedPhone: customerPhone, verified: false },
    ["search_menu_items"],
    {
      buildRestaurantContext: async () => ({
        restaurant: { name: "Golden Grill", cuisine: "Local", status: "active" },
        sender: { role: "customer", verified: false },
        settings: {},
        summary: {},
        permissions: ["search_menu_items"]
      }),
      findDraft: async () => null,
      findClarification: async () => ({
        intent: "add_item",
        originalText: "add chicken",
        candidates: [
          {
            menuItemId: "64b000000000000000000111",
            name: "Chicken Salad",
            available: true
          },
          {
            menuItemId: "64b000000000000000000112",
            name: "Chicken Jollof",
            available: true
          }
        ]
      }),
      loadCustomerMemory: async () => null,
      loadActiveCheckIns: async () => [
        {
          orderNumber: "ORD-100",
          orderType: "delivery",
          status: "accepted",
          checkInStatus: "requested",
          awaitingComplaint: false,
          receiptClarificationPending: false
        }
      ]
    }
  );

  assert.match(prompt, /"activeClarification"/);
  assert.match(prompt, /"originalText":"add chicken"/);
  assert.match(prompt, /Chicken Salad/);
  assert.match(prompt, /Chicken Jollof/);
  assert.match(prompt, /"activeOrderCheckIns"/);
  assert.match(prompt, /ORD-100/);
  assert.match(prompt, /separate workflows/i);
  assert.match(prompt, /never guess.*1, 2, 3, yes, or ok/i);
  assert.match(prompt, /never mutate both/i);
});
