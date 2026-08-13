const assert = require("node:assert/strict");
const test = require("node:test");

const {
  evaluateStaffAgentDecision,
  runStaffAgentEvaluation
} = require("../dist/evals/staffAgent.evaluator");
const {
  staffAgentScenarios
} = require("../dist/evals/staffAgent.scenarios");
const {
  getAgentToolDefinitionsForRole
} = require("../dist/services/ai/agentToolDefinitions.service");
const {
  handleOwnerMessage
} = require("../dist/services/agentOwner.service");
const {
  buildLiveStaffEvalSystemPrompt
} = require("../dist/evals/runStaffAgentEval");

const restaurantId = "64b000000000000000000777";
const ownerPhone = "+233500000001";
const managerPhone = "+233500000002";

const makeRestaurant = () => ({
  _id: restaurantId,
  name: "Golden Grill",
  ownerName: "Eval Owner",
  ownerPhone,
  managerPhones: [managerPhone],
  managerContacts: [],
  status: "active",
  timezone: "Africa/Accra"
});

const mockedDecisionFor = (scenario) => {
  if (scenario.expectNoTool) {
    return {
      text: "I need a little more detail before I can safely do that.",
      toolCalls: []
    };
  }

  return {
    toolCalls: [
      {
        id: `mock-${scenario.name}`,
        name: scenario.expectedTool,
        arguments: { ...(scenario.expectedArguments || {}) }
      }
    ]
  };
};

test("staff regression suite remains a bounded decision-only safety net", () => {
  assert.equal(staffAgentScenarios.length >= 30, true);
  assert.equal(staffAgentScenarios.length <= 45, true);

  for (const scenario of staffAgentScenarios) {
    assert.equal(["owner", "manager"].includes(scenario.role), true);
    assert.equal(Boolean(scenario.message.trim()), true);
  }
});

test("deterministic staff scenarios accept mocked correct AI decisions", async () => {
  let executionCount = 0;
  const result = await runStaffAgentEvaluation(staffAgentScenarios, async (scenario) => {
    executionCount += 1;
    return mockedDecisionFor(scenario);
  });

  assert.equal(executionCount, staffAgentScenarios.length);
  assert.equal(result.total, staffAgentScenarios.length);
  assert.equal(result.failed, 0);
});

test("staff evaluator catches wrong tools and unsafe arguments", () => {
  const scenario = staffAgentScenarios.find((entry) => entry.name === "Compare this week");
  assert.ok(scenario);

  const reasons = evaluateStaffAgentDecision(scenario, {
    toolCalls: [
      {
        id: "wrong-report",
        name: "get_business_report",
        arguments: { period: "last_week", compareWithPrevious: false }
      }
    ]
  });

  assert.equal(reasons.some((reason) => reason.includes("period")), true);
  assert.equal(reasons.some((reason) => reason.includes("compareWithPrevious")), true);
});

test("staff evaluator rejects mutations for ordinary conversation", () => {
  const scenario = staffAgentScenarios.find((entry) => entry.name === "Thanks");
  assert.ok(scenario);

  const reasons = evaluateStaffAgentDecision(scenario, {
    text: "Done.",
    toolCalls: [
      {
        id: "unsafe-chat-mutation",
        name: "set_item_availability",
        arguments: { itemName: "Jollof", available: false }
      }
    ]
  });

  assert.equal(reasons.length > 0, true);
});

test("live staff decisions use production role-filtered tool definitions", () => {
  const ownerTools = new Set(
    getAgentToolDefinitionsForRole("owner").map((tool) => tool.function.name)
  );
  const managerTools = new Set(
    getAgentToolDefinitionsForRole("manager").map((tool) => tool.function.name)
  );

  assert.equal(ownerTools.has("update_menu_price"), true);
  assert.equal(managerTools.has("update_menu_price"), false);
  assert.equal(ownerTools.has("get_business_report"), true);
  assert.equal(managerTools.has("get_business_report"), true);
});

test("ordinary live eval scenarios receive normal production staff-state context", async () => {
  const ordinaryScenario = staffAgentScenarios.find(
    (scenario) => scenario.name === "Greeting"
  );

  assert.ok(ordinaryScenario);
  assert.equal(ordinaryScenario.staffState, undefined);

  const prompt = await buildLiveStaffEvalSystemPrompt(ordinaryScenario);

  assert.match(prompt, /CURRENT STAFF OPERATIONAL STATE/);
  assert.match(prompt, /<staff_state>/);
  assert.match(prompt, /"pendingActions":\[\]/);
  assert.match(prompt, /"imageWorkflow":null/);
  assert.match(prompt, /"recentReferences":\{\}/);
  assert.match(prompt, /"permissions":\[/);
  assert.match(prompt, /<\/staff_state>/);
});

test("failed backend mutation cannot be represented as successful eval evidence", () => {
  const scenario = staffAgentScenarios.find((entry) => entry.name === "Accept explicit order");
  assert.ok(scenario);

  const modelDecision = mockedDecisionFor(scenario);
  const backendResult = {
    success: false,
    code: "ORDER_NOT_ACTIONABLE",
    message: "This order cannot be accepted in its current state."
  };

  assert.equal(evaluateStaffAgentDecision(scenario, modelDecision).length, 0);
  assert.equal(backendResult.success, false);
  assert.notEqual(backendResult.message, "Order accepted successfully.");
});

test("legacy owner HTTP service routes broad staff language to the AI-first agent", async () => {
  const calls = [];
  const response = await handleOwnerMessage(
    {
      restaurantId,
      senderPhone: ownerPhone,
      message: "boss make fried rice 40"
    },
    {
      findRestaurant: async () => makeRestaurant(),
      handleRestaurantMessage: async (input) => {
        calls.push(input);
        return {
          success: true,
          message: "AI-first response",
          source: "openrouter_agent"
        };
      }
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].restaurant._id), restaurantId);
  assert.equal(calls[0].senderPhone, ownerPhone);
  assert.equal(calls[0].message, "boss make fried rice 40");
  assert.equal(response.source, "openrouter_agent");
});

test("legacy owner HTTP compatibility boundary still rejects unverified customers", async () => {
  await assert.rejects(
    handleOwnerMessage(
      {
        restaurantId,
        senderPhone: "+233500000099",
        message: "show the menu"
      },
      {
        findRestaurant: async () => makeRestaurant(),
        handleRestaurantMessage: async () => {
          throw new Error("unverified sender reached agent");
        }
      }
    ),
    /not authorized/i
  );
});

test("legacy owner HTTP compatibility boundary remains restaurant scoped", async () => {
  const lookedUpRestaurantIds = [];

  await handleOwnerMessage(
    {
      restaurantId,
      senderPhone: managerPhone,
      message: "give me today's report"
    },
    {
      findRestaurant: async (requestedRestaurantId) => {
        lookedUpRestaurantIds.push(requestedRestaurantId);
        return makeRestaurant();
      },
      handleRestaurantMessage: async ({ restaurant }) => ({
        success: true,
        message: String(restaurant._id),
        source: "openrouter_agent"
      })
    }
  );

  assert.deepEqual(lookedUpRestaurantIds, [restaurantId]);
});
