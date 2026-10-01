const test = require("node:test");
const assert = require("node:assert/strict");
const { Types } = require("mongoose");

const { Order } = require("../dist/models/order.model");
const {
  StaffOrderQueryContext
} = require("../dist/models/staffQueryContext.model");
const {
  buildOwnerSummaryMetrics
} = require("../dist/services/ownerSummary.service");
const {
  formatRestaurantDateTime,
  listStaffOrders
} = require("../dist/services/staffOrderQuery.service");
const {
  runAgentOrchestrator
} = require("../dist/services/ai/agentOrchestrator.service");

const restaurantId = "64b000000000000000000001";
const senderPhone = "+233500000001";

const restore = (target, key, value) => {
  target[key] = value;
};

const orderQuery = (orders, state = {}) => ({
  sort() {
    return this;
  },
  skip(value) {
    state.offset = value;
    return this;
  },
  limit(value) {
    state.limit = value;
    return Promise.resolve(orders);
  }
});

const runGroundedOrderAnswer = async (message, data) => {
  let round = 0;
  const result = await runAgentOrchestrator(
    {
      restaurant: {
        _id: restaurantId,
        name: "OrderBridge Kitchen",
        timezone: "Africa/Accra"
      },
      sender: {
        phone: senderPhone,
        normalizedAddress: senderPhone,
        normalizedPhone: senderPhone,
        role: "owner",
        verified: true
      },
      message
    },
    {
      provider: {
        name: "openrouter",
        model: "test-model",
        complete: async () => {
          round += 1;
          return round === 1
            ? {
                text: null,
                toolCalls: [
                  { id: "call-1", name: "list_orders", arguments: {} }
                ]
              }
            : { text: "Unrelated full customer profile.", toolCalls: [] };
        }
      },
      getHistory: async () => [],
      saveMessage: async () => {},
      buildSystemPrompt: async () => "test",
      executeTool: async () => ({
        success: true,
        message: `${data.totalMatched} orders matched.`,
        data
      })
    }
  );

  return result.message;
};

const baseOrderListData = (overrides = {}) => ({
  period: {
    type: "custom",
    label: "Since September 1",
    timezone: "Africa/Accra"
  },
  totalMatched: 0,
  returnedCount: 0,
  truncated: false,
  nextOffset: null,
  orders: [],
  ...overrides
});

test("order follow-up reuses only trusted scoped filters and re-queries matching orders", async () => {
  const originals = {
    contextFindOne: StaffOrderQueryContext.findOne,
    contextFindOneAndUpdate: StaffOrderQueryContext.findOneAndUpdate,
    countDocuments: Order.countDocuments,
    find: Order.find
  };
  const periodStart = new Date("2026-09-01T00:00:00.000Z");
  const periodEnd = new Date("2026-10-01T00:00:00.000Z");
  let orderFilter;
  let savedContext;
  try {
    StaffOrderQueryContext.findOne = async (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      assert.equal(filter.senderPhone, senderPhone);
      return {
        periodType: "custom",
        periodLabel: "Since September 1",
        periodStart,
        periodEnd,
        timezone: "Africa/Accra"
      };
    };
    StaffOrderQueryContext.findOneAndUpdate = async (filter, update) => {
      savedContext = { filter, update };
    };
    Order.countDocuments = async (filter) => {
      orderFilter = filter;
      return 2;
    };
    Order.find = (filter) => {
      orderFilter = filter;
      return orderQuery([
        {
          _id: new Types.ObjectId(),
          orderNumber: "ORD-101",
          status: "completed",
          customerName: "Gabriel",
          customerPhone: "+233555000001",
          createdAt: new Date("2026-09-06T09:53:00.000Z"),
          completedAt: new Date("2026-09-06T10:30:00.000Z"),
          total: 5000000
        },
        {
          _id: new Types.ObjectId(),
          orderNumber: "ORD-102",
          status: "completed",
          customerName: "Gabriel",
          customerPhone: "+233555000001",
          createdAt: new Date("2026-09-20T18:15:00.000Z"),
          completedAt: new Date("2026-09-20T19:00:00.000Z"),
          total: 9000000
        }
      ]);
    };

    const result = await listStaffOrders({
      restaurantId,
      senderPhone,
      senderRole: "owner",
      originalMessage: "What time and date did they make the orders?",
      timezone: "Africa/Accra"
    });

    assert.deepEqual(orderFilter.createdAt, {
      $gte: periodStart,
      $lt: periodEnd
    });
    assert.equal(result.totalMatched, 2);
    assert.equal(result.orders[0].placedAtFormatted, "6 September 2026 at 9:53 a.m.");
    assert.notEqual(result.orders[0].placedAt, result.orders[0].completedAt);
    assert.equal(savedContext.filter.restaurantId, restaurantId);
    assert.equal(savedContext.filter.senderPhone, senderPhone);
  } finally {
    restore(StaffOrderQueryContext, "findOne", originals.contextFindOne);
    restore(
      StaffOrderQueryContext,
      "findOneAndUpdate",
      originals.contextFindOneAndUpdate
    );
    restore(Order, "countDocuments", originals.countDocuments);
    restore(Order, "find", originals.find);
  }
});

