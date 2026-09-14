const assert = require("node:assert/strict");
const test = require("node:test");

const { CustomerProfile } = require("../dist/models/customerProfile.model");
const {
  customerMarketingStatuses,
  listCustomers
} = require("../dist/services/customerProfile.service");
const {
  demandOrderStatuses,
  getItemPerformance
} = require("../dist/services/itemPerformance.service");
const {
  buildOwnerSummaryMetrics,
  getBusinessReport,
  resolveRequestedBusinessReportPeriod
} = require("../dist/services/ownerSummary.service");
const { toolRegistry } = require("../dist/agent-tools/tool.registry");
const {
  isToolAllowedForRole
} = require("../dist/agent-tools/tool.permissions");
const {
  getAgentToolDefinitionsForRole
} = require("../dist/services/ai/agentToolDefinitions.service");
const {
  runAgentOrchestrator,
  sanitizeStaffFacingFinalText
} = require("../dist/services/ai/agentOrchestrator.service");
const {
  buildAgentSystemPrompt
} = require("../dist/services/ai/agentPrompt.service");

const restaurantId = "64b000000000000000000a01";
const otherRestaurantId = "64b000000000000000000a02";
const fixedPeriod = {
  type: "custom",
  label: "Custom period",
  summaryType: "custom",
  timezone: "Africa/Accra",
  periodStart: new Date("2026-01-01T00:00:00.000Z"),
  periodEnd: new Date("2026-04-01T00:00:00.000Z"),
  key: "q1"
};

const item = (name, quantity, totalPrice, menuItemId) => ({
  menuItemId,
  name,
  quantity,
  totalPrice
});

const order = (status, items, createdAt = "2026-02-01T12:00:00.000Z") => ({
  status,
  items,
  createdAt: new Date(createdAt)
});

