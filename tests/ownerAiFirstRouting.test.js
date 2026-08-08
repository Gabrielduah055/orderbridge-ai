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

const makeStaffState = (overrides = {}) => ({
  pendingActions: [],
  imageWorkflow: null,
  orders: { freshPending: [], recentActive: [] },
  recentReferences: {},
  permissions: ["confirm_order", "reject_order"],
  ...overrides
});

const buildEmptyStaffState = async () => makeStaffState();

const runWithRoutingHarness = async (callback) => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalCreate = AgentConversationMessage.create;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  const savedMessages = [];
  const logs = [];

  process.env.AI_PROVIDER = "openrouter";
  AgentConversationMessage.create = async (input) => {
    savedMessages.push(input);
    return input;
  };
  console.info = (...args) => logs.push({ level: "info", args });
  console.warn = (...args) => logs.push({ level: "warn", args });
  console.error = (...args) => logs.push({ level: "error", args });

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
    console.error = originalError;
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

const makeOrderSafetyDependencies = (overrides = {}) => ({
  handlePendingImageReply: unhandledImageReply,
  rememberImageRequest: unhandledImageReply,
  handleSavedSelection: unhandledSelection,
  findLatestPendingAction: async () => null,
  ...overrides
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
        buildStaffState: buildEmptyStaffState,
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
        buildStaffState: buildEmptyStaffState,
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
        buildStaffState: buildEmptyStaffState,
        runOrchestrator: async () => {
          orchestratorCalls += 1;
          return makeAgentResult();
        },
        getPendingImageStage: async () => null,
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

test("quoted provider message ID is passed to the staff state builder", async () => {
  await runWithRoutingHarness(async () => {
    const quotedMessageId = "provider-order-message-102";
    let stateBuilderInput;
    let orchestratorInput;
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "reject this, no chicken left",
        quotedMessageId
      },
      {
        buildStaffState: async (input) => {
          stateBuilderInput = input;
          return makeStaffState({
            recentReferences: {
              quotedOrder: {
                id: "order-102",
                orderNumber: "ORD-102",
                status: "pending"
              }
            }
          });
        },
        runOrchestrator: async (input) => {
          orchestratorInput = input;
          return makeAgentResult({
            executedTools: [
              {
                name: "reject_order",
                success: true,
                resultOrderId: "order-102",
                resultOrderNumber: "ORD-102",
                resultOrderStatus: "rejected"
              }
            ]
          });
        }
      }
    );

    assert.equal(stateBuilderInput.quotedMessageId, quotedMessageId);
    assert.equal(
      orchestratorInput.staffState.recentReferences.quotedOrder.orderNumber,
      "ORD-102"
    );
    assert.equal(response.source, "openrouter_agent");
  });
});

test("OpenRouter failure preserves the deterministic image-intent text fallback", async () => {
  await runWithRoutingHarness(async ({ logs }) => {
    const events = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: managerPhone,
        message: "Add an image to Check Check Fried Rice"
      },
      {
        buildStaffState: buildEmptyStaffState,
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
    assert.equal(
      logs.some(
        ({ args }) =>
          args[0] === "[imageWorkflow] legacy fallback" &&
          args[1]?.reason === "OPENROUTER_HTTP_ERROR"
      ),
      true
    );
  });
});

test("an awaiting-item image does not hijack an ordinary conversational message", async () => {
  await runWithRoutingHarness(async () => {
    let legacyCalls = 0;
    let receivedStaffState;
    const staffState = makeStaffState({
      imageWorkflow: {
        active: true,
        type: "menu_item_image",
        stage: "awaiting_item",
        imageUploaded: true,
        pendingActionId: "image-awaiting-item"
      }
    });
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "you there?"
      },
      {
        buildStaffState: async () => staffState,
        runOrchestrator: async (input) => {
          receivedStaffState = input.staffState;
          return makeAgentResult({ message: "Yes, I'm here." });
        },
        getPendingImageStage: async () => "awaiting_item",
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
    assert.equal(response.source, "openrouter_agent");
    assert.equal(legacyCalls, 0);
    assert.equal(receivedStaffState.imageWorkflow.stage, "awaiting_item");
  });
});

test("what do you mean leaves an active image workflow untouched", async () => {
  await runWithRoutingHarness(async () => {
    let legacyCalls = 0;
    const staffState = makeStaffState({
      imageWorkflow: {
        active: true,
        type: "menu_item_image",
        stage: "awaiting_confirmation",
        imageUploaded: true,
        itemName: "Chicken Salad",
        pendingActionId: "64b000000000000000000901"
      }
    });
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "what do you mean?"
      },
      {
        buildStaffState: async () => staffState,
        runOrchestrator: async () =>
          makeAgentResult({ message: "I was referring to the pending image choice." }),
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

    assert.equal(response.source, "openrouter_agent");
    assert.equal(legacyCalls, 0);
  });
});

