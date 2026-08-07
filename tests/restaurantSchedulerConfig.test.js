const assert = require("node:assert/strict");
const test = require("node:test");

const {
  backfillRestaurantSchedulerConfig,
  restaurantSchedulerConfigDefaults
} = require("../dist/scripts/backfillRestaurantSchedulerConfig");
const {
  parseRestaurantTokenSelector,
  setRestaurantWasenderToken
} = require("../dist/scripts/setRestaurantWasenderToken");
const { Restaurant } = require("../dist/models/Restaurant");
const {
  loadEligibleOwnerSummaryRestaurants,
  runOwnerSummarySchedulerPass
} = require("../dist/services/ownerSummaryScheduler.service");

const makeBackfillHarness = (restaurants) => {
  const writes = [];

  return {
    writes,
    dependencies: {
      loadRestaurants: async () => restaurants,
      setFieldIfMissing: async (restaurantId, field, value) => {
        writes.push({ restaurantId: String(restaurantId), field, value });
        const restaurant = restaurants.find(
          (candidate) => String(candidate._id) === String(restaurantId)
        );

        if (!restaurant || Object.prototype.hasOwnProperty.call(restaurant, field)) {
          return false;
        }

        restaurant[field] = value;
        return true;
      },
      log: () => undefined
    }
  };
};

test("missing restaurant scheduler fields are backfilled with requested defaults", async () => {
  const restaurant = {
    _id: "64b000000000000000000c01",
    name: "Legacy Restaurant"
  };
  const harness = makeBackfillHarness([restaurant]);
  const result = await backfillRestaurantSchedulerConfig(
    true,
    harness.dependencies
  );

  assert.deepEqual(
    Object.fromEntries(
      Object.keys(restaurantSchedulerConfigDefaults).map((field) => [
        field,
        restaurant[field]
      ])
    ),
    restaurantSchedulerConfigDefaults
  );
  assert.deepEqual(result, {
    restaurantsChecked: 1,
    restaurantsNeedingUpdate: 1,
    restaurantsUpdated: 1
  });
});

test("backfill preserves explicit false values and configured times", async () => {
  const restaurant = {
    _id: "64b000000000000000000c02",
    name: "Configured Restaurant",
    followUpEnabled: false,
    ownerDailySummaryEnabled: false,
    ownerWeeklySummaryEnabled: false,
    postDeliveryFollowUpEnabled: false,
    ownerDailySummaryTime: "17:30",
    ownerWeeklySummaryTime: "19:45"
  };
  const harness = makeBackfillHarness([restaurant]);

  await backfillRestaurantSchedulerConfig(true, harness.dependencies);

  assert.equal(restaurant.followUpEnabled, false);
  assert.equal(restaurant.ownerDailySummaryEnabled, false);
  assert.equal(restaurant.ownerWeeklySummaryEnabled, false);
  assert.equal(restaurant.postDeliveryFollowUpEnabled, false);
  assert.equal(restaurant.ownerDailySummaryTime, "17:30");
  assert.equal(restaurant.ownerWeeklySummaryTime, "19:45");
  assert.equal(
    harness.writes.some(({ field }) => field === "ownerDailySummaryTime"),
    false
  );
  assert.equal(
    harness.writes.some(({ field }) => field === "ownerWeeklySummaryTime"),
    false
  );
});

test("restaurant config backfill is dry-run by default and performs no writes", async () => {
  const restaurant = {
    _id: "64b000000000000000000c03",
    name: "Dry Run Restaurant"
  };
  const harness = makeBackfillHarness([restaurant]);
  const result = await backfillRestaurantSchedulerConfig(
    undefined,
    harness.dependencies
  );

  assert.equal(harness.writes.length, 0);
  assert.equal(Object.hasOwn(restaurant, "timezone"), false);
  assert.deepEqual(result, {
    restaurantsChecked: 1,
    restaurantsNeedingUpdate: 1,
    restaurantsUpdated: 0
  });
});

test("--apply behavior writes every missing field and skips complete records", async () => {
  const legacy = {
    _id: "64b000000000000000000c04",
    name: "Legacy"
  };
  const complete = {
    _id: "64b000000000000000000c05",
    name: "Complete",
    ...restaurantSchedulerConfigDefaults
  };
  const harness = makeBackfillHarness([legacy, complete]);
  const result = await backfillRestaurantSchedulerConfig(
    true,
    harness.dependencies
  );

  assert.equal(
    harness.writes.length,
    Object.keys(restaurantSchedulerConfigDefaults).length
  );
  assert.equal(
    harness.writes.every(({ restaurantId }) => restaurantId === legacy._id),
    true
  );
  assert.deepEqual(result, {
    restaurantsChecked: 2,
    restaurantsNeedingUpdate: 1,
    restaurantsUpdated: 1
  });
});

