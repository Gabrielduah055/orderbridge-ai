const assert = require("node:assert/strict");
const test = require("node:test");

const { Order, orderStatuses } = require("../dist/models/order.model");
const { Restaurant } = require("../dist/models/Restaurant");
const { MenuItem } = require("../dist/models/MenuItem");
const { CustomerProfile } = require("../dist/models/customerProfile.model");
const {
  createRestaurantSchema
} = require("../dist/middleware/validateRequest");
const ownerSummaryService = require("../dist/services/ownerSummary.service");
const {
  buildOwnerSummaryMetrics,
  calculatePercentageChange,
  formatGhsCurrency,
  formatOwnerSummaryMessage,
  getActiveOrderCount,
  getBusinessReport,
  getOwnerSummaryMetrics,
  getPreviousDailySummaryPeriod,
  getPreviousWeeklySummaryPeriod,
  resolveBusinessReportPeriod,
  resolvePreviousEquivalentBusinessReportPeriod
} = ownerSummaryService;
const {
  runOwnerSummarySchedulerPass
} = require("../dist/services/ownerSummaryScheduler.service");
const {
  isTransactionalQueuedMessage
} = require("../dist/services/wasenderQueue.service");
const { toolRegistry } = require("../dist/agent-tools/tool.registry");
const {
  isToolAllowedForRole
} = require("../dist/agent-tools/tool.permissions");
const {
  getAgentToolDefinitionsForRole
} = require("../dist/services/ai/agentToolDefinitions.service");

const restaurantId = "64b000000000000000000901";
const periodStart = new Date("2026-07-20T00:00:00.000Z");
const periodEnd = new Date("2026-07-27T00:00:00.000Z");

const makeOrder = ({
  status,
  total,
  customerPhone,
  items = [],
  createdAt = new Date("2026-07-22T12:00:00.000Z")
}) => ({
  status,
  total,
  customerPhone,
  items,
  createdAt
});

const metricInput = (overrides = {}) => ({
  restaurantId,
  periodStart,
  periodEnd,
  timezone: "Africa/Accra",
  periodType: "weekly",
  ...overrides
});

const emptyCountsByStatus = () =>
  Object.fromEntries(orderStatuses.map((status) => [status, 0]));

const makeMetrics = (input) => ({
  restaurantId: input.restaurantId,
  periodType: input.periodType,
  periodStart: input.periodStart,
  periodEnd: input.periodEnd,
  timezone: input.timezone,
  totalOrders: 0,
  countsByStatus: emptyCountsByStatus(),
  completedOrders: 0,
  cancelledOrders: 0,
  completedRevenue: 0,
  averageCompletedOrderValue: 0,
  topSellingItems: [],
  uniqueCustomers: 0,
  newCustomers: 0,
  returningCustomers: 0,
  busiestDay: null
});

const makeDetailedMetrics = (input, overrides = {}) => {
  const countsByStatus = emptyCountsByStatus();
  countsByStatus.completed = 18;
  countsByStatus.rejected = 2;
  countsByStatus.cancelled = 1;
  countsByStatus.pending = 1;

  return {
    ...makeMetrics(input),
    totalOrders: 22,
    countsByStatus,
    completedOrders: 18,
    cancelledOrders: 1,
    completedRevenue: 4280,
    averageCompletedOrderValue: 237.78,
    topSellingItems: [
      { name: "Jollof Rice", quantity: 51, revenue: 1785 },
      { name: "Fried Rice", quantity: 38, revenue: 1520 },
      { name: "Chicken Salad", quantity: 19, revenue: 665 }
    ],
    uniqueCustomers: 17,
    newCustomers: 5,
    returningCustomers: 12,
    ...overrides
  };
};

const makeRestaurant = (overrides = {}) => ({
  _id: restaurantId,
  name: "Tenant Restaurant",
  ownerPhone: "0557038547",
  wasenderSessionId: "wasender-session-1",
  wasenderApiToken: "restaurant-api-key",
  timezone: "Africa/Accra",
  ownerDailySummaryEnabled: true,
  ownerDailySummaryTime: "08:00",
  ownerWeeklySummaryEnabled: false,
  ownerWeeklySummaryDay: "thursday",
  ownerWeeklySummaryTime: "08:00",
  ...overrides
});

