const test = require("node:test");
const assert = require("node:assert/strict");
const { Types } = require("mongoose");

const { CustomerProfile } = require("../dist/models/customerProfile.model");
const { MenuItem } = require("../dist/models/MenuItem");
const { Order } = require("../dist/models/order.model");
const { CustomerCampaign } = require("../dist/models/customerCampaign.model");
const {
  CustomerCampaignRecipient
} = require("../dist/models/customerCampaignRecipient.model");
const { OutboundMessage } = require("../dist/models/outboundMessage.model");
const {
  getCustomerInsights,
  getCustomerSegmentInsights,
  MAX_SEGMENT_TOP_ITEMS
} = require("../dist/services/customerIntelligence.service");
const {
  selectCustomerCampaignAudience
} = require("../dist/services/customerCampaign.service");
const {
  toolRegistry
} = require("../dist/agent-tools/tool.registry");
const {
  getAgentToolDefinitionsForRole
} = require("../dist/services/ai/agentToolDefinitions.service");
const {
  buildAgentSystemPrompt
} = require("../dist/services/ai/agentPrompt.service");
const {
  runAgentOrchestrator
} = require("../dist/services/ai/agentOrchestrator.service");

const restaurantId = "64b000000000000000000001";
const otherRestaurantId = "64b000000000000000000002";
const jollofId = new Types.ObjectId("64b000000000000000000101");

const query = (value) => ({
  select() {
    return this;
  },
  sort() {
    return this;
  },
  limit() {
    return Promise.resolve(value);
  },
  then(resolve, reject) {
    return Promise.resolve(value).then(resolve, reject);
  }
});

const profile = (overrides = {}) => ({
  _id: new Types.ObjectId(),
  restaurantId: new Types.ObjectId(restaurantId),
  customerKey: "lid:private-internal-key",
  customerPhone: "+233501112043",
  customerName: "Ama Mensah",
  orderCount: 3,
  lastOrderAt: new Date("2026-08-01T12:00:00.000Z"),
  averageOrderValue: 82.5,
  preferredOrderType: "delivery",
  marketingConsent: true,
  isOptedOut: false,
  marketingConsentPromptedAt: new Date("2026-07-01T12:00:00.000Z"),
  commonDeliveryAddresses: [
    { address: "42 Private Street", orderCount: 2, lastUsedAt: new Date() }
  ],
  dietaryPreferences: ["private preference"],
  frequentlyOrderedItems: [
    {
      menuItemId: jollofId,
      name: "Chicken Jollof",
      orderCount: 2,
      totalQuantity: 4,
      lastOrderedAt: new Date("2026-08-01T12:00:00.000Z")
    }
  ],
  ...overrides
});

const context = (role = "owner") => ({
  restaurantId,
  restaurant: {
    _id: restaurantId,
    name: "Golden Grill",
    timezone: "Africa/Accra"
  },
  sender: {
    phone: "+233500000001",
    normalizedPhone: "+233500000001",
    normalizedAddress: "+233500000001",
    role,
    verified: true
  }
});

test("customer intelligence tools are owner-only while owner and manager operational access remains unchanged", () => {
  const ownerTools = new Set(
    getAgentToolDefinitionsForRole("owner").map((tool) => tool.function.name)
  );
  const managerTools = new Set(
    getAgentToolDefinitionsForRole("manager").map((tool) => tool.function.name)
  );
  const customerTools = new Set(
    getAgentToolDefinitionsForRole("customer").map((tool) => tool.function.name)
  );

  for (const toolName of [
    "get_customer_insights",
    "get_customer_segment_insights"
  ]) {
    assert.equal(ownerTools.has(toolName), true);
    assert.equal(managerTools.has(toolName), false);
    assert.equal(customerTools.has(toolName), false);
  }
  assert.equal(ownerTools.has("confirm_order"), true);
  assert.equal(managerTools.has("confirm_order"), true);
  assert.equal(managerTools.has("list_orders"), true);
  assert.equal(managerTools.has("create_campaign_draft"), false);
  assert.equal(managerTools.has("get_business_report"), false);
});