test("owner summary eligibility query treats missing enabled fields as enabled", async () => {
  const originalFind = Restaurant.find;
  let capturedFilter;

  try {
    Restaurant.find = (filter) => {
      capturedFilter = filter;
      return {
        select: async () => []
      };
    };

    await loadEligibleOwnerSummaryRestaurants();
  } finally {
    Restaurant.find = originalFind;
  }

  assert.deepEqual(capturedFilter.$or, [
    { ownerDailySummaryEnabled: { $ne: false } },
    { ownerWeeklySummaryEnabled: { $ne: false } }
  ]);
  assert.deepEqual(capturedFilter.wasenderApiToken, {
    $exists: true,
    $ne: ""
  });
});

test("old restaurants with missing summary flags are enabled while explicit false stays disabled", async () => {
  const legacyRestaurant = {
    _id: "64b000000000000000000c06",
    name: "Old Restaurant",
    ownerPhone: "0557038547",
    wasenderSessionId: "old-session",
    wasenderApiToken: "old-token",
    timezone: "Africa/Accra",
    ownerDailySummaryTime: "08:00",
    ownerWeeklySummaryDay: "monday",
    ownerWeeklySummaryTime: "08:00"
  };
  const disabledRestaurant = {
    ...legacyRestaurant,
    _id: "64b000000000000000000c07",
    name: "Disabled Restaurant",
    ownerDailySummaryEnabled: false,
    ownerWeeklySummaryEnabled: false
  };
  const queued = [];
  const result = await runOwnerSummarySchedulerPass(
    new Date("2026-08-05T09:00:00.000Z"),
    {
      loadRestaurants: async () => [legacyRestaurant, disabledRestaurant],
      summaryExists: async () => false,
      getMetrics: async (input) => ({
        restaurantId: input.restaurantId,
        periodType: input.periodType,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        timezone: input.timezone,
        totalOrders: 0,
        countsByStatus: { rejected: 0 },
        completedOrders: 0,
        cancelledOrders: 0,
        completedRevenue: 0,
        averageCompletedOrderValue: 0,
        topSellingItems: [],
        uniqueCustomers: 0,
        newCustomers: 0,
        returningCustomers: 0,
        busiestDay: null
      }),
      enqueueMessage: async (input) => {
        queued.push(input);
        return { _id: "queue-old-restaurant" };
      }
    }
  );

  assert.equal(result.summariesQueued, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].restaurantId, legacyRestaurant._id);
});

test("setting a restaurant token updates only the target and never logs the token", async () => {
  const secretToken = "restaurant-secret-token";
  const restaurants = [
    {
      _id: "64b000000000000000000c08",
      name: "Golden Grill",
      slug: "golden-grill",
      wasenderSessionId: "golden-session",
      wasenderApiToken: "old-golden-token"
    },
    {
      _id: "64b000000000000000000c09",
      name: "Another Restaurant",
      slug: "another-restaurant",
      wasenderSessionId: "another-session",
      wasenderApiToken: "another-token"
    }
  ];
  const logs = [];
  const updates = [];

  await setRestaurantWasenderToken(
    { slug: "golden-grill" },
    secretToken,
    {
      findRestaurants: async ({ slug }) =>
        restaurants.filter((restaurant) => restaurant.slug === slug),
      updateToken: async (restaurantId, token) => {
        updates.push({ restaurantId: String(restaurantId), token });
        const restaurant = restaurants.find(
          (candidate) => String(candidate._id) === String(restaurantId)
        );
        restaurant.wasenderApiToken = token;
        return true;
      },
      log: (message) => logs.push(message)
    }
  );

  assert.equal(restaurants[0].wasenderApiToken, secretToken);
  assert.equal(restaurants[1].wasenderApiToken, "another-token");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].restaurantId, restaurants[0]._id);
  assert.equal(logs.join("\n").includes(secretToken), false);
  assert.match(logs[0], /Golden Grill/);
});

test("restaurant token selector supports an exact restaurant ID", () => {
  assert.deepEqual(
    parseRestaurantTokenSelector([
      "--restaurant-id",
      "64b000000000000000000c08"
    ]),
    { restaurantId: "64b000000000000000000c08" }
  );
});