test("owner summary revenue, average, status counts, and top items use completed orders only", () => {
  const completedJollofId = "64b000000000000000000911";
  const metrics = buildOwnerSummaryMetrics(
    metricInput(),
    [
      makeOrder({
        status: "completed",
        total: 100,
        customerPhone: "0557038547",
        createdAt: new Date("2026-07-22T12:00:00.000Z"),
        items: [
          {
            menuItemId: completedJollofId,
            name: "Jollof",
            quantity: 2,
            totalPrice: 60
          }
        ]
      }),
      makeOrder({
        status: "completed",
        total: 50,
        customerPhone: "+233241234567",
        createdAt: new Date("2026-07-22T15:00:00.000Z"),
        items: [
          {
            menuItemId: completedJollofId,
            name: "Jollof",
            quantity: 1,
            totalPrice: 30
          },
          {
            menuItemId: "64b000000000000000000912",
            name: "Fish",
            quantity: 1,
            totalPrice: 20
          }
        ]
      }),
      makeOrder({
        status: "cancelled",
        total: 999,
        customerPhone: "+233501111111",
        createdAt: new Date("2026-07-23T10:00:00.000Z"),
        items: [
          {
            menuItemId: "64b000000000000000000913",
            name: "Cancelled Burger",
            quantity: 50,
            totalPrice: 999
          }
        ]
      }),
      makeOrder({
        status: "rejected",
        total: 888,
        customerPhone: "+233502222222",
        createdAt: new Date("2026-07-23T11:00:00.000Z"),
        items: [
          {
            menuItemId: "64b000000000000000000914",
            name: "Rejected Pizza",
            quantity: 40,
            totalPrice: 888
          }
        ]
      })
    ],
    []
  );

  assert.equal(metrics.totalOrders, 4);
  assert.equal(metrics.countsByStatus.completed, 2);
  assert.equal(metrics.countsByStatus.cancelled, 1);
  assert.equal(metrics.countsByStatus.rejected, 1);
  assert.equal(metrics.completedOrders, 2);
  assert.equal(metrics.cancelledOrders, 1);
  assert.equal(metrics.completedRevenue, 150);
  assert.equal(metrics.averageCompletedOrderValue, 75);
  assert.deepEqual(metrics.topSellingItems, [
    {
      menuItemId: completedJollofId,
      name: "Jollof",
      quantity: 3,
      revenue: 90
    },
    {
      menuItemId: "64b000000000000000000912",
      name: "Fish",
      quantity: 1,
      revenue: 20
    }
  ]);
  assert.deepEqual(metrics.busiestDay, {
    date: "2026-07-22",
    day: "wednesday",
    totalOrders: 2
  });
  assert.equal(metrics.uniqueCustomers, 2);
  assert.match(
    formatOwnerSummaryMessage(
      "Tenant Restaurant",
      {
        type: "weekly",
        timezone: "Africa/Accra",
        periodStart,
        periodEnd,
        key: "2026-07-20_to_2026-07-26"
      },
      metrics
    ),
    /BUSIEST DAY[\s\S]*Wednesday — 2 orders/
  );
});

test("new and returning customer counts use completed orders and normalized phone history only", () => {
  const metrics = buildOwnerSummaryMetrics(
    metricInput({ periodType: "daily" }),
    [
      makeOrder({
        status: "completed",
        total: 10,
        customerPhone: "0557038547"
      }),
      makeOrder({
        status: "completed",
        total: 20,
        customerPhone: "0241234567"
      }),
      makeOrder({
        status: "cancelled",
        total: 30,
        customerPhone: "+233501111111"
      }),
      makeOrder({
        status: "rejected",
        total: 40,
        customerPhone: "+233502222222"
      }),
      makeOrder({
        status: "pending",
        total: 50,
        customerPhone: "+233503333333"
      }),
      makeOrder({
        status: "accepted",
        total: 60,
        customerPhone: "+233504444444"
      }),
      makeOrder({
        status: "preparing",
        total: 70,
        customerPhone: "+233505555555"
      }),
      makeOrder({
        status: "ready",
        total: 80,
        customerPhone: "+233506666666"
      })
    ],
    [
      {
        status: "completed",
        customerPhone: "233557038547"
      },
      {
        status: "cancelled",
        customerPhone: "+233241234567"
      }
    ]
  );

  assert.equal(metrics.totalOrders, 8);
  assert.equal(metrics.countsByStatus.cancelled, 1);
  assert.equal(metrics.countsByStatus.rejected, 1);
  assert.equal(metrics.countsByStatus.pending, 1);
  assert.equal(metrics.countsByStatus.accepted, 1);
  assert.equal(metrics.countsByStatus.preparing, 1);
  assert.equal(metrics.countsByStatus.ready, 1);
  assert.equal(metrics.uniqueCustomers, 2);
  assert.equal(metrics.returningCustomers, 1);
  assert.equal(metrics.newCustomers, 1);
});