test("exact customer name lookup is tenant-scoped, whitespace-normalized, and privacy-safe", async () => {
  const originals = {
    countDocuments: CustomerProfile.countDocuments,
    find: CustomerProfile.find
  };
  let countFilter;
  let findFilter;
  try {
    CustomerProfile.countDocuments = async (filter) => {
      countFilter = filter;
      return 1;
    };
    CustomerProfile.find = (filter) => {
      findFilter = filter;
      return query([profile()]);
    };

    const result = await getCustomerInsights({
      restaurantId,
      customerName: "  Ama   Mensah "
    });

    assert.equal(countFilter.restaurantId, restaurantId);
    assert.equal(findFilter.restaurantId, restaurantId);
    assert.equal(findFilter.customerName.test("AMA     MENSAH"), true);
    assert.equal(result.status, "found");
    assert.deepEqual(result.customer, {
      name: "Ama Mensah",
      maskedPhone: "***2043",
      completedOrderCount: 3,
      lastCompletedOrderAt: "2026-08-01T12:00:00.000Z",
      averageCompletedOrderValue: 82.5,
      preferredOrderType: "delivery",
      returning: true,
      marketingStatus: "opted_in",
      frequentlyOrderedItems: [
        {
          name: "Chicken Jollof",
          orderCount: 2,
          totalQuantity: 4,
          lastOrderedAt: "2026-08-01T12:00:00.000Z"
        }
      ]
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /\+233501112043/);
    assert.doesNotMatch(serialized, /private-internal-key/);
    assert.doesNotMatch(serialized, /42 Private Street/);
    assert.doesNotMatch(serialized, /private preference/);
    assert.doesNotMatch(serialized, /64b000000000000000000101/);
    assert.equal(Object.hasOwn(result.customer, "_id"), false);
  } finally {
    CustomerProfile.countDocuments = originals.countDocuments;
    CustomerProfile.find = originals.find;
  }
});

test("exact phone lookup normalizes the phone, remains tenant-scoped, and returns a masked result", async () => {
  const originalFindOne = CustomerProfile.findOne;
  let filter;
  try {
    CustomerProfile.findOne = (input) => {
      filter = input;
      return query(profile());
    };
    const result = await getCustomerInsights({
      restaurantId,
      customerPhone: "050 111 2043"
    });
    assert.deepEqual(filter, {
      restaurantId,
      customerPhone: "+233501112043"
    });
    assert.equal(result.status, "found");
    assert.equal(result.customer.maskedPhone, "***2043");
    assert.doesNotMatch(JSON.stringify(result), /\+233501112043/);
  } finally {
    CustomerProfile.findOne = originalFindOne;
  }
});

test("same-name customers return bounded masked ambiguity candidates without guessing", async () => {
  const originals = {
    countDocuments: CustomerProfile.countDocuments,
    find: CustomerProfile.find
  };
  try {
    CustomerProfile.countDocuments = async () => 7;
    CustomerProfile.find = () =>
      query([
        profile(),
        profile({ customerPhone: "+233507777712", orderCount: 2 })
      ]);
    const result = await getCustomerInsights({
      restaurantId,
      customerName: "Ama Mensah"
    });
    assert.deepEqual(result, {
      status: "ambiguous",
      found: false,
      matchCount: 7,
      candidates: [
        { name: "Ama Mensah", maskedPhone: "***2043", orderCount: 3 },
        { name: "Ama Mensah", maskedPhone: "***7712", orderCount: 2 }
      ],
      truncated: true
    });
    assert.doesNotMatch(JSON.stringify(result), /\+233/);
  } finally {
    CustomerProfile.countDocuments = originals.countDocuments;
    CustomerProfile.find = originals.find;
  }
});

test("nonexistent and cross-restaurant customer lookups return clean not-found results", async () => {
  const originalFindOne = CustomerProfile.findOne;
  const filters = [];
  try {
    CustomerProfile.findOne = (filter) => {
      filters.push(filter);
      return query(null);
    };
    const first = await getCustomerInsights({
      restaurantId,
      customerPhone: "+233501112043"
    });
    const second = await getCustomerInsights({
      restaurantId: otherRestaurantId,
      customerPhone: "+233501112043"
    });
    assert.deepEqual(first, { status: "not_found", found: false });
    assert.deepEqual(second, { status: "not_found", found: false });
    assert.equal(filters[0].restaurantId, restaurantId);
    assert.equal(filters[1].restaurantId, otherRestaurantId);
  } finally {
    CustomerProfile.findOne = originalFindOne;
  }
});

test("all-customer segment distinguishes membership from current marketing eligibility", async () => {
  const originalFind = CustomerProfile.find;
  let filter;
  try {
    CustomerProfile.find = (input) => {
      filter = input;
      return query([
        profile(),
        profile({
          customerPhone: "+233501112044",
          customerName: "Kojo",
          marketingConsent: null,
          isOptedOut: false,
          preferredOrderType: "pickup",
          orderCount: 1
        }),
        profile({
          customerPhone: "+233501112045",
          customerName: "Esi",
          marketingConsent: true,
          isOptedOut: true,
          orderCount: 0,
          preferredOrderType: undefined,
          frequentlyOrderedItems: []
        }),
        profile({
          customerPhone: "invalid",
          customerName: "Yaw",
          marketingConsent: true,
          isOptedOut: false,
          orderCount: 0,
          preferredOrderType: undefined,
          frequentlyOrderedItems: []
        })
      ]);
    };
    const result = await getCustomerSegmentInsights({
      restaurantId,
      timezone: "Africa/Accra",
      segmentType: "all_customers"
    });
    assert.deepEqual(filter, { restaurantId });
    assert.equal(result.status, "ok");
    assert.equal(result.totalCustomers, 4);
    assert.equal(result.customersWithCompletedOrders, 2);
    assert.equal(result.totalCompletedOrderCount, 4);
    assert.equal(result.marketingEligibleCustomers, 1);
    assert.equal(result.excludedNoConsent, 1);
    assert.equal(result.excludedOptOut, 1);
    assert.equal(result.excludedInvalidPhone, 1);
    assert.deepEqual(result.preferredOrderTypeDistribution, {
      pickup: 1,
      delivery: 1,
      unknown: 2
    });
  } finally {
    CustomerProfile.find = originalFind;
  }
});

test("inactive segment requires completed orders and uses a strict requested-day cutoff", async () => {
  const originalFind = CustomerProfile.find;
  let filter;
  try {
    CustomerProfile.find = (input) => {
      filter = input;
      return query([profile()]);
    };
    await getCustomerSegmentInsights({
      restaurantId,
      timezone: "Africa/Accra",
      segmentType: "inactive_customers",
      inactiveDays: 30,
      now: new Date("2026-09-15T12:00:00.000Z")
    });
    assert.deepEqual(filter.orderCount, { $gte: 1 });
    assert.equal(
      filter.lastOrderAt.$lt.toISOString(),
      "2026-08-16T12:00:00.000Z"
    );
  } finally {
    CustomerProfile.find = originalFind;
  }
});

test("returning segment deterministically means at least two completed orders", async () => {
  const originalFind = CustomerProfile.find;
  let filter;
  try {
    CustomerProfile.find = (input) => {
      filter = input;
      return query([profile({ orderCount: 2 })]);
    };
    const result = await getCustomerSegmentInsights({
      restaurantId,
      timezone: "Africa/Accra",
      segmentType: "returning_customers"
    });
    assert.deepEqual(filter.orderCount, { $gte: 2 });
    assert.equal(result.totalCustomers, 1);
  } finally {
    CustomerProfile.find = originalFind;
  }
});

test("ordered-menu-item segment resolves a restaurant item and completed-order phones without exposing IDs", async () => {
  const originals = {
    menuFind: MenuItem.find,
    orderFind: Order.find,
    profileFind: CustomerProfile.find
  };
  const filters = {};
  try {
    MenuItem.find = (filter) => {
      filters.menu = filter;
      return query([{ _id: jollofId, name: "Chicken Jollof" }]);
    };
    Order.find = (filter) => {
      filters.order = filter;
      return query([{ customerPhone: "+233501112043" }]);
    };
    CustomerProfile.find = (filter) => {
      filters.profile = filter;
      return query([profile()]);
    };
    const result = await getCustomerSegmentInsights({
      restaurantId,
      timezone: "Africa/Accra",
      segmentType: "ordered_menu_item",
      menuItemName: "chicken jollof"
    });
    assert.equal(filters.menu.restaurantId, restaurantId);
    assert.equal(filters.order.restaurantId, restaurantId);
    assert.equal(filters.order.status, "completed");
    assert.deepEqual(filters.profile.customerPhone, {
      $in: ["+233501112043"]
    });
    assert.equal(result.segment.menuItemName, "Chicken Jollof");
    assert.doesNotMatch(JSON.stringify(result), /64b000000000000000000101/);
  } finally {
    MenuItem.find = originals.menuFind;
    Order.find = originals.orderFind;
    CustomerProfile.find = originals.profileFind;
  }
});

test("ambiguous menu names return clarification candidates before customer or order loading", async () => {
  const originals = {
    menuFind: MenuItem.find,
    orderFind: Order.find,
    profileFind: CustomerProfile.find
  };
  let orderRead = false;
  let profileRead = false;
  try {
    MenuItem.find = () =>
      query([
        { _id: new Types.ObjectId(), name: "Chicken Jollof" },
        { _id: new Types.ObjectId(), name: "Vegetable Jollof" }
      ]);
    Order.find = () => {
      orderRead = true;
      return query([]);
    };
    CustomerProfile.find = () => {
      profileRead = true;
      return query([]);
    };
    const result = await getCustomerSegmentInsights({
      restaurantId,
      timezone: "Africa/Accra",
      segmentType: "ordered_menu_item",
      menuItemName: "Jollof"
    });
    assert.deepEqual(result.candidates, ["Chicken Jollof", "Vegetable Jollof"]);
    assert.equal(result.status, "ambiguous_menu_item");
    assert.equal(orderRead, false);
    assert.equal(profileRead, false);
  } finally {
    MenuItem.find = originals.menuFind;
    Order.find = originals.orderFind;
    CustomerProfile.find = originals.profileFind;
  }
});

test("same-day last-order ranges use inclusive restaurant-local boundaries and invalid ranges fail", async () => {
  const originalFind = CustomerProfile.find;
  let filter;
  try {
    CustomerProfile.find = (input) => {
      filter = input;
      return query([]);
    };
    await getCustomerSegmentInsights({
      restaurantId,
      timezone: "Africa/Accra",
      segmentType: "last_order_date_range",
      startDate: "2026-09-14",
      endDate: "2026-09-14"
    });
    assert.equal(filter.lastOrderAt.$gte.toISOString(), "2026-09-14T00:00:00.000Z");
    assert.equal(filter.lastOrderAt.$lte.toISOString(), "2026-09-14T23:59:59.999Z");

    await getCustomerSegmentInsights({
      restaurantId,
      timezone: "Africa/Lagos",
      segmentType: "last_order_date_range",
      startDate: "2026-09-14",
      endDate: "2026-09-14"
    });
    assert.equal(filter.lastOrderAt.$gte.toISOString(), "2026-09-13T23:00:00.000Z");
    assert.equal(filter.lastOrderAt.$lte.toISOString(), "2026-09-14T22:59:59.999Z");

    await assert.rejects(
      getCustomerSegmentInsights({
        restaurantId,
        timezone: "Africa/Accra",
        segmentType: "last_order_date_range",
        startDate: "2026-09-15",
        endDate: "2026-09-14"
      }),
      /endDate must be on or after startDate/
    );
    await assert.rejects(
      getCustomerSegmentInsights({
        restaurantId,
        timezone: "Africa/Accra",
        segmentType: "last_order_date_range",
        startDate: "2026-02-01",
        endDate: "2026-02-30"
      }),
      /Invalid endDate/
    );
  } finally {
    CustomerProfile.find = originalFind;
  }
});

test("historical top items aggregate customer, order, and quantity counts independently and stay bounded", async () => {
  const originalFind = CustomerProfile.find;
  try {
    const manyItems = Array.from({ length: 12 }, (_, index) => ({
      menuItemId: new Types.ObjectId(),
      name: `Item ${index}`,
      orderCount: index + 1,
      totalQuantity: index + 2,
      lastOrderedAt: new Date("2026-08-01T12:00:00.000Z")
    }));
    CustomerProfile.find = () =>
      query([
        profile({ frequentlyOrderedItems: manyItems }),
        profile({
          customerPhone: "+233501112044",
          frequentlyOrderedItems: [
            {
              ...manyItems[11],
              orderCount: 2,
              totalQuantity: 8
            }
          ]
        })
      ]);
    const result = await getCustomerSegmentInsights({
      restaurantId,
      timezone: "Africa/Accra",
      segmentType: "all_customers"
    });
    assert.equal(result.historicalTopItems.length, MAX_SEGMENT_TOP_ITEMS);
    assert.deepEqual(result.historicalTopItems[0], {
      name: "Item 11",
      customerCount: 2,
      orderCount: 14,
      totalQuantity: 21
    });
    assert.notEqual(
      result.historicalTopItems[0].orderCount,
      result.historicalTopItems[0].totalQuantity
    );
  } finally {
    CustomerProfile.find = originalFind;
  }
});

test("segment eligibility counts match the classifier used by campaign audience previews", async () => {
  const originalFind = CustomerProfile.find;
  const profiles = [
    profile(),
    profile({ customerKey: "duplicate-key", orderCount: 1 }),
    profile({ customerPhone: "+233501112044", marketingConsent: null }),
    profile({
      customerPhone: "+233501112045",
      marketingConsent: true,
      isOptedOut: true
    }),
    profile({ customerPhone: "invalid", marketingConsent: true })
  ];
  try {
    CustomerProfile.find = () => query(profiles);
    const insights = await getCustomerSegmentInsights({
      restaurantId,
      timezone: "Africa/Accra",
      segmentType: "all_customers"
    });
    const preview = await selectCustomerCampaignAudience(
      restaurantId,
      { type: "all_eligible_customers" }
    );
    assert.equal(insights.marketingEligibleCustomers, preview.estimatedEligibleRecipients);
    assert.equal(insights.excludedNoConsent, preview.excludedNoConsent);
    assert.equal(insights.excludedOptOut, preview.excludedOptOut);
    assert.equal(insights.excludedInvalidPhone, preview.excludedInvalidPhone);
  } finally {
    CustomerProfile.find = originalFind;
  }
});

test("intelligence schemas reject injected trusted scope and internal identifiers", () => {
  assert.throws(
    () =>
      toolRegistry.get_customer_insights.schema.parse({
        customerName: "Ama",
        restaurantId: otherRestaurantId
      }),
    /unrecognized/i
  );
  assert.throws(
    () =>
      toolRegistry.get_customer_insights.schema.parse({
        customerProfileId: "64b000000000000000000999"
      }),
    /provide a customer name or phone number|unrecognized/i
  );
  assert.throws(
    () =>
      toolRegistry.get_customer_segment_insights.schema.parse({
        segmentType: "ordered_menu_item",
        menuItemId: "64b000000000000000000101"
      }),
    /menuItemName is required|unrecognized/i
  );
});

test("analytics tool execution creates no campaign, recipient, or outbound message", async () => {
  const originals = {
    profileFind: CustomerProfile.find,
    campaignCreate: CustomerCampaign.create,
    recipientCreate: CustomerCampaignRecipient.create,
    outboundCreate: OutboundMessage.create
  };
  let mutations = 0;
  try {
    CustomerProfile.find = () => query([]);
    CustomerCampaign.create = async () => {
      mutations += 1;
    };
    CustomerCampaignRecipient.create = async () => {
      mutations += 1;
    };
    OutboundMessage.create = async () => {
      mutations += 1;
    };

    const result = await toolRegistry.get_customer_segment_insights.handler(
      { segmentType: "inactive_customers", inactiveDays: 30 },
      context("owner")
    );
    assert.equal(result.success, true);
    assert.equal(result.data.totalCustomers, 0);
    assert.equal(mutations, 0);
  } finally {
    CustomerProfile.find = originals.profileFind;
    CustomerCampaign.create = originals.campaignCreate;
    CustomerCampaignRecipient.create = originals.recipientCreate;
    OutboundMessage.create = originals.outboundCreate;
  }
});

test("owner prompt preserves read-only segment follow-ups and campaign approval separation", async () => {
  const prompt = await buildAgentSystemPrompt(
    context("owner").restaurant,
    context("owner").sender,
    [
      "get_customer_insights",
      "get_customer_segment_insights",
      "create_campaign_draft",
      "approve_campaign"
    ],
    {
      buildRestaurantContext: async () => ({
        restaurant: { name: "Golden Grill" },
        sender: { role: "owner", verified: true },
        people: {},
        settings: {},
        summary: {},
        permissions: []
      })
    }
  );
  assert.match(prompt, /one identifiable customer's completed-order history/i);
  assert.match(prompt, /historical completed-order preferences, not current demand/i);
  assert.match(prompt, /Preserve the latest segment type and its arguments/i);
  assert.match(prompt, /never authorizes create_campaign_draft/i);
  assert.match(prompt, /recalculate eligibility at preview and approval time/i);
  assert.match(prompt, /Never expose full customer phones, delivery addresses, customer keys, database IDs/i);
});

const runOwnerAgentScenario = async ({
  message,
  toolName,
  toolArguments,
  toolResult,
  modelText,
  history = [],
  executeTool
}) => {
  let call = 0;
  return runAgentOrchestrator(
    {
      restaurant: context("owner").restaurant,
      sender: context("owner").sender,
      message
    },
    {
      provider: {
        name: "openrouter",
        model: "test-model",
        complete: async () => {
          call += 1;
          return call === 1
            ? {
                toolCalls: [
                  { id: "customer_intelligence_call", name: toolName, arguments: toolArguments }
                ]
              }
            : { text: modelText, toolCalls: [] };
        }
      },
      getHistory: async () => history,
      saveMessage: async () => {},
      buildSystemPrompt: async () => "Use deterministic customer intelligence.",
      executeTool:
        executeTool ??
        (async () => ({
          success: true,
          message: "Customer intelligence retrieved.",
          data: toolResult
        }))
    }
  );
};

test("individual customer conversation is deterministically grounded and cannot invent a same-name customer", async () => {
  const result = await runOwnerAgentScenario({
    message: "Tell me about Ama.",
    toolName: "get_customer_insights",
    toolArguments: { customerName: "Ama" },
    modelText: "Ama's private address is elsewhere and she ordered 99 times.",
    toolResult: {
      status: "ambiguous",
      found: false,
      matchCount: 2,
      candidates: [
        { name: "Ama", maskedPhone: "***2043", orderCount: 6 },
        { name: "Ama", maskedPhone: "***7712", orderCount: 2 }
      ],
      truncated: false
    }
  });
  assert.equal(
    result.message,
    "I found 2 customers with that name. Which one do you mean?\n1. Ama — ***2043 — 6 completed orders\n2. Ama — ***7712 — 2 completed orders"
  );
  assert.doesNotMatch(result.message, /private address|99/);
});

test("inactive segment follow-up conversations reuse the read-only tool and preserve 30 days", async () => {
  const executed = [];
  const result = await runOwnerAgentScenario({
    message: "What do they normally order?",
    history: [
      { role: "user", content: "How many customers haven't ordered in 30 days?" },
      { role: "assistant", content: "43 customers have been inactive for more than 30 days." }
    ],
    toolName: "get_customer_segment_insights",
    toolArguments: { segmentType: "inactive_customers", inactiveDays: 30 },
    modelText: "Their current demand is Pizza.",
    toolResult: {
      status: "ok",
      segment: { type: "inactive_customers", inactiveDays: 30 },
      totalCustomers: 43,
      marketingEligibleCustomers: 29,
      historicalTopItems: [
        {
          name: "Chicken Jollof",
          customerCount: 22,
          orderCount: 31,
          totalQuantity: 41
        }
      ],
      preferredOrderTypeDistribution: { pickup: 10, delivery: 20, unknown: 13 }
    },
    executeTool: async (toolName, args) => {
      executed.push({ toolName, args });
      return {
        success: true,
        message: "Segment insights retrieved.",
        data: {
          status: "ok",
          segment: { type: "inactive_customers", inactiveDays: 30 },
          totalCustomers: 43,
          marketingEligibleCustomers: 29,
          historicalTopItems: [
            {
              name: "Chicken Jollof",
              customerCount: 22,
              orderCount: 31,
              totalQuantity: 41
            }
          ],
          preferredOrderTypeDistribution: { pickup: 10, delivery: 20, unknown: 13 }
        }
      };
    }
  });
  assert.deepEqual(executed, [
    {
      toolName: "get_customer_segment_insights",
      args: { segmentType: "inactive_customers", inactiveDays: 30 }
    }
  ]);
  assert.match(result.message, /Historical completed-order preferences/);
  assert.match(result.message, /Chicken Jollof.*22 customers.*31 orders.*41 portions/);
  assert.doesNotMatch(result.message, /current demand|Pizza/);
});

test("read-only analytics intent blocks accidental campaign creation before execution", async () => {
  let executed = false;
  const result = await runOwnerAgentScenario({
    message: "How many inactive customers can receive promotions?",
    toolName: "create_campaign_draft",
    toolArguments: {
      name: "Wrong mutation",
      message: "Buy now",
      campaignType: "promotion",
      targeting: { type: "inactive_customers", inactiveDays: 30 }
    },
    modelText: "The campaign draft was created successfully.",
    executeTool: async () => {
      executed = true;
      return { success: true, message: "Should not run." };
    }
  });
  assert.equal(executed, false);
  assert.equal(result.success, false);
  assert.match(result.message, /read-only customer intelligence question/i);
  assert.match(result.message, /No campaign draft was created/i);
});

test("explicit promotion creation still enters the existing draft workflow without claiming delivery", async () => {
  const executed = [];
  const result = await runOwnerAgentScenario({
    message: "Create a promotion for those inactive customers.",
    toolName: "create_campaign_draft",
    toolArguments: {
      name: "Come back",
      message: "Come back for Chicken Jollof",
      campaignType: "inactivity_reengagement",
      targeting: { type: "inactive_customers", inactiveDays: 30 }
    },
    modelText: "The campaign draft is ready for your approval.",
    executeTool: async (toolName, args) => {
      executed.push({ toolName, args });
      return {
        success: true,
        message: "Campaign preview ready for approval.",
        requiresConfirmation: true,
        data: { status: "pending_approval" }
      };
    }
  });
  assert.equal(result.success, true);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].toolName, "create_campaign_draft");
  assert.equal(executed[0].args.targeting.inactiveDays, 30);
  assert.match(result.message, /ready for your approval/i);
  assert.doesNotMatch(result.message, /sent|delivered/i);
});
