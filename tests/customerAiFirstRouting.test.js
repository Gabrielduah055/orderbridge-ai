const assert = require("node:assert/strict");
const test = require("node:test");

const { AgentConversationMessage } = require("../dist/models/agentConversation.model");
const { Order } = require("../dist/models/order.model");
const {
  handleRestaurantAgentMessage,
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
  getAgentToolDefinitionsForRole
} = require("../dist/services/ai/agentToolDefinitions.service");
const {
  sendMenuItemImage,
  buildMenuItemImageFallbackMessage,
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

test("trusted backend image payload sends the actual WhatsApp image", async () => {
  const calls = [];
  const sent = await sendMenuItemImage(
    "session",
    customerPhone,
    imageUrl,
    "Chicken Salad",
    "restaurant-token",
    async (...args) => {
      calls.push(args);
      return { success: true, status: 200 };
    },
    { restaurantId, customerPhone, menuItemId: "menu-chicken", menuItemName: "Chicken Salad" }
  );

  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], imageUrl);
  assert.equal(calls[0][3], "Chicken Salad");
});

test("WaSender image failure returns the existing safe text fallback without a URL", async () => {
  const sent = await sendMenuItemImage(
    "session",
    customerPhone,
    imageUrl,
    "Chicken Salad",
    undefined,
    async () => ({ success: false, status: 503, error: "provider unavailable" })
  );
  const fallback = buildMenuItemImageFallbackMessage("Here is Chicken Salad.");

  assert.equal(sent, false);
  assert.match(fallback, /couldn't send the image right now/i);
  assert.doesNotMatch(fallback, /https?:\/\//i);
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
            ? "Which item would you like to see?"
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