test("owner summary order queries are all scoped by restaurantId", async () => {
  const originalFind = Order.find;
  const filters = [];

  try {
    Order.find = (filter) => {
      filters.push(filter);
      return {
        select: async () => []
      };
    };

    await getOwnerSummaryMetrics(
      metricInput({
        periodType: "daily"
      })
    );
  } finally {
    Order.find = originalFind;
  }

  assert.equal(filters.length, 2);

  for (const filter of filters) {
    assert.equal(filter.restaurantId, restaurantId);
  }

  assert.deepEqual(filters[0].createdAt, {
    $gte: periodStart,
    $lt: periodEnd
  });
  assert.deepEqual(filters[1].createdAt, {
    $lt: periodStart
  });
  assert.equal(filters[1].status, "completed");
});

test("today orders and sales tools expose completed-only reporting metrics", async () => {
  const originalFind = Order.find;
  const originalCountDocuments = MenuItem.countDocuments;
  const originalCustomerCountDocuments = CustomerProfile.countDocuments;
  const completedItemId = "64b000000000000000000941";
  const periodOrders = [
    makeOrder({
      status: "completed",
      total: 75,
      customerPhone: "0557038547",
      items: [
        {
          menuItemId: completedItemId,
          name: "Waakye",
          quantity: 2,
          totalPrice: 60
        }
      ]
    }),
    makeOrder({
      status: "cancelled",
      total: 500,
      customerPhone: "0241234567",
      items: [
        {
          menuItemId: "64b000000000000000000942",
          name: "Cancelled Item",
          quantity: 20,
          totalPrice: 500
        }
      ]
    }),
    makeOrder({
      status: "rejected",
      total: 400,
      customerPhone: "0500000001",
      items: []
    })
  ];
  const context = {
    restaurantId,
    restaurant: {
      name: "Tenant Restaurant",
      timezone: "Africa/Accra"
    },
    sender: { role: "owner", normalizedPhone: "+233557038547" }
  };

  try {
    Order.find = (filter) => ({
      select: async () => (filter.createdAt.$gte ? periodOrders : [])
    });
    MenuItem.countDocuments = async (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      return 3;
    };
    CustomerProfile.countDocuments = async (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      return 0;
    };

    const today = await toolRegistry.get_today_orders.handler({}, context);
    const yesterday = await toolRegistry.get_yesterday_orders.handler(
      {},
      context
    );
    const sales = await toolRegistry.get_sales_summary.handler({}, context);
    const business = await toolRegistry.get_business_summary.handler(
      {},
      context
    );

    assert.equal(today.data.totalOrders, 3);
    assert.equal(today.data.revenue, 75);
    assert.equal(today.data.statuses.cancelled, 1);
    assert.equal(today.data.statuses.rejected, 1);
    assert.equal(today.data.uniqueCustomers, 1);
    assert.equal(today.data.newCustomers, 1);
    assert.equal(sales.data.revenue, 75);
    assert.deepEqual(sales.data.bestSellingItem, {
      menuItemId: completedItemId,
      name: "Waakye",
      quantity: 2,
      revenue: 60
    });
    assert.equal(yesterday.success, true);
    assert.equal(yesterday.data.revenue, 75);
    assert.equal(business.data.todayOrderCount, 3);
    assert.equal(business.data.todayRevenue, 75);
    assert.equal(business.data.unavailableItems, 3);
  } finally {
    Order.find = originalFind;
    MenuItem.countDocuments = originalCountDocuments;
    CustomerProfile.countDocuments = originalCustomerCountDocuments;
  }
});