test("successful typed image tool execution bypasses every legacy image parser", async () => {
  await runWithRoutingHarness(async () => {
    const shouldNotRun = () => {
      throw new Error("legacy image parser executed after typed tool success");
    };
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "it belongs to Chicken Salad"
      },
      {
        buildStaffState: async () =>
          makeStaffState({
            imageWorkflow: {
              active: true,
              type: "menu_item_image",
              stage: "awaiting_item",
              imageUploaded: true,
              pendingActionId: "64b000000000000000000901"
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({
            message: "Use the uploaded image for Chicken Salad?",
            executedTools: [
              {
                name: "assign_pending_image_to_menu_item",
                success: true,
                requiresConfirmation: true,
                pendingActionId: "64b000000000000000000901"
              }
            ]
          }),
        handlePendingImageReply: shouldNotRun,
        rememberImageRequest: shouldNotRun
      }
    );

    assert.equal(response.source, "openrouter_agent");
    assert.match(response.message, /Chicken Salad/);
  });
});

test("actionable awaiting-item reply falls back when AI returns text without the assignment tool", async () => {
  await runWithRoutingHarness(async ({ logs }) => {
    const events = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "it belongs to Chicken Salad"
      },
      {
        buildStaffState: async () =>
          makeStaffState({
            imageWorkflow: {
              active: true,
              type: "menu_item_image",
              stage: "awaiting_item",
              imageUploaded: true,
              pendingActionId: "64b000000000000000000901"
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({
            message: "Done — I assigned it to Chicken Salad.",
            executedTools: []
          }),
        handlePendingImageReply: async () => {
          events.push("pendingImageReply");
          return {
            handled: true,
            success: true,
            message: "Use the uploaded image for Chicken Salad?",
            itemName: "Chicken Salad",
            pendingActionId: "64b000000000000000000901"
          };
        },
        rememberImageRequest: async () => {
          throw new Error("image request parser should not run after pending reply handled");
        }
      }
    );

    assert.deepEqual(events, ["pendingImageReply"]);
    assert.equal(response.source, "legacy_owner");
    assert.equal(response.success, true);
    assert.equal(response.message, "Use the uploaded image for Chicken Salad?");
    assert.equal(
      logs.some(
        ({ args }) =>
          args[0] === "[imageWorkflow] legacy fallback" &&
          args[1]?.reason === "agent_did_not_complete_image_workflow"
      ),
      true
    );
  });
});

test("actionable image confirmation falls back when AI falsely claims success without the confirm tool", async () => {
  await runWithRoutingHarness(async () => {
    const events = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "yes, use it"
      },
      {
        buildStaffState: async () =>
          makeStaffState({
            imageWorkflow: {
              active: true,
              type: "menu_item_image",
              stage: "awaiting_confirmation",
              imageUploaded: true,
              itemName: "Chicken Salad",
              pendingActionId: "64b000000000000000000901"
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({
            message: "Done — the image has been added.",
            executedTools: []
          }),
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

    assert.deepEqual(events, ["pendingImageReply"]);
    assert.equal(response.source, "legacy_owner");
    assert.equal(response.message, "Done — I added the uploaded image to Chicken Salad.");
  });
});

test("awaiting-confirmation retarget falls back when AI returns text without the assignment tool", async () => {
  await runWithRoutingHarness(async () => {
    const workflow = {
      active: true,
      type: "menu_item_image",
      stage: "awaiting_confirmation",
      imageUploaded: true,
      itemName: "Chicken Salad",
      pendingActionId: "64b000000000000000000901"
    };
    let fallbackInput;
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "actually use it for Jollof instead"
      },
      {
        buildStaffState: async () => makeStaffState({ imageWorkflow: workflow }),
        runOrchestrator: async () =>
          makeAgentResult({
            message: "Done — I'll use it for Jollof.",
            executedTools: []
          }),
        handlePendingImageReply: async (input) => {
          fallbackInput = input;
          workflow.itemName = "Jollof";
          return {
            handled: true,
            success: true,
            itemName: "Jollof",
            pendingActionId: input.pendingActionId,
            message: "Use the uploaded image for Jollof instead?"
          };
        }
      }
    );

    assert.equal(fallbackInput.pendingActionId, workflow.pendingActionId);
    assert.equal(workflow.itemName, "Jollof");
    assert.equal(response.source, "legacy_owner");
    assert.equal(response.message, "Use the uploaded image for Jollof instead?");
  });
});

test("awaiting-image cancellation falls back with the exact workflow ID when AI omits the cancel tool", async () => {
  await runWithRoutingHarness(async () => {
    const pendingActionId = "64b000000000000000000811";
    let fallbackInput;
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "never mind, cancel it"
      },
      {
        buildStaffState: async () =>
          makeStaffState({
            imageWorkflow: {
              active: true,
              type: "menu_item_image",
              stage: "awaiting_image",
              imageUploaded: false,
              itemName: "Chicken Salad",
              pendingActionId
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({
            message: "Okay, cancelled.",
            executedTools: []
          }),
        findLatestPendingAction: async () => null,
        handlePendingImageReply: async (input) => {
          fallbackInput = input;
          return {
            handled: true,
            success: true,
            pendingActionId: input.pendingActionId,
            message: "Okay, I cancelled that pending image action."
          };
        }
      }
    );

    assert.equal(fallbackInput.pendingActionId, pendingActionId);
    assert.equal(response.source, "legacy_owner");
    assert.equal(response.message, "Okay, I cancelled that pending image action.");
  });
});

test("an unrelated successful tool cannot consume an actionable image turn", async () => {
  await runWithRoutingHarness(async () => {
    let legacyCalls = 0;
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "it belongs to Chicken Salad"
      },
      {
        buildStaffState: async () =>
          makeStaffState({
            imageWorkflow: {
              active: true,
              type: "menu_item_image",
              stage: "awaiting_item",
              imageUploaded: true,
              pendingActionId: "64b000000000000000000901"
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({
            message: "Done.",
            executedTools: [{ name: "search_menu_items", success: true }]
          }),
        handlePendingImageReply: async () => {
          legacyCalls += 1;
          return {
            handled: true,
            success: true,
            message: "Use the uploaded image for Chicken Salad?"
          };
        }
      }
    );

    assert.equal(legacyCalls, 1);
    assert.equal(response.source, "legacy_owner");
    assert.equal(response.message, "Use the uploaded image for Chicken Salad?");
  });
});

test("staff state loading failure falls back to safe empty state without blocking AI", async () => {
  await runWithRoutingHarness(async ({ logs }) => {
    let receivedStaffState;
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "hello"
      },
      {
        buildStaffState: async () => {
          throw new Error("database unavailable");
        },
        runOrchestrator: async (input) => {
          receivedStaffState = input.staffState;
          return makeAgentResult({ message: "Hello. How can I help?" });
        },
        getPendingImageStage: async () => null
      }
    );

    assert.equal(response.source, "openrouter_agent");
    assert.deepEqual(receivedStaffState.pendingActions, []);
    assert.equal(receivedStaffState.imageWorkflow, null);
    assert.equal(receivedStaffState.permissions.includes("confirm_order"), true);
    assert.equal(
      logs.some(
        ({ level, args }) =>
          level === "error" && args[0] === "[staffState] build failed"
      ),
      true
    );
    assert.equal(JSON.stringify(logs).includes("database unavailable"), false);
  });
});

test("pending mutation confirmation falls back safely after a no-tool AI answer", async () => {
  await runWithRoutingHarness(async () => {
    const events = [];
    const pendingAction = { _id: "64b000000000000000000d11" };
    let receivedStaffState;
    const staffState = makeStaffState({
      pendingActions: [
        {
          actionId: String(pendingAction._id),
          type: "TOOL_CALL",
          toolName: "update_menu_price",
          summary: "Change Chicken Salad to GHS 65",
          status: "pending",
          requiresConfirmation: true
        }
      ]
    });
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "yes, go ahead"
      },
      {
        buildStaffState: async () => staffState,
        runOrchestrator: async (input) => {
          events.push("ai");
          receivedStaffState = input.staffState;
          return makeAgentResult({ message: "Done." });
        },
        getPendingImageStage: async () => null,
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
    assert.equal(
      receivedStaffState.pendingActions[0].toolName,
      "update_menu_price"
    );
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
        buildStaffState: buildEmptyStaffState,
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

test("a failed tool attempt does not prevent deterministic fallback", async () => {
  await runWithRoutingHarness(async () => {
    const events = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "Accept ORD-456"
      },
      {
        buildStaffState: buildEmptyStaffState,
        runOrchestrator: async () =>
          makeAgentResult({
            success: false,
            message: "I couldn't do that.",
            errorCode: "TOOL_EXECUTION_FAILED",
            executedTools: [
              {
                name: "confirm_order",
                success: false,
                code: "FORBIDDEN",
                message: "Tool execution was forbidden."
              }
            ]
          }),
        handlePendingImageReply: unhandledImageReply,
        rememberImageRequest: unhandledImageReply,
        handleSavedSelection: unhandledSelection,
        parseSimpleDecision: () => null,
        parseOrderDecision: (message) => parseOwnerOrderDecision(message),
        executeTool: async (toolName) => {
          events.push(toolName);
          return { success: true, message: "Order accepted.", data: {} };
        }
      }
    );

    assert.deepEqual(events, ["confirm_order"]);
    assert.equal(response.message, "Order accepted.");
    assert.equal(response.source, "legacy_owner");
  });
});

test("an awaiting-item image progresses through the typed assignment tool", async () => {
  await runWithRoutingHarness(async () => {
    const events = [];
    let receivedStaffState;
    const staffState = makeStaffState({
      imageWorkflow: {
        active: true,
        type: "menu_item_image",
        stage: "awaiting_item",
        imageUploaded: true,
        pendingActionId: "image-awaiting-item"
      }
    });
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "it belongs to Chicken Salad"
      },
      {
        buildStaffState: async () => staffState,
        runOrchestrator: async (input) => {
          events.push("ai");
          receivedStaffState = input.staffState;
          return makeAgentResult({
            message: "Use the uploaded image for Chicken Salad?",
            executedTools: [
              {
                name: "assign_pending_image_to_menu_item",
                success: true,
                requiresConfirmation: true,
                pendingActionId: "image-awaiting-item"
              }
            ]
          });
        },
        handlePendingImageReply: () => {
          throw new Error("legacy image parser should not run");
        }
      }
    );

    assert.deepEqual(events, ["ai"]);
    assert.equal(response.message, "Use the uploaded image for Chicken Salad?");
    assert.equal(response.source, "openrouter_agent");
    assert.equal(receivedStaffState.imageWorkflow.stage, "awaiting_item");
  });
});

test("awaiting image confirmation uses the exact typed confirmation tool", async () => {
  await runWithRoutingHarness(async () => {
    const events = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: managerPhone,
        message: "yes"
      },
      {
        buildStaffState: async () =>
          makeStaffState({
            imageWorkflow: {
              active: true,
              type: "menu_item_image",
              stage: "awaiting_confirmation",
              imageUploaded: true,
              itemName: "Chicken Salad",
              pendingActionId: "image-confirmation"
            }
          }),
        runOrchestrator: async () => {
          events.push("ai");
          return makeAgentResult({
            message: "Image assignment completed.",
            executedTools: [
              {
                name: "confirm_pending_image_assignment",
                success: true
              }
            ]
          });
        },
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

    assert.deepEqual(events, ["ai"]);
    assert.equal(response.message, "Image assignment completed.");
    assert.equal(response.source, "openrouter_agent");
  });
});

test("awaiting image confirmation uses the exact typed cancellation tool", async () => {
  await runWithRoutingHarness(async () => {
    const events = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: managerPhone,
        message: "no, cancel it"
      },
      {
        buildStaffState: async () =>
          makeStaffState({
            imageWorkflow: {
              active: true,
              type: "menu_item_image",
              stage: "awaiting_confirmation",
              imageUploaded: true,
              itemName: "Chicken Salad",
              pendingActionId: "image-confirmation"
            }
          }),
        runOrchestrator: async () => {
          events.push("ai");
          return makeAgentResult({
            message: "Okay, I cancelled that pending image action.",
            executedTools: [
              {
                name: "cancel_pending_image_assignment",
                success: true
              }
            ]
          });
        },
        findLatestPendingAction: async () => null,
        handlePendingImageReply: async () => {
          events.push("pendingImageReply");
          return {
            handled: true,
            success: true,
            message: "Okay, I cancelled that pending image action."
          };
        }
      }
    );

    assert.deepEqual(events, ["ai"]);
    assert.equal(response.message, "Okay, I cancelled that pending image action.");
    assert.equal(response.source, "openrouter_agent");
  });
});

test("quoted accept cannot be falsely completed by a no-tool AI response", async () => {
  await runWithRoutingHarness(async () => {
    const toolCalls = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "accept",
        quotedMessageId: "provider-order-104"
      },
      makeOrderSafetyDependencies({
        buildStaffState: async () =>
          makeStaffState({
            orders: {
              freshPending: [
                { id: "order-104", orderNumber: "ORD-104", status: "pending" },
                { id: "order-105", orderNumber: "ORD-105", status: "pending" }
              ],
              recentActive: []
            },
            recentReferences: {
              quotedOrder: { id: "order-104", orderNumber: "ORD-104", status: "pending" }
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({ message: "Done — ORD-104 was accepted." }),
        executeTool: async (name, args) => {
          toolCalls.push({ name, args });
          return { success: true, message: "Order confirmed successfully." };
        }
      })
    );

    assert.deepEqual(toolCalls, [
      { name: "confirm_order", args: { orderId: "order-104" } }
    ]);
    assert.equal(response.source, "legacy_owner");
  });
});

test("successful exact order tool execution bypasses the deterministic order parser", async () => {
  await runWithRoutingHarness(async () => {
    let legacyCalls = 0;
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "Accept ORD-104"
      },
      makeOrderSafetyDependencies({
        buildStaffState: buildEmptyStaffState,
        runOrchestrator: async () =>
          makeAgentResult({
            message: "ORD-104 has been accepted.",
            executedTools: [
              {
                name: "confirm_order",
                success: true,
                resultOrderId: "order-104",
                resultOrderNumber: "ORD-104",
                resultOrderStatus: "accepted"
              }
            ]
          }),
        executeTool: async () => {
          legacyCalls += 1;
          return { success: true, message: "legacy" };
        }
      })
    );

    assert.equal(legacyCalls, 0);
    assert.equal(response.source, "openrouter_agent");
  });
});

