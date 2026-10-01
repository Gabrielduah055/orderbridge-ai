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

const orderQuery = (orders) => ({
  sort() {
    return this;
  },
  skip() {
    return this;
  },
  limit() {
    return Promise.resolve(orders);
  }
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
      message: "What time and date did they make the orders?"
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
        message: "2 orders matched.",
        data: {
          period: {
            type: "custom",
            label: "Since September 1",
            timezone: "Africa/Accra"
          },
          totalMatched: 2,
          returnedCount: 2,
          truncated: false,
          nextOffset: null,
          orders: [
            {
              orderReference: "ORD-101",
              customerName: "Gabriel",
              placedAtFormatted: "6 September 2026 at 9:53 a.m."
            },
            {
              orderReference: "ORD-102",
              customerName: "Gabriel",
              placedAtFormatted: "20 September 2026 at 6:15 p.m."
            }
          ]
        }
      })
    }
  );

  assert.equal(
    result.message,
    "Gabriel placed both orders:\n1. ORD-101 — 6 September 2026 at 9:53 a.m.\n2. ORD-102 — 20 September 2026 at 6:15 p.m."
  );
});