test("get_business_report supports all periods and remains context scoped", async () => {
  const originalFind = Order.find;
  const originalCustomerCountDocuments = CustomerProfile.countDocuments;
  const filters = [];
  const context = {
    restaurantId,
    restaurant: {
      name: "Tenant Restaurant",
      timezone: "Africa/Accra"
    },
    sender: { role: "owner", normalizedPhone: "+233557038547" }
  };

  try {
    Order.find = (filter) => {
      filters.push(filter);
      return { select: async () => [] };
    };
    CustomerProfile.countDocuments = async () => 0;

    for (const period of [
      "today",
      "yesterday",
      "this_week",
      "last_week"
    ]) {
      const result = await toolRegistry.get_business_report.handler(
        { period },
        context
      );

      assert.equal(result.success, true);
      assert.equal(result.data.period.type, period);
      assert.match(result.data.formattedReport, /TENANT RESTAURANT/);
      assert.equal(result.data.customerMarketing.totalCustomers, 0);
      assert.match(result.data.formattedReport, /CUSTOMER MARKETING \(CURRENT SNAPSHOT\)/);
    }
  } finally {
    Order.find = originalFind;
    CustomerProfile.countDocuments = originalCustomerCountDocuments;
  }

  assert.equal(filters.length, 8);
  for (const filter of filters) {
    assert.equal(filter.restaurantId, restaurantId);
  }
  assert.equal(
    toolRegistry.get_business_report.schema.safeParse({
      period: "today",
      restaurantId: "64b000000000000000000999"
    }).success,
    false
  );
});

test("business report permissions allow staff and deny customers", () => {
  assert.equal(isToolAllowedForRole("get_business_report", "owner"), true);
  assert.equal(isToolAllowedForRole("get_business_report", "manager"), true);
  assert.equal(isToolAllowedForRole("get_business_report", "customer"), false);

  const ownerTools = getAgentToolDefinitionsForRole("owner").map(
    (tool) => tool.function.name
  );
  const managerTools = getAgentToolDefinitionsForRole("manager").map(
    (tool) => tool.function.name
  );
  const customerTools = getAgentToolDefinitionsForRole("customer").map(
    (tool) => tool.function.name
  );

  assert.equal(ownerTools.includes("get_business_report"), true);
  assert.equal(managerTools.includes("get_business_report"), true);
  assert.equal(customerTools.includes("get_business_report"), false);
});

