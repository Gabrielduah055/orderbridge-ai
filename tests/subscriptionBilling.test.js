const assert = require("node:assert/strict");
const test = require("node:test");

const {
  addCalendarMonthClamped,
  isRenewalDue,
  recordSubscriptionPayment,
  runSubscriptionBillingReconciliation
} = require("../dist/services/subscriptionBilling.service");

const restaurantId = "64b000000000000000000b01";

const makeRestaurant = (overrides = {}) => ({
  _id: restaurantId,
  status: "active",
  billingStatus: "past_due",
  subscriptionAmount: 1000,
  subscriptionRenewalDate: new Date("2026-08-17T00:00:00.000Z"),
  async save() {
    return this;
  },
  ...overrides
});

test("calendar-month renewal keeps the day when it exists", () => {
  assert.equal(
    addCalendarMonthClamped(new Date("2026-08-17T14:30:00.000Z")).toISOString(),
    "2026-09-17T00:00:00.000Z"
  );
});

test("calendar-month renewal clamps to the last valid day", () => {
  assert.equal(
    addCalendarMonthClamped(new Date("2026-01-31T14:30:00.000Z")).toISOString(),
    "2026-02-28T00:00:00.000Z"
  );
  assert.equal(
    addCalendarMonthClamped(new Date("2028-01-31T14:30:00.000Z")).toISOString(),
    "2028-02-29T00:00:00.000Z"
  );
});

test("manual payment records the payment time, activates billing, and renews monthly", async () => {
  const now = new Date("2026-08-17T14:30:00.000Z");
  const restaurant = makeRestaurant({ status: "paused" });

  const updated = await recordSubscriptionPayment(
    restaurantId,
    {},
    now,
    { loadRestaurant: async () => restaurant }
  );

  assert.equal(updated.billingStatus, "active");
  assert.equal(updated.subscriptionLastPaidAt.toISOString(), now.toISOString());
  assert.equal(
    updated.subscriptionRenewalDate.toISOString(),
    "2026-09-17T00:00:00.000Z"
  );
  assert.equal(updated.status, "paused");
});

test("manual payment requires a configured positive monthly amount", async () => {
  for (const subscriptionAmount of [undefined, 0]) {
    await assert.rejects(
      () =>
        recordSubscriptionPayment(
          restaurantId,
          {},
          new Date("2026-08-17T14:30:00.000Z"),
          {
            loadRestaurant: async () =>
              makeRestaurant({ subscriptionAmount })
          }
        ),
      /Configure the monthly subscription amount before recording payment\./
    );
  }
});

test("renewal is due on the calendar renewal date without time-of-day drift", () => {
  assert.equal(
    isRenewalDue(
      new Date("2026-08-17T23:59:59.000Z"),
      new Date("2026-08-17T00:00:01.000Z")
    ),
    true
  );
});

test("reconciliation marks only due active billing as past due", async () => {
  const due = makeRestaurant({
    _id: "due",
    status: "paused",
    billingStatus: "active",
    subscriptionRenewalDate: new Date("2026-08-17T23:59:59.000Z")
  });
  const future = makeRestaurant({
    _id: "future",
    billingStatus: "active",
    subscriptionRenewalDate: new Date("2026-08-18T00:00:00.000Z")
  });
  const cancelled = makeRestaurant({
    _id: "cancelled",
    billingStatus: "cancelled",
    subscriptionRenewalDate: new Date("2026-08-01T00:00:00.000Z")
  });
  const marked = [];

  const result = await runSubscriptionBillingReconciliation(
    new Date("2026-08-17T09:00:00.000Z"),
    {
      loadRestaurants: async () => [due, future, cancelled],
      markPastDue: async (restaurant) => {
        marked.push(restaurant._id);
        restaurant.billingStatus = "past_due";
        return true;
      }
    }
  );

  assert.deepEqual(marked, ["due"]);
  assert.equal(result.restaurantsChecked, 3);
  assert.equal(result.markedPastDue, 1);
  assert.equal(due.billingStatus, "past_due");
  assert.equal(due.status, "paused");
  assert.equal(future.billingStatus, "active");
  assert.equal(cancelled.billingStatus, "cancelled");
});