test("a successful mutation for the wrong order does not consume the intended turn", async () => {
  await runWithRoutingHarness(async () => {
    const fallbackCalls = [];
    await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "Accept ORD-104"
      },
      makeOrderSafetyDependencies({
        buildStaffState: buildEmptyStaffState,
        runOrchestrator: async () =>
          makeAgentResult({
            message: "ORD-104 has been accepted.",
            executedTools: [
              {
                name: "confirm_order",
                success: true,
                resultOrderId: "order-105",
                resultOrderNumber: "ORD-105",
                resultOrderStatus: "accepted"
              }
            ]
          }),
        executeTool: async (name, args) => {
          fallbackCalls.push({ name, args });
          return { success: true, message: "ORD-104 accepted." };
        }
      })
    );

    assert.deepEqual(fallbackCalls, [
      { name: "confirm_order", args: { orderId: "ORD-104" } }
    ]);
  });
});

test("an unrelated successful tool cannot complete a quoted accept", async () => {
  await runWithRoutingHarness(async () => {
    const tools = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "accept"
      },
      makeOrderSafetyDependencies({
        buildStaffState: async () =>
          makeStaffState({
            orders: { freshPending: [], recentActive: [] },
            recentReferences: {
              quotedOrder: { id: "order-104", orderNumber: "ORD-104", status: "pending" }
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({
            message: "Done, accepted.",
            executedTools: [{ name: "list_orders", success: true }]
          }),
        executeTool: async (name, args) => {
          tools.push({ name, args });
          return { success: true, message: "Order accepted." };
        }
      })
    );

    assert.deepEqual(tools, [
      { name: "confirm_order", args: { orderId: "order-104" } }
    ]);
    assert.equal(response.message, "Order accepted.");
  });
});

test("quoted rejection keeps the owner's exact inline reason", async () => {
  await runWithRoutingHarness(async () => {
    const toolCalls = [];
    await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "reject, no chicken left"
      },
      makeOrderSafetyDependencies({
        buildStaffState: async () =>
          makeStaffState({
            recentReferences: {
              quotedOrder: { id: "order-104", orderNumber: "ORD-104", status: "pending" }
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({ message: "Done, rejected." }),
        executeTool: async (name, args) => {
          toolCalls.push({ name, args });
          return { success: true, message: "Order rejected." };
        }
      })
    );

    assert.deepEqual(toolCalls, [
      {
        name: "reject_order",
        args: { orderId: "order-104", reason: "no chicken left" }
      }
    ]);
  });
});

test("reject without a reason creates an exact reason request and never mutates", async () => {
  await runWithRoutingHarness(async () => {
    const mutations = [];
    const reasonRequests = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "Reject ORD-104"
      },
      makeOrderSafetyDependencies({
        buildStaffState: buildEmptyStaffState,
        runOrchestrator: async () =>
          makeAgentResult({ message: "Done, rejected." }),
        requestRejectionReason: async (input) => {
          reasonRequests.push(input);
          return {
            handled: true,
            success: true,
            message: "What's the reason for rejecting ORD-104?",
            data: { pendingActionId: "reason-action-104" }
          };
        },
        executeTool: async (...args) => mutations.push(args)
      })
    );

    assert.equal(mutations.length, 0);
    assert.equal(reasonRequests[0].orderReference, "ORD-104");
    assert.match(response.message, /reason.*ORD-104/i);
  });
});

