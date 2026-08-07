const assert = require("node:assert/strict");
const test = require("node:test");

const { Order, orderStatuses } = require("../dist/models/order.model");
const { Restaurant } = require("../dist/models/Restaurant");
const {
  createRestaurantSchema
} = require("../dist/middleware/validateRequest");
const {
  buildOwnerSummaryMetrics,
  formatOwnerSummaryMessage,
  getOwnerSummaryMetrics,
  getPreviousDailySummaryPeriod,
  getPreviousWeeklySummaryPeriod
} = require("../dist/services/ownerSummary.service");
const {
  runOwnerSummarySchedulerPass
} = require("../dist/services/ownerSummaryScheduler.service");
const {
  isTransactionalQueuedMessage
} = require("../dist/services/wasenderQueue.service");
const { toolRegistry } = require("../dist/agent-tools/tool.registry");

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
    /Busiest day by orders received: 2026-07-22 \(2 orders\)/
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
      timezone: "Africa/Accra"
    }
  };

  try {
    Order.find = (filter) => ({
      select: async () => (filter.createdAt.$gte ? periodOrders : [])
    });

    const today = await toolRegistry.get_today_orders.handler({}, context);
    const sales = await toolRegistry.get_sales_summary.handler({}, context);

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
  } finally {
    Order.find = originalFind;
  }
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
  assert.match(daily.text, /Daily summary/);
  assert.equal(weekly.to, "+233241234567");
  assert.equal(weekly.sessionId, "weekly-session");
  assert.equal(weekly.apiKey, "weekly-key");
  assert.match(weekly.text, /Weekly summary/);
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