test("restaurant date formatter applies timezone boundaries and readable meridiem", () => {
  assert.equal(
    formatRestaurantDateTime(
      new Date("2026-09-05T23:53:00.000Z"),
      "Africa/Accra"
    ),
    "5 September 2026 at 11:53 p.m."
  );
  assert.equal(
    formatRestaurantDateTime(
      new Date("2026-09-06T00:53:00.000Z"),
      "Africa/Lagos"
    ),
    "6 September 2026 at 1:53 a.m."
  );
});

test("customer-name aggregation matches the tenant with a MongoDB ObjectId", async () => {
  const originals = {
    contextFindOneAndUpdate: StaffOrderQueryContext.findOneAndUpdate,
    aggregate: Order.aggregate,
    countDocuments: Order.countDocuments,
    find: Order.find
  };
  let aggregationPipeline;
  try {
    StaffOrderQueryContext.findOneAndUpdate = async () => {};
    Order.aggregate = async (pipeline) => {
      aggregationPipeline = pipeline;
      return [{ _id: "+233555000001", names: ["Gabriel"] }];
    };
    Order.countDocuments = async () => 0;
    Order.find = () => orderQuery([]);

    await listStaffOrders({
      restaurantId,
      senderPhone,
      senderRole: "owner",
      originalMessage: "Show Gabriel's orders today",
      timezone: "Africa/Accra",
      period: "today",
      customerName: "Gabriel",
      now: new Date("2026-10-01T12:00:00.000Z")
    });

    const match = aggregationPipeline[0].$match;
    assert.equal(match.restaurantId instanceof Types.ObjectId, true);
    assert.equal(String(match.restaurantId), restaurantId);
    assert.deepEqual(match.customerName, {
      $regex: "^Gabriel$",
      $options: "i"
    });
  } finally {
    restore(
      StaffOrderQueryContext,
      "findOneAndUpdate",
      originals.contextFindOneAndUpdate
    );
    restore(Order, "aggregate", originals.aggregate);
    restore(Order, "countDocuments", originals.countDocuments);
    restore(Order, "find", originals.find);
  }
});

test("customer-name aggregation rejects an invalid restaurant identifier", async () => {
  const originalAggregate = Order.aggregate;
  let aggregationCalled = false;
  try {
    Order.aggregate = async () => {
      aggregationCalled = true;
      return [];
    };

    await assert.rejects(
      () =>
        listStaffOrders({
          restaurantId: "not-an-object-id",
          senderPhone,
          senderRole: "owner",
          originalMessage: "Show Gabriel's orders today",
          timezone: "Africa/Accra",
          period: "today",
          customerName: "Gabriel",
          now: new Date("2026-10-01T12:00:00.000Z")
        }),
      /Invalid restaurantId/
    );
    assert.equal(aggregationCalled, false);
  } finally {
    restore(Order, "aggregate", originalAggregate);
  }
});