test("awaiting rejection reason cancellation bypasses AI and never rejects", async () => {
  for (const message of ["cancel", "never mind"]) {
    await runWithRoutingHarness(async () => {
      const events = [];
      const response = await handleRestaurantAgentMessage(
        {
          restaurant: makeRestaurant(),
          senderPhone: ownerPhone,
          message
        },
        makeOrderSafetyDependencies({
          buildStaffState: async () =>
            makeStaffState({
              recentReferences: {
                orderSelection: {
                  pendingActionId: "reason-action-104",
                  decision: "reject",
                  awaitingReason: true,
                  candidates: [
                    {
                      id: "order-104",
                      orderNumber: "ORD-104",
                      status: "pending",
                      position: 1
                    }
                  ]
                }
              }
            }),
          runOrchestrator: async () => {
            events.push("ai");
            return makeAgentResult({
              executedTools: [{ name: "reject_order", success: true }]
            });
          },
          handleSavedSelection: async () => {
            events.push("cancel-selection");
            return {
              handled: true,
              success: true,
              message: "Okay, I cancelled that order rejection."
            };
          },
          executeTool: async () => {
            events.push("reject_order");
            return { success: true, message: "Order rejected." };
          }
        })
      );

      assert.deepEqual(events, ["cancel-selection"]);
      assert.equal(response.source, "legacy_owner");
      assert.match(response.message, /cancelled/i);
    });
  }
});