test("daily and weekly completed periods respect the configured timezone", () => {
  const now = new Date("2026-03-09T12:00:00.000Z");
  const daily = getPreviousDailySummaryPeriod(now, "America/New_York");
  const weekly = getPreviousWeeklySummaryPeriod(now, "America/New_York");

  assert.equal(daily.periodStart.toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(daily.periodEnd.toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal(daily.key, "2026-03-08");
  assert.equal(weekly.periodStart.toISOString(), "2026-03-02T05:00:00.000Z");
  assert.equal(weekly.periodEnd.toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal(weekly.key, "2026-03-02_to_2026-03-08");
});

test("today and yesterday business periods use restaurant-local calendar boundaries", () => {
  const now = new Date("2026-08-08T02:30:00.000Z");
  const today = resolveBusinessReportPeriod(
    "today",
    now,
    "America/New_York"
  );
  const yesterday = resolveBusinessReportPeriod(
    "yesterday",
    now,
    "America/New_York"
  );

  assert.equal(today.periodStart.toISOString(), "2026-08-07T04:00:00.000Z");
  assert.equal(today.periodEnd.toISOString(), now.toISOString());
  assert.equal(today.key, "2026-08-07");
  assert.equal(
    yesterday.periodStart.toISOString(),
    "2026-08-06T04:00:00.000Z"
  );
  assert.equal(
    yesterday.periodEnd.toISOString(),
    "2026-08-07T04:00:00.000Z"
  );
  assert.equal(yesterday.key, "2026-08-06");
});

test("this week starts Monday and compares the same local elapsed time", () => {
  const now = new Date("2026-08-05T19:00:00.000Z");
  const current = resolveBusinessReportPeriod(
    "this_week",
    now,
    "America/New_York"
  );
  const previous = resolvePreviousEquivalentBusinessReportPeriod(current);

  assert.equal(
    current.periodStart.toISOString(),
    "2026-08-03T04:00:00.000Z"
  );
  assert.equal(current.periodEnd.toISOString(), now.toISOString());
  assert.equal(
    previous.periodStart.toISOString(),
    "2026-07-27T04:00:00.000Z"
  );
  assert.equal(
    previous.periodEnd.toISOString(),
    "2026-07-29T19:00:00.000Z"
  );
});

test("last week resolves the previous restaurant-local Monday through Sunday", () => {
  const period = resolveBusinessReportPeriod(
    "last_week",
    new Date("2026-08-05T19:00:00.000Z"),
    "America/New_York"
  );

  assert.equal(
    period.periodStart.toISOString(),
    "2026-07-27T04:00:00.000Z"
  );
  assert.equal(
    period.periodEnd.toISOString(),
    "2026-08-03T04:00:00.000Z"
  );
  assert.equal(period.key, "2026-07-27_to_2026-08-02");
});

test("active order count excludes every terminal report status", () => {
  const counts = emptyCountsByStatus();
  counts.completed = 4;
  counts.cancelled = 3;
  counts.rejected = 2;
  counts.expired = 1;
  counts.pending = 2;
  counts.preparing = 1;

  assert.equal(getActiveOrderCount(counts), 3);
});

test("historical top-seller revenue uses completed order item snapshots", () => {
  const historicalUnitPrice = 35;
  const currentMenuPrice = 45;
  const metrics = buildOwnerSummaryMetrics(
    metricInput({ periodType: "daily" }),
    [
      makeOrder({
        status: "completed",
        total: 70,
        customerPhone: "0557038547",
        items: [
          {
            menuItemId: "64b000000000000000000951",
            name: "Jollof Rice",
            quantity: 2,
            unitPrice: historicalUnitPrice,
            totalPrice: 70
          }
        ]
      })
    ],
    []
  );

  assert.notEqual(historicalUnitPrice, currentMenuPrice);
  assert.equal(metrics.topSellingItems[0].revenue, 70);
  assert.equal(metrics.completedRevenue, 70);
});

test("daily WhatsApp report contains detailed sales, orders, top items, and customers", async () => {
  const report = await getBusinessReport(
    {
      restaurantId,
      restaurantName: "Golden Grill",
      timezone: "Africa/Accra",
      period: "today",
      now: new Date("2026-08-08T15:00:00.000Z")
    },
    {
      getMetrics: async (input) => makeDetailedMetrics(input)
    }
  );

  assert.equal(report.period.type, "today");
  assert.equal(report.orders.active, 1);
  assert.equal(report.topSellingItems[0].menuItemId, undefined);
  assert.match(report.formattedReport, /TODAY'S REPORT/);
  assert.match(report.formattedReport, /💰 SALES SUMMARY/);
  assert.match(report.formattedReport, /Revenue: GHS 4,280\.00/);
  assert.match(report.formattedReport, /📦 ORDER SUMMARY/);
  assert.match(report.formattedReport, /🍽️ TOP SELLING ITEMS/);
  assert.match(report.formattedReport, /👥 CUSTOMERS/);
  assert.doesNotMatch(report.formattedReport, /BUSIEST DAY/);
  assert.equal(formatGhsCurrency(4280), "GHS 4,280.00");
});

test("weekly formatter includes busiest day and shows at most five top items", async () => {
  const topSellingItems = Array.from({ length: 6 }, (_, index) => ({
    name: `Item ${index + 1}`,
    quantity: 10 - index,
    revenue: 100 - index
  }));
  const report = await getBusinessReport(
    {
      restaurantId,
      restaurantName: "Golden Grill",
      timezone: "Africa/Accra",
      period: "this_week",
      now: new Date("2026-08-08T15:00:00.000Z")
    },
    {
      getMetrics: async (input) =>
        makeDetailedMetrics(input, {
          topSellingItems,
          busiestDay: {
            date: "2026-08-07",
            day: "friday",
            totalOrders: 24
          }
        })
    }
  );

  assert.equal(report.topSellingItems.length, 5);
  assert.match(report.formattedReport, /📅 BUSIEST DAY/);
  assert.match(report.formattedReport, /Friday — 24 orders/);
  assert.match(report.formattedReport, /5\. Item 5/);
  assert.doesNotMatch(report.formattedReport, /Item 6/);
});

test("comparison percentages are backend-calculated with safe zero baselines", async () => {
  let metricsCall = 0;
  const report = await getBusinessReport(
    {
      restaurantId,
      restaurantName: "Golden Grill",
      timezone: "Africa/Accra",
      period: "this_week",
      compareWithPrevious: true,
      now: new Date("2026-08-05T15:00:00.000Z")
    },
    {
      getMetrics: async (input) => {
        metricsCall += 1;
        return makeDetailedMetrics(
          input,
          metricsCall === 1
            ? {
                totalOrders: 12,
                completedRevenue: 120,
                averageCompletedOrderValue: 10
              }
            : {
                totalOrders: 10,
                completedRevenue: 60,
                averageCompletedOrderValue: 6
              }
        );
      }
    }
  );

  assert.equal(report.comparison.previousPeriodLabel, "Last week");
  assert.equal(report.comparison.revenue.percentageChange, 100);
  assert.equal(report.comparison.totalOrders.percentageChange, 20);
  assert.equal(report.comparison.averageOrderValue.percentageChange, 66.7);
  assert.match(report.formattedReport, /📈 VS LAST WEEK/);
  assert.equal(calculatePercentageChange(0, 0), 0);
  assert.equal(calculatePercentageChange(10, 0), null);
  assert.equal(JSON.stringify(report).includes("Infinity"), false);
});

test("restaurant summary settings have safe defaults and validation", () => {
  assert.equal(Restaurant.schema.path("timezone").options.default, "Africa/Accra");
  assert.equal(Restaurant.schema.path("ownerDailySummaryEnabled").options.default, true);
  assert.equal(Restaurant.schema.path("ownerDailySummaryTime").options.default, "08:00");
  assert.equal(Restaurant.schema.path("ownerWeeklySummaryEnabled").options.default, true);
  assert.equal(Restaurant.schema.path("ownerWeeklySummaryDay").options.default, "monday");
  assert.equal(Restaurant.schema.path("ownerWeeklySummaryTime").options.default, "08:00");

  const invalid = createRestaurantSchema.safeParse({
    name: "Invalid Settings",
    ownerPhone: "0557038547",
    wasenderSessionId: "session",
    whatsappNumber: "0557038547",
    timezone: "Not/A_Timezone",
    ownerDailySummaryTime: "25:00"
  });

  assert.equal(invalid.success, false);
  assert.equal(isTransactionalQueuedMessage({ kind: "owner_summary" }), true);
});

test("duplicate scheduler passes enqueue only one summary for the period", async () => {
  const queuedKeys = new Set();
  const enqueued = [];
  const dependencies = {
    loadRestaurants: async () => [makeRestaurant()],
    getMetrics: async (input) => makeMetrics(input),
    summaryExists: async (_scopedRestaurantId, idempotencyKey) =>
      queuedKeys.has(idempotencyKey),
    enqueueMessage: async (input) => {
      queuedKeys.add(input.idempotencyKey);
      enqueued.push(input);
      return { _id: `queue-${enqueued.length}` };
    }
  };
  const now = new Date("2026-07-30T09:00:00.000Z");

  const firstPass = await runOwnerSummarySchedulerPass(now, dependencies);
  const secondPass = await runOwnerSummarySchedulerPass(now, dependencies);

  assert.equal(firstPass.summariesQueued, 1);
  assert.equal(secondPass.summariesQueued, 0);
  assert.equal(enqueued.length, 1);
  assert.equal(
    enqueued[0].idempotencyKey,
    `owner-summary:daily:${restaurantId}:2026-07-29`
  );
});

test("one restaurant summary failure does not block another restaurant", async () => {
  const enqueued = [];
  const errors = [];
  const failingRestaurant = makeRestaurant({
    _id: "64b000000000000000000921",
    name: "Failing Tenant"
  });
  const healthyRestaurant = makeRestaurant({
    _id: "64b000000000000000000922",
    name: "Healthy Tenant",
    ownerPhone: "0241234567",
    wasenderSessionId: "healthy-session",
    wasenderApiToken: "healthy-key"
  });

  const result = await runOwnerSummarySchedulerPass(
    new Date("2026-07-30T09:00:00.000Z"),
    {
      loadRestaurants: async () => [failingRestaurant, healthyRestaurant],
      summaryExists: async () => false,
      getMetrics: async (input) => {
        if (input.restaurantId === String(failingRestaurant._id)) {
          throw new Error("Tenant metrics failed");
        }

        return makeMetrics(input);
      },
      enqueueMessage: async (input) => {
        enqueued.push(input);
        return { _id: "healthy-queue-message" };
      },
      logError: (message, context) => errors.push({ message, context })
    }
  );

  assert.equal(result.errors, 1);
  assert.equal(result.summariesQueued, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].restaurantId, String(healthyRestaurant._id));
  assert.equal(errors[0].context.restaurantId, String(failingRestaurant._id));
});

test("daily and weekly summaries are queued to each restaurant owner", async () => {
  const dailyRestaurant = makeRestaurant({
    _id: "64b000000000000000000931",
    name: "Daily Tenant",
    ownerPhone: "0557038547",
    wasenderSessionId: "daily-session",
    wasenderApiToken: "daily-key"
  });
  const weeklyRestaurant = makeRestaurant({
    _id: "64b000000000000000000932",
    name: "Weekly Tenant",
    ownerPhone: "0241234567",
    wasenderSessionId: "weekly-session",
    wasenderApiToken: "weekly-key",
    ownerDailySummaryEnabled: false,
    ownerWeeklySummaryEnabled: true,
    ownerWeeklySummaryDay: "thursday"
  });
  const enqueued = [];

  const result = await runOwnerSummarySchedulerPass(
    new Date("2026-07-30T09:00:00.000Z"),
    {
      loadRestaurants: async () => [dailyRestaurant, weeklyRestaurant],
      summaryExists: async () => false,
      getMetrics: async (input) => makeMetrics(input),
      enqueueMessage: async (input) => {
        enqueued.push(input);
        return { _id: `queue-${enqueued.length}` };
      }
    }
  );

  assert.equal(result.summariesQueued, 2);
  const daily = enqueued.find(
    (message) => message.metadata.summaryType === "daily"
  );
  const weekly = enqueued.find(
    (message) => message.metadata.summaryType === "weekly"
  );

  assert.equal(daily.to, "+233557038547");
  assert.equal(daily.sessionId, "daily-session");
  assert.equal(daily.apiKey, "daily-key");
  assert.match(daily.text, /YESTERDAY'S REPORT/);
  assert.match(daily.text, /SALES SUMMARY/);
  assert.match(daily.text, /ORDER SUMMARY/);
  assert.equal(weekly.to, "+233241234567");
  assert.equal(weekly.sessionId, "weekly-session");
  assert.equal(weekly.apiKey, "weekly-key");
  assert.match(weekly.text, /LAST WEEK'S REPORT/);
});

test("disabled owner summary settings do not queue messages", async () => {
  let metricsCalls = 0;
  let enqueueCalls = 0;

  const result = await runOwnerSummarySchedulerPass(
    new Date("2026-07-30T09:00:00.000Z"),
    {
      loadRestaurants: async () => [
        makeRestaurant({
          ownerDailySummaryEnabled: false,
          ownerWeeklySummaryEnabled: false
        })
      ],
      summaryExists: async () => false,
      getMetrics: async (input) => {
        metricsCalls += 1;
        return makeMetrics(input);
      },
      enqueueMessage: async () => {
        enqueueCalls += 1;
        return { _id: "unexpected" };
      }
    }
  );

  assert.equal(result.summariesQueued, 0);
  assert.equal(metricsCalls, 0);
  assert.equal(enqueueCalls, 0);
});