test("all-time and custom periods are timezone-safe and tenant scoped", async () => {
  let earliestScope;
  const allTime = await resolveRequestedBusinessReportPeriod(
    {
      restaurantId,
      period: "all_time",
      timezone: "Africa/Accra",
      now: new Date("2026-09-14T12:00:00.000Z")
    },
    {
      findEarliestOrder: async (scope) => {
        earliestScope = scope;
        return { createdAt: new Date("2025-11-03T09:30:00.000Z") };
      }
    }
  );

  assert.equal(earliestScope, restaurantId);
  assert.equal(allTime.periodStart.toISOString(), "2025-11-03T09:30:00.000Z");
  assert.equal(allTime.periodEnd.toISOString(), "2026-09-14T12:00:00.000Z");

  const emptyAllTime = await resolveRequestedBusinessReportPeriod(
    {
      restaurantId,
      period: "all_time",
      timezone: "Africa/Accra",
      now: new Date("2026-09-14T12:00:00.000Z")
    },
    { findEarliestOrder: async () => null }
  );
  assert.equal(emptyAllTime.periodStart.getTime(), emptyAllTime.periodEnd.getTime());

  const dstDay = await resolveRequestedBusinessReportPeriod({
    restaurantId,
    period: "custom",
    timezone: "America/New_York",
    startDate: "2026-03-08",
    endDate: "2026-03-08"
  });
  assert.equal(dstDay.periodStart.toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(dstDay.periodEnd.toISOString(), "2026-03-09T04:00:00.000Z");

  await assert.rejects(
    resolveRequestedBusinessReportPeriod({
      restaurantId,
      period: "custom",
      timezone: "Africa/Accra",
      startDate: "2026-02-30"
    }),
    (error) => error.code === "INVALID_REPORT_DATE"
  );
  await assert.rejects(
    resolveRequestedBusinessReportPeriod({
      restaurantId,
      period: "custom",
      timezone: "Africa/Accra"
    }),
    (error) => error.code === "CUSTOM_REPORT_START_DATE_REQUIRED"
  );

  const openEnded = await resolveRequestedBusinessReportPeriod({
    restaurantId,
    period: "custom",
    timezone: "Africa/Accra",
    startDate: "2026-09-01",
    now: new Date("2026-09-14T12:34:56.000Z")
  });
  assert.equal(openEnded.periodStart.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(openEnded.periodEnd.toISOString(), "2026-09-14T12:34:56.000Z");

  await assert.rejects(
    resolveRequestedBusinessReportPeriod({
      restaurantId,
      period: "custom",
      timezone: "Africa/Accra",
      startDate: "2026-09-15",
      endDate: "2026-09-14"
    }),
    (error) => error.code === "INVALID_REPORT_DATE_RANGE"
  );
});

const summaryOrder = (
  customerPhone,
  status = "completed",
  createdAt = "2026-02-01T12:00:00.000Z"
) => ({
  status,
  total: 50,
  customerPhone,
  items: [],
  createdAt: new Date(createdAt)
});

test("all-time customer semantics classify lifetime repeat customers", () => {
  const metrics = buildOwnerSummaryMetrics(
    {
      restaurantId,
      periodStart: new Date("2025-01-01T00:00:00.000Z"),
      periodEnd: new Date("2027-01-01T00:00:00.000Z"),
      timezone: "Africa/Accra",
      periodType: "custom",
      customerSemantics: "lifetime"
    },
    [
      summaryOrder("0551234567"),
      summaryOrder("+233551234567"),
      summaryOrder("233551234567"),
      summaryOrder("0241234567"),
      summaryOrder("0502223333"),
      summaryOrder("+233502223333"),
      summaryOrder("0200000001", "cancelled"),
      summaryOrder("0200000002", "rejected"),
      summaryOrder("0200000003", "pending")
    ],
    []
  );

  assert.equal(metrics.uniqueCustomers, 3);
  assert.equal(metrics.returningCustomers, 2);
  assert.equal(metrics.newCustomers, 1);
  assert.equal(metrics.newCustomers + metrics.returningCustomers, metrics.uniqueCustomers);
});

test("finite-period customer semantics remain based on pre-period history", () => {
  const metrics = buildOwnerSummaryMetrics(
    {
      restaurantId,
      periodStart: new Date("2026-02-01T00:00:00.000Z"),
      periodEnd: new Date("2026-03-01T00:00:00.000Z"),
      timezone: "Africa/Accra",
      periodType: "custom",
      customerSemantics: "period_relative"
    },
    [
      summaryOrder("0551234567"),
      summaryOrder("+233551234567"),
      summaryOrder("0241234567")
    ],
    [summaryOrder("+233241234567")]
  );

  assert.equal(metrics.uniqueCustomers, 2);
  assert.equal(metrics.returningCustomers, 1);
  assert.equal(metrics.newCustomers, 1);
});

test("formatted all-time reports use lifetime customer semantics and allow no orders", async () => {
  const lifetimeOrders = [
    summaryOrder("0551234567"),
    summaryOrder("+233551234567"),
    summaryOrder("0241234567"),
    summaryOrder("0502223333"),
    summaryOrder("+233502223333")
  ];
  const allTimePeriod = {
    type: "all_time",
    label: "All time",
    summaryType: "custom",
    timezone: "Africa/Accra",
    periodStart: new Date("2026-01-01T00:00:00.000Z"),
    periodEnd: new Date("2026-09-14T12:00:00.000Z"),
    key: "all-time"
  };
  const report = await getBusinessReport(
    {
      restaurantId,
      restaurantName: "Golden Grill",
      period: "all_time"
    },
    {
      resolvePeriod: async () => allTimePeriod,
      getMetrics: async (input) =>
        buildOwnerSummaryMetrics(input, lifetimeOrders, [])
    }
  );

  assert.match(
    report.formattedReport,
    /CUSTOMERS[\s\S]*Unique customers: 3[\s\S]*New customers: 1[\s\S]*Returning customers: 2/
  );

  const emptyReport = await getBusinessReport(
    {
      restaurantId,
      restaurantName: "Empty Restaurant",
      period: "all_time"
    },
    {
      resolvePeriod: async () => ({
        ...allTimePeriod,
        periodStart: allTimePeriod.periodEnd
      }),
      getMetrics: async (input) => buildOwnerSummaryMetrics(input, [], [])
    }
  );
  assert.equal(emptyReport.orders.total, 0);
  assert.equal(emptyReport.customers.unique, 0);
  assert.match(emptyReport.formattedReport, /ALL-TIME REPORT/);
});

test("item demand and fulfilled sales use separate submitted-order metrics", async () => {
  const jollofId = "64b000000000000000000b01";
  const friedRiceId = "64b000000000000000000b02";
  const orders = [
    order("completed", [item("Jollof", 60, 1200, jollofId)]),
    order("rejected", [item("Jollof", 40, 800, jollofId)]),
    order("completed", [item("Fried Rice", 48, 960, friedRiceId)]),
    order("cancelled", [item("Fried Rice", 2, 40, friedRiceId)]),
    order("awaiting_customer_confirmation", [
      item("Unsubmitted Draft Snapshot", 999, 9999, "64b000000000000000000b03")
    ])
  ];
  const filters = [];
  const dependencies = {
    resolvePeriod: async () => fixedPeriod,
    findOrders: async (filter) => {
      filters.push(filter);
      return orders.filter((candidate) =>
        demandOrderStatuses.includes(candidate.status)
      );
    }
  };

  const demand = await getItemPerformance(
    { restaurantId, period: "custom", metric: "demand_quantity" },
    dependencies
  );
  const fulfilled = await getItemPerformance(
    { restaurantId, period: "custom", metric: "fulfilled_quantity" },
    dependencies
  );

  assert.equal(demand.items[0].name, "Jollof");
  assert.equal(demand.items[0].demandQuantity, 100);
  assert.equal(demand.items[0].fulfilledQuantity, 60);
  assert.equal(demand.items[0].demandOrderCount, 2);
  assert.equal(fulfilled.items[0].name, "Jollof");
  assert.equal(fulfilled.items[1].fulfilledQuantity, 48);
  assert.equal(demand.items.some((entry) => entry.name.includes("Draft")), false);
  assert.ok(filters.every((filter) => filter.restaurantId === restaurantId));
  assert.ok(
    filters.every((filter) =>
      filter.status.$in.includes("awaiting_restaurant_confirmation") &&
      !filter.status.$in.includes("awaiting_customer_confirmation")
    )
  );
});

test("growth compares equal finite ranges and never invents a zero-baseline percentage", async () => {
  let queryCount = 0;
  const result = await getItemPerformance(
    { restaurantId, period: "custom", metric: "growth" },
    {
      resolvePeriod: async () => fixedPeriod,
      findOrders: async (filter) => {
        assert.equal(filter.restaurantId, restaurantId);
        queryCount += 1;
        return queryCount === 1
          ? [order("completed", [item("Jollof", 10, 200)])]
          : [];
      }
    }
  );

  assert.deepEqual(result.items[0].growth, {
    metric: "demand_quantity",
    current: 10,
    previous: 0,
    percentageChange: null
  });
  assert.equal(JSON.stringify(result).includes("Infinity"), false);
  assert.equal(JSON.stringify(result).includes("NaN"), false);
  assert.equal(
    new Date(result.comparisonPeriod.end).getTime(),
    fixedPeriod.periodStart.getTime()
  );

  await assert.rejects(
    getItemPerformance({
      restaurantId,
      period: "all_time",
      metric: "growth"
    }),
    (error) => error.code === "ITEM_GROWTH_REQUIRES_FINITE_PERIOD"
  );
});

test("list_customers returns masked, restaurant-scoped opted-in profiles", async () => {
  const originalFind = CustomerProfile.find;
  let observedFilter;
  const profiles = [
    {
      restaurantId,
      customerName: "Ama Mensah",
      customerPhone: "+233501231234",
      orderCount: 4,
      lastOrderAt: new Date("2026-09-10T10:00:00.000Z"),
      averageOrderValue: 82.345,
      marketingConsent: true,
      isOptedOut: false
    },
    {
      restaurantId: otherRestaurantId,
      customerName: "Other Tenant Customer",
      customerPhone: "+233509999999",
      orderCount: 9,
      lastOrderAt: new Date("2026-09-11T10:00:00.000Z"),
      averageOrderValue: 999,
      marketingConsent: true,
      isOptedOut: false
    }
  ];

  try {
    CustomerProfile.find = (filter) => {
      observedFilter = filter;
      const query = {
        select: () => query,
        sort: () => query,
        limit: async () =>
          profiles.filter(
            (profile) => profile.restaurantId === filter.restaurantId
          )
      };
      return query;
    };

    const customers = await listCustomers({
      restaurantId,
      marketingStatus: "opted_in"
    });

    assert.deepEqual(observedFilter, {
      restaurantId,
      marketingConsent: true,
      isOptedOut: { $ne: true }
    });
    assert.deepEqual(customers, [
      {
        name: "Ama Mensah",
        maskedPhone: "***1234",
        orderCount: 4,
        lastOrderAt: "2026-09-10T10:00:00.000Z",
        averageOrderValue: 82.35,
        marketingStatus: "opted_in"
      }
    ]);
    assert.doesNotMatch(JSON.stringify(customers), /Other Tenant Customer/);
  } finally {
    CustomerProfile.find = originalFind;
  }
});

test("new owner intelligence tools are staff-only with compact schemas", () => {
  for (const toolName of ["get_item_performance", "list_customers"]) {
    assert.equal(isToolAllowedForRole(toolName, "owner"), true);
    assert.equal(isToolAllowedForRole(toolName, "manager"), true);
    assert.equal(isToolAllowedForRole(toolName, "customer"), false);
  }
  const ownerDefinitions = getAgentToolDefinitionsForRole("owner");
  const itemDefinition = ownerDefinitions.find(
    (definition) => definition.function.name === "get_item_performance"
  );
  assert.deepEqual(itemDefinition.function.parameters.properties.period.enum, [
    "today",
    "yesterday",
    "this_week",
    "last_week",
    "all_time",
    "custom"
  ]);
  assert.deepEqual(customerMarketingStatuses, [
    "opted_in",
    "opted_out",
    "awaiting_response",
    "not_asked",
    "any"
  ]);
  assert.equal(
    toolRegistry.get_business_report.schema.safeParse({ period: "custom" }).success,
    false
  );
});

test("no opted-in customers returns a direct answer instead of invented privacy", async () => {
  const originalFind = CustomerProfile.find;
  try {
    CustomerProfile.find = () => {
      const query = {
        select: () => query,
        sort: () => query,
        limit: async () => []
      };
      return query;
    };
    const result = await toolRegistry.list_customers.handler(
      { marketingStatus: "opted_in" },
      {
        restaurantId,
        restaurant: { timezone: "Africa/Accra" },
        sender: { role: "owner", normalizedPhone: "+233500000000" }
      }
    );
    assert.equal(result.message, "There are currently no opted-in customers.");
    assert.doesNotMatch(result.message, /privacy|security|cannot access/i);
  } finally {
    CustomerProfile.find = originalFind;
  }
});

test("staff final-text safety removes every registered tool name and raw database IDs", () => {
  const unsafe =
    "My `get_business_report` tool and get_sales_summary found this. Use list_customers, then get_item_performance. Record 64b000000000000000000abc; order ORD-204.";
  const safe = sanitizeStaffFacingFinalText(unsafe);

  for (const toolName of Object.keys(toolRegistry)) {
    assert.doesNotMatch(safe, new RegExp(toolName, "i"));
  }
  assert.doesNotMatch(safe, /64b000000000000000000abc/i);
  assert.match(safe, /ORD-204/);
});

test("exact lifetime demand question executes all-time demand analytics and returns safe prose", async () => {
  const executed = [];
  let call = 0;
  const provider = {
    name: "openrouter",
    model: "test-model",
    complete: async () => {
      call += 1;
      if (call === 1) {
        return {
          toolCalls: [
            {
              id: "call_item_performance",
              name: "get_item_performance",
              arguments: {
                period: "all_time",
                metric: "demand_quantity",
                limit: 1
              }
            }
          ]
        };
      }
      return {
        text:
          "The `get_item_performance` tool found Jollof Rice is your most ordered item overall: 84 portions across 52 orders.",
        toolCalls: []
      };
    }
  };
  const result = await runAgentOrchestrator(
    {
      restaurant: {
        _id: restaurantId,
        name: "Golden Grill",
        timezone: "Africa/Accra"
      },
      sender: {
        phone: "+233500000000",
        normalizedPhone: "+233500000000",
        role: "owner",
        verified: true
      },
      message: "What is the most ordered food since we started?"
    },
    {
      provider,
      getHistory: async () => [],
      saveMessage: async () => {},
      buildSystemPrompt: async () => "Use backend facts.",
      executeTool: async (toolName, args) => {
        executed.push({ toolName, args });
        return {
          success: true,
          message: "Item performance retrieved successfully.",
          data: {
            metric: "demand_quantity",
            items: [
              {
                name: "Jollof Rice",
                demandQuantity: 84,
                demandOrderCount: 52
              }
            ]
          }
        };
      }
    }
  );

  assert.deepEqual(executed, [
    {
      toolName: "get_item_performance",
      args: { period: "all_time", metric: "demand_quantity", limit: 1 }
    }
  ]);
  assert.match(result.message, /Jollof Rice.*84 portions.*52 orders/i);
  assert.doesNotMatch(result.message, /get_item_performance/);
  assert.doesNotMatch(result.message, /today|this week|privacy/i);
});

test("multi-turn owner correction overrides growth and finite-period assumptions", async () => {
  const firstQuestion = "So far, what is the fastest growing food?";
  const clarification =
    "Which period should I compare — this week, this month, or a custom range?";
  const correction =
    "I'm not talking about today or this week. I'm talking about the entire orders since the beginning of operations. I mean the food customers have ordered the most.";
  const executed = [];
  let providerCall = 0;
  let firstRequestMessages;
  const result = await runAgentOrchestrator(
    {
      restaurant: {
        _id: restaurantId,
        name: "Golden Grill",
        timezone: "Africa/Accra"
      },
      sender: {
        phone: "+233500000000",
        normalizedPhone: "+233500000000",
        role: "owner",
        verified: true
      },
      message: correction
    },
    {
      provider: {
        name: "openrouter",
        model: "test-model",
        complete: async (request) => {
          providerCall += 1;
          if (providerCall === 1) {
            firstRequestMessages = request.messages.map((message) => ({
              role: message.role,
              content: message.content
            }));
            return {
              toolCalls: [
                {
                  id: "corrected_item_lookup",
                  name: "get_item_performance",
                  arguments: {
                    period: "all_time",
                    metric: "demand_quantity",
                    limit: 1
                  }
                }
              ]
            };
          }
          return {
            text:
              "Jollof Rice is the most ordered food overall: 84 portions across 52 orders, according to get_item_performance.",
            toolCalls: []
          };
        }
      },
      getHistory: async () => [
        { role: "user", content: firstQuestion },
        { role: "assistant", content: clarification }
      ],
      saveMessage: async () => {},
      buildSystemPrompt: async () => "Use the latest correction and backend facts.",
      executeTool: async (toolName, args) => {
        executed.push({ toolName, args });
        return {
          success: true,
          message: "Item performance retrieved successfully.",
          data: {
            items: [
              {
                name: "Jollof Rice",
                demandQuantity: 84,
                demandOrderCount: 52
              }
            ]
          }
        };
      }
    }
  );

  assert.deepEqual(
    firstRequestMessages.slice(1),
    [
      { role: "user", content: firstQuestion },
      { role: "assistant", content: clarification },
      { role: "user", content: correction }
    ]
  );
  assert.deepEqual(executed, [
    {
      toolName: "get_item_performance",
      args: { period: "all_time", metric: "demand_quantity", limit: 1 }
    }
  ]);
  assert.equal(result.executedTools.some((tool) => tool.name === "get_business_report"), false);
  assert.match(result.message, /Jollof Rice.*84 portions.*52 orders/i);
  assert.doesNotMatch(
    result.message,
    /growth|which period|historical information is unavailable|get_item_performance/i
  );
});

test("multi-turn metric correction changes weekly growth to weekly demand", async () => {
  let providerCall = 0;
  const executed = [];
  const result = await runAgentOrchestrator(
    {
      restaurant: {
        _id: restaurantId,
        name: "Golden Grill",
        timezone: "Africa/Accra"
      },
      sender: {
        phone: "+233500000000",
        normalizedPhone: "+233500000000",
        role: "owner",
        verified: true
      },
      message: "No, I mean which food has been ordered the most this week."
    },
    {
      provider: {
        name: "openrouter",
        model: "test-model",
        complete: async () => {
          providerCall += 1;
          return providerCall === 1
            ? {
                toolCalls: [
                  {
                    id: "weekly_demand_correction",
                    name: "get_item_performance",
                    arguments: {
                      period: "this_week",
                      metric: "demand_quantity",
                      limit: 1
                    }
                  }
                ]
              }
            : {
                text: "Jollof Rice has the highest demand this week.",
                toolCalls: []
              };
        }
      },
      getHistory: async () => [
        { role: "user", content: "What is growing fastest this week?" },
        { role: "assistant", content: "Jollof Rice grew fastest this week." }
      ],
      saveMessage: async () => {},
      buildSystemPrompt: async () => "Use the latest correction.",
      executeTool: async (toolName, args) => {
        executed.push({ toolName, args });
        return {
          success: true,
          message: "Item performance retrieved successfully.",
          data: { items: [{ name: "Jollof Rice", demandQuantity: 20 }] }
        };
      }
    }
  );

  assert.deepEqual(executed, [
    {
      toolName: "get_item_performance",
      args: { period: "this_week", metric: "demand_quantity", limit: 1 }
    }
  ]);
  assert.doesNotMatch(result.message, /growing|growth|get_business_report/i);
});

test("successful opted-in lookup replaces hallucinated customer names with backend truth", async () => {
  let call = 0;
  const result = await runAgentOrchestrator(
    {
      restaurant: {
        _id: restaurantId,
        name: "Golden Grill",
        timezone: "Africa/Accra"
      },
      sender: {
        phone: "+233500000000",
        normalizedPhone: "+233500000000",
        role: "owner",
        verified: true
      },
      message: "Who are the customers that has opted in?"
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
                  {
                    id: "call_customers",
                    name: "list_customers",
                    arguments: { marketingStatus: "opted_in" }
                  }
                ]
              }
            : {
                text: "Sarah and John are opted in.",
                toolCalls: []
              };
        }
      },
      getHistory: async () => [],
      saveMessage: async () => {},
      buildSystemPrompt: async () => "Use backend facts.",
      executeTool: async () => ({
        success: true,
        message: "2 customers matched.",
        data: [
          { name: "Ama Mensah", maskedPhone: "***1234" },
          { name: "Kojo Asante", maskedPhone: "***9876" }
        ]
      })
    }
  );

  assert.equal(
    result.message,
    "2 customers have opted in:\n1. Ama Mensah\n2. Kojo Asante"
  );
  assert.doesNotMatch(result.message, /Sarah|John/i);
});

