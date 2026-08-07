const assert = require("node:assert/strict");
const test = require("node:test");

const { AgentConversationMessage } = require("../dist/models/agentConversation.model");
const {
  handleRestaurantAgentMessage,
  parseOwnerOrderDecision,
  shouldUseAiFirstStaffTextRouting
} = require("../dist/services/restaurantAgent.service");
const {
  isToolAllowedForRole
} = require("../dist/agent-tools/tool.permissions");

const restaurantId = "64b000000000000000000d01";
const ownerPhone = "+233507879374";
const managerPhone = "+233241234567";

const makeRestaurant = () => ({
  _id: restaurantId,
  name: "Golden Grill",
  ownerName: "Gabriel",
  ownerPhone,
  managerPhones: [managerPhone],
  managerContacts: [],
  status: "active",
  timezone: "Africa/Accra",
  wasenderSessionId: "golden-session"
});

const makeAgentResult = (overrides = {}) => ({
  success: true,
  message: "AI handled the message.",
  provider: "openrouter",
  model: "test-model",
  executedTools: [],
  ...overrides
});

const runWithRoutingHarness = async (callback) => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalCreate = AgentConversationMessage.create;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const savedMessages = [];
  const logs = [];

  process.env.AI_PROVIDER = "openrouter";
  AgentConversationMessage.create = async (input) => {
    savedMessages.push(input);
    return input;
  };
  console.info = (...args) => logs.push({ level: "info", args });
  console.warn = (...args) => logs.push({ level: "warn", args });

  try {
    return await callback({ savedMessages, logs });
  } finally {
    if (originalProvider === undefined) {
      delete process.env.AI_PROVIDER;
    } else {
      process.env.AI_PROVIDER = originalProvider;
    }

    AgentConversationMessage.create = originalCreate;
    console.info = originalInfo;
    console.warn = originalWarn;
  }
};

const unhandledImageReply = async () => ({
  handled: false,
  success: false,
  message: ""
});

const unhandledSelection = async () => ({
  handled: false,
  success: false,
  message: ""
});

test("owner text reaches the orchestrator before owner order parsing", async () => {
  await runWithRoutingHarness(async () => {
    const events = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "Accept ORD-123"
      },
      {
        runOrchestrator: async () => {
          events.push("ai");
          return makeAgentResult({
            success: false,
            message: "Provider unavailable.",
            errorCode: "PROVIDER_TIMEOUT"
          });
        },
        handlePendingImageReply: unhandledImageReply,
        rememberImageRequest: unhandledImageReply,
        handleSavedSelection: unhandledSelection,
        parseSimpleDecision: () => null,
        parseOrderDecision: (message) => {
          events.push("parseOwnerOrderDecision");
          return parseOwnerOrderDecision(message);
        },
        executeTool: async (toolName) => {
          events.push(toolName);
          return { success: true, message: "Order accepted.", data: {} };
        }
      }
    );

    assert.deepEqual(events, ["ai", "parseOwnerOrderDecision", "confirm_order"]);
    assert.equal(response.success, true);
    assert.equal(response.source, "legacy_owner");
  });
});

test("manager text reaches the orchestrator before deterministic image reply handling", async () => {
  await runWithRoutingHarness(async () => {
    const events = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: managerPhone,
        message: "yeah, use it for Chicken Salad"
      },
      {
        runOrchestrator: async () => {
          events.push("ai");
          return makeAgentResult({ success: false, errorCode: "PROVIDER_TIMEOUT" });
        },
        findLatestPendingAction: async () => null,
        handlePendingImageReply: async () => {
          events.push("pendingImageReply");
          return {
            handled: true,
            success: true,
            message: "Done — I added the uploaded image to Chicken Salad."
          };
        }
      }
    );

    assert.deepEqual(events, ["ai", "pendingImageReply"]);
    assert.equal(response.source, "legacy_owner");
  });
});

test("a successful staff AI response prevents every legacy handler and saves one reply", async () => {
  await runWithRoutingHarness(async ({ savedMessages, logs }) => {
    let orchestratorCalls = 0;
    const shouldNotRun = () => {
      throw new Error("legacy handler ran after successful AI response");
    };
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "I want to change the chicken salad price"
      },
      {
        runOrchestrator: async () => {
          orchestratorCalls += 1;
          return makeAgentResult();
        },
        hasPendingImageAction: async () => false,
        handlePendingImageReply: shouldNotRun,
        rememberImageRequest: shouldNotRun,
        handleSavedSelection: shouldNotRun,
        parseOrderDecision: shouldNotRun,
        parseSimpleDecision: shouldNotRun
      }
    );

    assert.equal(orchestratorCalls, 1);
    assert.equal(response.source, "openrouter_agent");
    assert.equal(
      savedMessages.filter(({ direction }) => direction === "assistant").length,
      1
    );
    assert.equal(
      logs.some(({ args }) => args[0] === "[restaurantAgent] staff text routing"),
      true
    );
  });
});