test("awaiting rejection reason blocks a no-tool false rejection claim", async () => {
  await runWithRoutingHarness(async () => {
    const unchangedOrder = { id: "order-104", status: "pending" };
    let pendingSelectionStatus = "pending";
    let deterministicMutations = 0;
    let reconciliationCalls = 0;
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "Chicken is finished"
      },
      makeOrderSafetyDependencies({
        buildStaffState: async () =>
          makeStaffState({
            recentReferences: {
              orderSelection: {
                pendingActionId: "reason-action-104",
                decision: "reject",
                awaitingReason: true,
                candidates: [
                  {
                    id: "order-104",
                    orderNumber: "ORD-104",
                    status: "pending",
                    position: 1
                  }
                ]
              }
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({
            message: "Done — ORD-104 has been rejected.",
            executedTools: []
          }),
        reconcileAwaitingSelection: async () => {
          reconciliationCalls += 1;
          pendingSelectionStatus = "completed";
          return { completed: true, remainingOrderIds: [], updated: true };
        },
        executeTool: async () => {
          deterministicMutations += 1;
          unchangedOrder.status = "rejected";
          return { success: true, message: "Order rejected." };
        }
      })
    );

    assert.equal(response.success, false);
    assert.equal(response.source, "legacy_owner");
    assert.match(response.message, /haven't confirmed/i);
    assert.doesNotMatch(response.message, /has been rejected|done.*rejected/i);
    assert.equal(unchangedOrder.status, "pending");
    assert.equal(pendingSelectionStatus, "pending");
    assert.equal(deterministicMutations, 0);
    assert.equal(reconciliationCalls, 0);
  });
});

test("awaiting rejection reason conversational text cannot trigger deterministic rejection", async () => {
  await runWithRoutingHarness(async () => {
    const mutations = [];
    let savedSelectionCalls = 0;
    let reconciliationCalls = 0;
    let pendingSelectionStatus = "pending";
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "hold on let me check"
      },
      makeOrderSafetyDependencies({
        buildStaffState: async () =>
          makeStaffState({
            recentReferences: {
              orderSelection: {
                pendingActionId: "reason-action-104",
                decision: "reject",
                awaitingReason: true,
                candidates: [
                  {
                    id: "order-104",
                    orderNumber: "ORD-104",
                    status: "pending",
                    position: 1
                  }
                ]
              }
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({ message: "Okay, let me know when you have checked." }),
        handleSavedSelection: async () => {
          savedSelectionCalls += 1;
          return { handled: false, success: false, message: "" };
        },
        reconcileAwaitingSelection: async () => {
          reconciliationCalls += 1;
          pendingSelectionStatus = "completed";
          return { completed: true, remainingOrderIds: [], updated: true };
        },
        executeTool: async (...args) => mutations.push(args)
      })
    );

    assert.equal(mutations.length, 0);
    assert.equal(savedSelectionCalls, 0);
    assert.equal(reconciliationCalls, 0);
    assert.equal(pendingSelectionStatus, "pending");
    assert.equal(response.source, "openrouter_agent");
  });
});

test("AI can reject the selected order with the owner's actual supplied reason", async () => {
  await runWithRoutingHarness(async () => {
    let deterministicMutations = 0;
    let pendingSelectionStatus = "pending";
    let reconciliationInput;
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "Chicken is finished"
      },
      makeOrderSafetyDependencies({
        buildStaffState: async () =>
          makeStaffState({
            recentReferences: {
              orderSelection: {
                pendingActionId: "reason-action-104",
                decision: "reject",
                awaitingReason: true,
                candidates: [
                  {
                    id: "order-104",
                    orderNumber: "ORD-104",
                    status: "pending",
                    position: 1
                  }
                ]
              }
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({
            message: "ORD-104 was rejected because chicken is finished.",
            executedTools: [
              {
                name: "reject_order",
                success: true,
                resultOrderId: "order-104",
                resultOrderNumber: "ORD-104",
                resultOrderStatus: "rejected"
              }
            ]
          }),
        reconcileAwaitingSelection: async (input) => {
          reconciliationInput = input;
          pendingSelectionStatus = "completed";
          return { completed: true, remainingOrderIds: [], updated: true };
        },
        executeTool: async () => {
          deterministicMutations += 1;
          return { success: true, message: "Order rejected." };
        }
      })
    );

    assert.equal(deterministicMutations, 0);
    assert.equal(pendingSelectionStatus, "completed");
    assert.deepEqual(reconciliationInput.expectedOrderIds, ["order-104"]);
    assert.deepEqual(reconciliationInput.successfulOrderIds, ["order-104"]);
    assert.deepEqual(response.data.orders, [{ id: "order-104" }]);
    assert.equal(response.source, "openrouter_agent");
  });
});

test("awaiting rejection reason completes after both exact selected orders are rejected", async () => {
  await runWithRoutingHarness(async () => {
    let pendingSelectionStatus = "pending";
    let reconciliationInput;
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "We're out of chicken."
      },
      makeOrderSafetyDependencies({
        buildStaffState: async () =>
          makeStaffState({
            recentReferences: {
              orderSelection: {
                pendingActionId: "reason-action-both",
                decision: "reject",
                awaitingReason: true,
                candidates: [
                  {
                    id: "order-104",
                    orderNumber: "ORD-104",
                    status: "pending",
                    position: 1
                  },
                  {
                    id: "order-105",
                    orderNumber: "ORD-105",
                    status: "pending",
                    position: 2
                  }
                ]
              }
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({
            message: "Both orders were rejected.",
            executedTools: [
              {
                name: "reject_order",
                success: true,
                resultOrderId: "order-104",
                resultOrderNumber: "ORD-104",
                resultOrderStatus: "rejected"
              },
              {
                name: "reject_order",
                success: true,
                resultOrderId: "order-105",
                resultOrderNumber: "ORD-105",
                resultOrderStatus: "rejected"
              }
            ]
          }),
        reconcileAwaitingSelection: async (input) => {
          reconciliationInput = input;
          pendingSelectionStatus = "completed";
          return { completed: true, remainingOrderIds: [], updated: true };
        }
      })
    );

    assert.equal(pendingSelectionStatus, "completed");
    assert.deepEqual(reconciliationInput.expectedOrderIds, [
      "order-104",
      "order-105"
    ]);
    assert.deepEqual(reconciliationInput.successfulOrderIds, [
      "order-104",
      "order-105"
    ]);
    assert.deepEqual(response.data.orders, [
      { id: "order-104" },
      { id: "order-105" }
    ]);
    assert.equal(response.data.orderEvent, "rejected");
    assert.equal(response.data.notifyCustomer, true);
    assert.equal(response.source, "openrouter_agent");
  });
});

test("awaiting rejection reason keeps the remaining exact order after partial AI mutation", async () => {
  await runWithRoutingHarness(async () => {
    let pendingSelectionStatus = "pending";
    let pendingOrderIds = ["order-104", "order-105"];
    let reconciliationInput;
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "We're out of chicken."
      },
      makeOrderSafetyDependencies({
        buildStaffState: async () =>
          makeStaffState({
            recentReferences: {
              orderSelection: {
                pendingActionId: "reason-action-both",
                decision: "reject",
                awaitingReason: true,
                candidates: [
                  {
                    id: "order-104",
                    orderNumber: "ORD-104",
                    status: "pending",
                    position: 1
                  },
                  {
                    id: "order-105",
                    orderNumber: "ORD-105",
                    status: "pending",
                    position: 2
                  }
                ]
              }
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({
            message: "Done — both orders were rejected.",
            executedTools: [
              {
                name: "reject_order",
                success: true,
                resultOrderId: "order-104",
                resultOrderNumber: "ORD-104",
                resultOrderStatus: "rejected"
              }
            ]
          }),
        reconcileAwaitingSelection: async (input) => {
          reconciliationInput = input;
          pendingOrderIds = ["order-105"];
          return {
            completed: false,
            remainingOrderIds: ["order-105"],
            updated: true
          };
        }
      })
    );

    assert.equal(pendingSelectionStatus, "pending");
    assert.deepEqual(pendingOrderIds, ["order-105"]);
    assert.deepEqual(reconciliationInput.successfulOrderIds, ["order-104"]);
    assert.equal(response.success, false);
    assert.equal(response.source, "legacy_owner");
    assert.deepEqual(response.data.orders, [{ id: "order-104" }]);
    assert.match(response.message, /ORD-105 is still pending/i);
    assert.doesNotMatch(response.message, /both orders (?:were|are) rejected/i);
  });
});

test("one AI mutation cannot consume a two-order saved selection", async () => {
  await runWithRoutingHarness(async () => {
    const events = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "all"
      },
      makeOrderSafetyDependencies({
        buildStaffState: async () =>
          makeStaffState({
            orders: {
              freshPending: [
                { id: "order-104", orderNumber: "ORD-104", status: "pending" },
                { id: "order-105", orderNumber: "ORD-105", status: "pending" }
              ],
              recentActive: []
            },
            recentReferences: {
              orderSelection: {
                pendingActionId: "selection-action",
                decision: "accept",
                awaitingReason: false,
                candidates: [
                  {
                    id: "order-104",
                    orderNumber: "ORD-104",
                    status: "pending",
                    position: 1
                  },
                  {
                    id: "order-105",
                    orderNumber: "ORD-105",
                    status: "pending",
                    position: 2
                  }
                ]
              }
            }
          }),
        runOrchestrator: async () => {
          events.push("ai-one-order");
          return makeAgentResult({
            message: "ORD-104 was accepted.",
            executedTools: [
              {
                name: "confirm_order",
                success: true,
                resultOrderId: "order-104",
                resultOrderNumber: "ORD-104",
                resultOrderStatus: "accepted"
              }
            ]
          });
        },
        handleSavedSelection: async () => {
          events.push("saved-selection-all");
          return {
            handled: true,
            success: true,
            message: "2 orders accepted.",
            data: { orders: [{ id: "order-104" }, { id: "order-105" }] }
          };
        }
      })
    );

    assert.deepEqual(events, ["ai-one-order", "saved-selection-all"]);
    assert.equal(response.source, "legacy_owner");
    assert.match(response.message, /2 orders accepted/i);
  });
});

test("ambiguous reject does not default to the newest pending order", async () => {
  await runWithRoutingHarness(async () => {
    const mutations = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "reject it"
      },
      makeOrderSafetyDependencies({
        buildStaffState: async () =>
          makeStaffState({
            orders: {
              freshPending: ["104", "105", "106"].map((number) => ({
                id: `order-${number}`,
                orderNumber: `ORD-${number}`,
                status: "pending"
              })),
              recentActive: []
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({ message: "Done, rejected." }),
        handleUnquotedDecision: async () => ({
          handled: true,
          success: true,
          message: "Which order should I reject?",
          data: { pendingActionId: "selection-action" }
        }),
        executeTool: async (...args) => mutations.push(args)
      })
    );

    assert.equal(mutations.length, 0);
    assert.match(response.message, /Which order/i);
  });
});

test("one actionable pending order can safely satisfy accept it", async () => {
  await runWithRoutingHarness(async () => {
    const toolCalls = [];
    await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: managerPhone,
        message: "accept it"
      },
      makeOrderSafetyDependencies({
        buildStaffState: async () =>
          makeStaffState({
            orders: {
              freshPending: [
                { id: "order-104", orderNumber: "ORD-104", status: "pending" }
              ],
              recentActive: []
            }
          }),
        runOrchestrator: async () =>
          makeAgentResult({ message: "Done, accepted." }),
        executeTool: async (name, args) => {
          toolCalls.push({ name, args });
          return { success: true, message: "Order accepted." };
        }
      })
    );

    assert.deepEqual(toolCalls, [
      { name: "confirm_order", args: { orderId: "order-104" } }
    ]);
  });
});

test("completion fallback uses one active order but clarifies multiple active orders", async () => {
  await runWithRoutingHarness(async () => {
    const toolCalls = [];
    await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "done"
      },
      makeOrderSafetyDependencies({
        buildStaffState: async () =>
          makeStaffState({
            orders: {
              freshPending: [],
              recentActive: [
                { id: "order-104", orderNumber: "ORD-104", status: "preparing" }
              ]
            }
          }),
        runOrchestrator: async () => makeAgentResult({ message: "Done." }),
        executeTool: async (name, args) => {
          toolCalls.push({ name, args });
          return { success: true, message: "Order status updated to completed." };
        }
      })
    );

    assert.deepEqual(toolCalls, [
      {
        name: "update_order_status",
        args: { orderId: "order-104", status: "completed" }
      }
    ]);
  });

  await runWithRoutingHarness(async () => {
    const toolCalls = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: ownerPhone,
        message: "done"
      },
      makeOrderSafetyDependencies({
        buildStaffState: async () =>
          makeStaffState({
            orders: {
              freshPending: [],
              recentActive: [
                { id: "order-104", orderNumber: "ORD-104", status: "preparing" },
                { id: "order-105", orderNumber: "ORD-105", status: "ready" }
              ]
            }
          }),
        runOrchestrator: async () => makeAgentResult({ message: "Done." }),
        executeTool: async (...args) => toolCalls.push(args)
      })
    );

    assert.equal(toolCalls.length, 0);
    assert.match(response.message, /Which order/i);
  });
});