test("pagination offset reliably retains period, status, customer, and staff scope", async () => {
  const originals = {
    contextFindOne: StaffOrderQueryContext.findOne,
    contextFindOneAndUpdate: StaffOrderQueryContext.findOneAndUpdate,
    exists: Order.exists,
    countDocuments: Order.countDocuments,
    find: Order.find
  };
  const periodStart = new Date("2026-09-01T00:00:00.000Z");
  const periodEnd = new Date("2026-10-01T00:00:00.000Z");
  const now = new Date("2026-10-01T12:00:00.000Z");
  const queryState = {};
  let orderFilter;
  try {
    StaffOrderQueryContext.findOne = async (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      assert.equal(filter.senderPhone, senderPhone);
      assert.equal(filter.senderRole, "owner");
      assert.equal(filter.expiresAt.$gt, now);
      return {
        periodType: "custom",
        periodLabel: "Since September 1",
        periodStart,
        periodEnd,
        timezone: "Africa/Accra",
        status: "completed",
        customerName: "Gabriel",
        customerPhone: "+233555000001"
      };
    };
    StaffOrderQueryContext.findOneAndUpdate = async () => {};
    Order.exists = async (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      assert.equal(filter.customerPhone, "+233555000001");
      return { _id: new Types.ObjectId() };
    };
    Order.countDocuments = async (filter) => {
      orderFilter = filter;
      return 20;
    };
    Order.find = (filter) => {
      orderFilter = filter;
      return orderQuery([], queryState);
    };

    const result = await listStaffOrders({
      restaurantId,
      senderPhone,
      senderRole: "owner",
      originalMessage: "Page two please",
      timezone: "Africa/Accra",
      offset: 10,
      limit: 10,
      now
    });

    assert.deepEqual(orderFilter.createdAt, {
      $gte: periodStart,
      $lt: periodEnd
    });
    assert.equal(orderFilter.status, "completed");
    assert.equal(orderFilter.customerPhone, "+233555000001");
    assert.equal(queryState.offset, 10);
    assert.equal(queryState.limit, 10);
    assert.equal(result.period.retained, true);
  } finally {
    restore(StaffOrderQueryContext, "findOne", originals.contextFindOne);
    restore(
      StaffOrderQueryContext,
      "findOneAndUpdate",
      originals.contextFindOneAndUpdate
    );
    restore(Order, "exists", originals.exists);
    restore(Order, "countDocuments", originals.countDocuments);
    restore(Order, "find", originals.find);
  }
});

test("natural pagination phrases reuse valid retained context without an offset", async () => {
  const originals = {
    contextFindOne: StaffOrderQueryContext.findOne,
    contextFindOneAndUpdate: StaffOrderQueryContext.findOneAndUpdate,
    countDocuments: Order.countDocuments,
    find: Order.find
  };
  let contextReads = 0;
  try {
    StaffOrderQueryContext.findOne = async () => {
      contextReads += 1;
      return {
        periodType: "custom",
        periodLabel: "September",
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        periodEnd: new Date("2026-10-01T00:00:00.000Z"),
        timezone: "Africa/Accra"
      };
    };
    StaffOrderQueryContext.findOneAndUpdate = async () => {};
    Order.countDocuments = async () => 0;
    Order.find = () => orderQuery([]);

    for (const originalMessage of [
      "Show the remaining records.",
      "Next page.",
      "Show more.",
      "Continue."
    ]) {
      const result = await listStaffOrders({
        restaurantId,
        senderPhone,
        senderRole: "owner",
        originalMessage,
        timezone: "Africa/Accra"
      });
      assert.equal(result.period.retained, true);
    }

    assert.equal(contextReads, 4);
  } finally {
    restore(StaffOrderQueryContext, "findOne", originals.contextFindOne);
    restore(
      StaffOrderQueryContext,
      "findOneAndUpdate",
      originals.contextFindOneAndUpdate
    );
    restore(Order, "countDocuments", originals.countDocuments);
    restore(Order, "find", originals.find);
  }
});