test("OpenRouter failure preserves the deterministic image-intent text fallback", async () => {
  await runWithRoutingHarness(async () => {
    const events = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: managerPhone,
        message: "Add an image to Check Check Fried Rice"
      },
      {
        runOrchestrator: async () => {
          events.push("ai");
          return makeAgentResult({ success: false, errorCode: "OPENROUTER_HTTP_ERROR" });
        },
        handlePendingImageReply: unhandledImageReply,
        rememberImageRequest: async () => {
          events.push("rememberImageRequest");
          return {
            handled: true,
            success: true,
            message: "Please send the image you'd like to use for Check Check Fried Rice."
          };
        }
      }
    );

    assert.deepEqual(events, ["ai", "rememberImageRequest"]);
    assert.equal(response.success, true);
    assert.equal(response.source, "legacy_owner");
  });
});

test("a conversational owner message reaches AI without image or menu parsing", async () => {
  await runWithRoutingHarness(async () => {
    let legacyCalls = 0;
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "you there?"
      },
      {
        runOrchestrator: async () => makeAgentResult({ message: "Yes, I'm here." }),
        hasPendingImageAction: async () => false,
        handlePendingImageReply: async () => {
          legacyCalls += 1;
          return unhandledImageReply();
        },
        rememberImageRequest: async () => {
          legacyCalls += 1;
          return unhandledImageReply();
        }
      }
    );

    assert.equal(response.message, "Yes, I'm here.");
    assert.equal(legacyCalls, 0);
  });
});

test("pending mutation confirmation falls back safely after a no-tool AI answer", async () => {
  await runWithRoutingHarness(async () => {
    const events = [];
    const pendingAction = { _id: "64b000000000000000000d11" };
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "yes, go ahead"
      },
      {
        runOrchestrator: async () => {
          events.push("ai");
          return makeAgentResult({ message: "Done." });
        },
        hasPendingImageAction: async () => false,
        findLatestPendingAction: async () => pendingAction,
        findPendingActions: async () => [pendingAction],
        handlePendingImageReply: unhandledImageReply,
        rememberImageRequest: unhandledImageReply,
        handleSavedSelection: unhandledSelection,
        parseOrderDecision: () => null,
        parseSimpleDecision: () => null,
        executeConfirmedAction: async () => {
          events.push("executeConfirmedPendingAction");
          return { success: true, message: "Price updated." };
        }
      }
    );

    assert.deepEqual(events, ["ai", "executeConfirmedPendingAction"]);
    assert.equal(response.message, "Price updated.");
    assert.equal(response.source, "legacy_owner");
  });
});

test("tool activity consumes a staff turn even if the provider fails afterward", async () => {
  await runWithRoutingHarness(async ({ savedMessages }) => {
    let legacyCalls = 0;
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "Change Chicken Salad to 65 cedis"
      },
      {
        runOrchestrator: async () =>
          makeAgentResult({
            success: false,
            message: "The provider failed after the tool call.",
            errorCode: "PROVIDER_TIMEOUT",
            executedTools: [
              {
                name: "update_menu_price",
                success: true,
                requiresConfirmation: true,
                pendingActionId: "64b000000000000000000d12"
              }
            ]
          }),
        handlePendingImageReply: async () => {
          legacyCalls += 1;
          return unhandledImageReply();
        }
      }
    );

    assert.equal(legacyCalls, 0);
    assert.equal(response.source, "openrouter_agent");
    assert.equal(
      savedMessages.filter(({ direction }) => direction === "assistant").length,
      1
    );
  });
});

test("a successful no-tool AI answer cannot bypass an active pending image workflow", async () => {
  await runWithRoutingHarness(async () => {
    const events = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: managerPhone,
        message: "yeah, use it"
      },
      {
        runOrchestrator: async () => {
          events.push("ai");
          return makeAgentResult({ message: "Done." });
        },
        hasPendingImageAction: async () => true,
        findLatestPendingAction: async () => null,
        handlePendingImageReply: async () => {
          events.push("pendingImageReply");
          return {
            handled: true,
            success: true,
            message: "Done — I added the uploaded image."
          };
        }
      }
    );

    assert.deepEqual(events, ["ai", "pendingImageReply"]);
    assert.equal(response.message, "Done — I added the uploaded image.");
    assert.equal(response.source, "legacy_owner");
  });
});

test("AI-first routing is staff-only and existing role permissions remain authoritative", () => {
  assert.equal(shouldUseAiFirstStaffTextRouting("owner", "openrouter"), true);
  assert.equal(shouldUseAiFirstStaffTextRouting("manager", "openrouter"), true);
  assert.equal(shouldUseAiFirstStaffTextRouting("customer", "openrouter"), false);
  assert.equal(shouldUseAiFirstStaffTextRouting("owner", "hermes"), false);

  assert.equal(isToolAllowedForRole("update_menu_price", "owner"), true);
  assert.equal(isToolAllowedForRole("update_menu_price", "manager"), false);
  assert.equal(isToolAllowedForRole("add_menu_items", "owner"), true);
  assert.equal(isToolAllowedForRole("add_menu_items", "manager"), false);
  assert.equal(isToolAllowedForRole("confirm_order", "manager"), true);
});