test("a no-tool ready claim falls back to the scoped status tool", async () => {
  await runWithRoutingHarness(async () => {
    const toolCalls = [];
    const response = await handleRestaurantAgentMessage(
      {
        restaurant: makeRestaurant(),
        senderPhone: managerPhone,
        message: "mark ORD-104 ready"
      },
      makeOrderSafetyDependencies({
        buildStaffState: buildEmptyStaffState,
        runOrchestrator: async () =>
          makeAgentResult({ message: "ORD-104 is ready." }),
        executeTool: async (name, args) => {
          toolCalls.push({ name, args });
          return { success: true, message: "Order status updated to ready." };
        }
      })
    );

    assert.deepEqual(toolCalls, [
      {
        name: "update_order_status",
        args: { orderId: "ORD-104", status: "ready" }
      }
    ]);
    assert.equal(response.source, "legacy_owner");
  });
});

test("read-only order questions do not trigger the mutation safety fallback", async () => {
  await runWithRoutingHarness(async () => {
    let legacyCalls = 0;
    for (const message of ["what happened to ORD-104?", "why was this rejected?"]) {
      const response = await handleRestaurantAgentMessage(
        {
          restaurant: makeRestaurant(),
          senderPhone: ownerPhone,
          message
        },
        makeOrderSafetyDependencies({
          buildStaffState: buildEmptyStaffState,
          runOrchestrator: async () => makeAgentResult({ message: "Here is the status." }),
          executeTool: async () => {
            legacyCalls += 1;
            return { success: true, message: "mutated" };
          }
        })
      );
      assert.equal(response.source, "openrouter_agent");
    }
    assert.equal(legacyCalls, 0);
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