test("pagination applies explicit period, status, and customer overrides", async () => {
  const originals = {
    contextFindOne: StaffOrderQueryContext.findOne,
    contextFindOneAndUpdate: StaffOrderQueryContext.findOneAndUpdate,
    aggregate: Order.aggregate,
    countDocuments: Order.countDocuments,
    find: Order.find
  };
  let orderFilter;
  try {
    StaffOrderQueryContext.findOne = async () => ({
      periodType: "custom",
      periodLabel: "September",
      periodStart: new Date("2026-09-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      timezone: "Africa/Accra",
      status: "rejected",
      customerName: "Gabriel",
      customerPhone: "+233555000001"
    });
    StaffOrderQueryContext.findOneAndUpdate = async () => {};
    Order.aggregate = async (pipeline) => {
      assert.equal(pipeline[0].$match.restaurantId instanceof Types.ObjectId, true);
      return [{ _id: "+233555000002", names: ["Lady Ruth"] }];
    };
    Order.countDocuments = async (filter) => {
      orderFilter = filter;
      return 0;
    };
    Order.find = (filter) => {
      orderFilter = filter;
      return orderQuery([]);
    };

    const result = await listStaffOrders({
      restaurantId,
      senderPhone,
      senderRole: "owner",
      originalMessage: "Next page, but show Lady Ruth's completed orders today.",
      timezone: "Africa/Accra",
      offset: 10,
      period: "today",
      status: "completed",
      customerName: "Lady Ruth",
      now: new Date("2026-10-01T12:00:00.000Z")
    });

    assert.equal(
      orderFilter.createdAt.$gte.toISOString(),
      "2026-10-01T00:00:00.000Z"
    );
    assert.equal(
      orderFilter.createdAt.$lt.toISOString(),
      "2026-10-01T12:00:00.000Z"
    );
    assert.equal(orderFilter.status, "completed");
    assert.equal(orderFilter.customerPhone, "+233555000002");
    assert.equal(result.period.type, "today");
    assert.equal(result.period.retained, false);
  } finally {
    restore(StaffOrderQueryContext, "findOne", originals.contextFindOne);
    restore(
      StaffOrderQueryContext,
      "findOneAndUpdate",
      originals.contextFindOneAndUpdate
    );
    restore(Order, "aggregate", originals.aggregate);
    restore(Order, "countDocuments", originals.countDocuments);
    restore(Order, "find", originals.find);
  }
});

test("expired pagination context is not reused and lookup remains staff and tenant scoped", async () => {
  const originals = {
    contextFindOne: StaffOrderQueryContext.findOne,
    contextFindOneAndUpdate: StaffOrderQueryContext.findOneAndUpdate,
    countDocuments: Order.countDocuments,
    find: Order.find
  };
  const otherRestaurantId = "64b000000000000000000002";
  const otherSenderPhone = "+233500000002";
  const now = new Date("2026-10-01T12:00:00.000Z");
  const lookups = [];
  const orderFilters = [];
  try {
    StaffOrderQueryContext.findOne = async (filter) => {
      lookups.push(filter);
      return null;
    };
    StaffOrderQueryContext.findOneAndUpdate = async () => {};
    Order.countDocuments = async (filter) => {
      orderFilters.push(filter);
      return 0;
    };
    Order.find = (filter) => {
      orderFilters.push(filter);
      return orderQuery([]);
    };

    for (const request of [
      { restaurantId, senderPhone, senderRole: "owner" },
      { restaurantId, senderPhone: otherSenderPhone, senderRole: "manager" },
      { restaurantId: otherRestaurantId, senderPhone, senderRole: "owner" }
    ]) {
      const result = await listStaffOrders({
        ...request,
        originalMessage: "Next page.",
        timezone: "Africa/Accra",
        offset: 10,
        period: "today",
        now
      });
      assert.equal(result.period.retained, false);
      assert.equal(result.filters.status, undefined);
      assert.equal(result.filters.customerName, undefined);
      assert.equal(result.filters.customerPhone, undefined);
    }

    assert.deepEqual(
      lookups.map((filter) => ({
        restaurantId: filter.restaurantId,
        senderPhone: filter.senderPhone,
        senderRole: filter.senderRole,
        expiresAfter: filter.expiresAt.$gt
      })),
      [
        { restaurantId, senderPhone, senderRole: "owner", expiresAfter: now },
        {
          restaurantId,
          senderPhone: otherSenderPhone,
          senderRole: "manager",
          expiresAfter: now
        },
        {
          restaurantId: otherRestaurantId,
          senderPhone,
          senderRole: "owner",
          expiresAfter: now
        }
      ]
    );
    assert.equal(
      orderFilters.every((filter) => !filter.status && !filter.customerPhone),
      true
    );
  } finally {
    restore(StaffOrderQueryContext, "findOne", originals.contextFindOne);
    restore(
      StaffOrderQueryContext,
      "findOneAndUpdate",
      originals.contextFindOneAndUpdate
    );
    restore(Order, "countDocuments", originals.countDocuments);
    restore(Order, "find", originals.find);
  }
});

test("an explicit new order period does not reuse the prior retained period", async () => {
  const originals = {
    contextFindOne: StaffOrderQueryContext.findOne,
    contextFindOneAndUpdate: StaffOrderQueryContext.findOneAndUpdate,
    countDocuments: Order.countDocuments,
    find: Order.find
  };
  let retainedReads = 0;
  let orderFilter;
  try {
    StaffOrderQueryContext.findOne = async () => {
      retainedReads += 1;
      return null;
    };
    StaffOrderQueryContext.findOneAndUpdate = async () => {};
    Order.countDocuments = async (filter) => {
      orderFilter = filter;
      return 0;
    };
    Order.find = (filter) => {
      orderFilter = filter;
      return orderQuery([]);
    };

    await listStaffOrders({
      restaurantId,
      senderPhone,
      senderRole: "owner",
      originalMessage: "What about today?",
      timezone: "Africa/Accra",
      period: "today",
      now: new Date("2026-10-01T12:00:00.000Z")
    });

    assert.equal(retainedReads, 0);
    assert.equal(
      orderFilter.createdAt.$gte.toISOString(),
      "2026-10-01T00:00:00.000Z"
    );
    assert.equal(
      orderFilter.createdAt.$lt.toISOString(),
      "2026-10-01T12:00:00.000Z"
    );
  } finally {
    restore(StaffOrderQueryContext, "findOne", originals.contextFindOne);
    restore(
      StaffOrderQueryContext,
      "findOneAndUpdate",
      originals.contextFindOneAndUpdate
    );
    restore(Order, "countDocuments", originals.countDocuments);
    restore(Order, "find", originals.find);
  }
});

test("an explicit customer name clears a conflicting retained customer phone", async () => {
  const originals = {
    contextFindOne: StaffOrderQueryContext.findOne,
    contextFindOneAndUpdate: StaffOrderQueryContext.findOneAndUpdate,
    aggregate: Order.aggregate,
    countDocuments: Order.countDocuments,
    find: Order.find
  };
  let orderFilter;
  try {
    StaffOrderQueryContext.findOne = async () => ({
      periodType: "all_time",
      periodLabel: "All time",
      periodStart: new Date("2026-01-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      timezone: "Africa/Accra",
      customerName: "Gabriel",
      customerPhone: "+233555000001"
    });
    StaffOrderQueryContext.findOneAndUpdate = async () => {};
    Order.aggregate = async () => [
      { _id: "+233555000002", names: ["Lady Ruth"] }
    ];
    Order.countDocuments = async (filter) => {
      orderFilter = filter;
      return 0;
    };
    Order.find = (filter) => {
      orderFilter = filter;
      return orderQuery([]);
    };

    await listStaffOrders({
      restaurantId,
      senderPhone,
      senderRole: "owner",
      originalMessage: "What about Lady Ruth's orders?",
      timezone: "Africa/Accra",
      customerName: "Lady Ruth",
      now: new Date("2026-10-01T12:00:00.000Z")
    });

    assert.equal(orderFilter.customerPhone, "+233555000002");
    assert.notEqual(orderFilter.customerPhone, "+233555000001");
  } finally {
    restore(StaffOrderQueryContext, "findOne", originals.contextFindOne);
    restore(
      StaffOrderQueryContext,
      "findOneAndUpdate",
      originals.contextFindOneAndUpdate
    );
    restore(Order, "aggregate", originals.aggregate);
    restore(Order, "countDocuments", originals.countDocuments);
    restore(Order, "find", originals.find);
  }
});

test("busiest facts include calendar-date ties and weekday totals for custom periods", () => {
  const summary = buildOwnerSummaryMetrics(
    {
      restaurantId,
      periodStart: new Date("2026-09-01T00:00:00.000Z"),
      periodEnd: new Date("2026-09-15T00:00:00.000Z"),
      timezone: "Africa/Accra",
      periodType: "custom"
    },
    [
      new Date("2026-09-01T09:00:00.000Z"),
      new Date("2026-09-01T10:00:00.000Z"),
      new Date("2026-09-08T11:00:00.000Z"),
      new Date("2026-09-08T12:00:00.000Z"),
      new Date("2026-09-09T12:00:00.000Z")
    ].map((createdAt, index) => ({
      status: "completed",
      total: 1000000 + index,
      customerPhone: `+23350000000${index}`,
      items: [],
      createdAt
    })),
    []
  );

  assert.deepEqual(
    summary.busiestDates.map((entry) => entry.date),
    ["2026-09-01", "2026-09-08"]
  );
  assert.equal(summary.busiestWeekdays.length, 1);
  assert.equal(summary.busiestWeekdays[0].day, "tuesday");
  assert.equal(summary.busiestWeekdays[0].totalOrders, 4);
  assert.equal(summary.busiestWeekdays[0].occurrences, 2);
  assert.equal(summary.busiestWeekdays[0].averageOrdersPerOccurrence, 2);
});

test("busiest facts return empty arrays for an empty period", () => {
  const summary = buildOwnerSummaryMetrics(
    {
      restaurantId,
      periodStart: new Date("2026-09-01T00:00:00.000Z"),
      periodEnd: new Date("2026-09-08T00:00:00.000Z"),
      timezone: "Africa/Accra",
      periodType: "custom"
    },
    [],
    []
  );
  assert.equal(summary.busiestDay, null);
  assert.deepEqual(summary.busiestDates, []);
  assert.deepEqual(summary.busiestWeekdays, []);
});

test("deterministic final answer lists exact order references and placement times", async () => {
  const message = await runGroundedOrderAnswer(
    "What time and date did they make the orders?",
    baseOrderListData({
      totalMatched: 2,
      returnedCount: 2,
      orders: [
        {
          orderReference: "ORD-101",
          customerName: "Gabriel",
          customerPhone: "+233555000001",
          placedAtFormatted: "6 September 2026 at 9:53 a.m."
        },
        {
          orderReference: "ORD-102",
          customerName: "Gabriel",
          customerPhone: "+233555000001",
          placedAtFormatted: "20 September 2026 at 6:15 p.m."
        }
      ]
    })
  );

  assert.equal(
    message,
    "Gabriel placed both orders:\n1. ORD-101 — 6 September 2026 at 9:53 a.m.\n2. ORD-102 — 20 September 2026 at 6:15 p.m."
  );
});

test("truncated order page describes only returned records", async () => {
  const orders = Array.from({ length: 10 }, (_, index) => ({
    orderReference: `ORD-${String(index + 1).padStart(3, "0")}`,
    customerName: "Gabriel",
    customerPhone: "+233555000001",
    placedAtFormatted: `${index + 1} September 2026 at 9:00 a.m.`
  }));
  const message = await runGroundedOrderAnswer(
    "What time and date were the orders placed?",
    baseOrderListData({
      totalMatched: 20,
      returnedCount: 10,
      truncated: true,
      nextOffset: 10,
      orders
    })
  );

  assert.match(message, /^Showing 10 of 20 matching orders\./);
  assert.match(message, /1\. ORD-001 — 1 September 2026 at 9:00 a\.m\. — Gabriel/);
  assert.match(message, /10\. ORD-010 — 10 September 2026 at 9:00 a\.m\. — Gabriel/);
  assert.match(message, /Ask to see the next page for more matching orders\.$/);
  assert.doesNotMatch(message, /Gabriel placed 20 orders/);
  assert.doesNotMatch(message, /offset/i);
});

test("complete order result attributes the full count to one established customer", async () => {
  const message = await runGroundedOrderAnswer(
    "When did they place the orders?",
    baseOrderListData({
      totalMatched: 3,
      returnedCount: 3,
      orders: [1, 2, 3].map((number) => ({
        orderReference: `ORD-20${number}`,
        customerName: "Lady Ruth",
        customerPhone: "+233555000009",
        placedAtFormatted: `${number} October 2026 at 1:00 p.m.`
      }))
    })
  );

  assert.match(message, /^Lady Ruth placed 3 orders:/);
});

test("same display name with distinct identities is not merged", async () => {
  const message = await runGroundedOrderAnswer(
    "Who placed the orders?",
    baseOrderListData({
      totalMatched: 2,
      returnedCount: 2,
      orders: [
        {
          orderReference: "ORD-301",
          customerName: "Gabriel",
          customerPhone: "+233555000001",
          placedAtFormatted: "1 October 2026 at 9:00 a.m."
        },
        {
          orderReference: "ORD-302",
          customerName: "Gabriel",
          customerPhone: "+233555000002",
          placedAtFormatted: "1 October 2026 at 10:00 a.m."
        }
      ]
    })
  );

  assert.match(message, /^2 customers placed the 2 matching orders:/);
  assert.match(message, /Gabriel \(phone ending 0001\) — 1 order/);
  assert.match(message, /Gabriel \(phone ending 0002\) — 1 order/);
  assert.doesNotMatch(message, /Gabriel placed both orders/);
});

test("later final page remains partial and does not expose offset details", async () => {
  const message = await runGroundedOrderAnswer(
    "Show the remaining records.",
    baseOrderListData({
      totalMatched: 4,
      returnedCount: 2,
      truncated: false,
      nextOffset: null,
      orders: [
        {
          orderReference: "ORD-403",
          customerName: "Lady Ruth",
          customerPhone: "+233555000009",
          placedAtFormatted: "3 October 2026 at 1:00 p.m."
        },
        {
          orderReference: "ORD-404",
          customerName: "Lady Ruth",
          customerPhone: "+233555000009",
          placedAtFormatted: "4 October 2026 at 1:00 p.m."
        }
      ]
    })
  );

  assert.match(message, /^Showing 2 of 4 matching orders\./);
  assert.doesNotMatch(message, /Lady Ruth placed 4 orders/);
  assert.doesNotMatch(message, /next page|offset/i);
});

test("empty order results distinguish no matches from no more page records", async () => {
  const noMatches = await runGroundedOrderAnswer(
    "When were the orders placed?",
    baseOrderListData({ period: { label: "Today", timezone: "Africa/Accra" } })
  );
  const noMoreRecords = await runGroundedOrderAnswer(
    "When were the remaining orders placed?",
    baseOrderListData({
      totalMatched: 4,
      returnedCount: 0
    })
  );

  assert.equal(noMatches, "No orders matched today.");
  assert.equal(
    noMoreRecords,
    "There are no more matching orders to show for since september 1."
  );
});