test("successful empty opted-in lookup overrides an ungrounded refusal", async () => {
  let call = 0;
  const result = await runAgentOrchestrator(
    {
      restaurant: {
        _id: restaurantId,
        name: "Golden Grill",
        timezone: "Africa/Accra"
      },
      sender: {
        phone: "+233500000000",
        normalizedPhone: "+233500000000",
        role: "owner",
        verified: true
      },
      message: "Who opted in?"
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
                  {
                    id: "call_empty_customers",
                    name: "list_customers",
                    arguments: { marketingStatus: "opted_in" }
                  }
                ]
              }
            : {
                text: "I can't show that information.",
                toolCalls: []
              };
        }
      },
      getHistory: async () => [],
      saveMessage: async () => {},
      buildSystemPrompt: async () => "Use backend facts.",
      executeTool: async () => ({
        success: true,
        message: "There are currently no opted-in customers.",
        data: []
      })
    }
  );

  assert.equal(result.message, "There are currently no opted-in customers.");
  assert.doesNotMatch(result.message, /can't show|cannot|privacy|security/i);
});

test("owner prompt encodes corrections, metric distinctions, campaign safety, and concise answers", async () => {
  const prompt = await buildAgentSystemPrompt(
    {
      _id: restaurantId,
      name: "Golden Grill",
      timezone: "Africa/Accra"
    },
    {
      phone: "+233500000000",
      normalizedPhone: "+233500000000",
      role: "owner",
      verified: true
    },
    ["get_business_report", "get_item_performance", "list_customers"],
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

  assert.match(prompt, /latest explicit correction overrides/i);
  assert.match(prompt, /Most ordered.*demand_quantity/i);
  assert.match(prompt, /Growth requires a finite/i);
  assert.match(prompt, /does not authorize campaign creation/i);
  assert.match(prompt, /1 to 4 short sentences/i);
  assert.match(prompt, /Never invent a privacy, legal, regulatory, security/i);
  assert.match(prompt, /who opted in.*marketingStatus opted_in/i);
});
