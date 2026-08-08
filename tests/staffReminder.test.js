const assert = require("node:assert/strict");
const test = require("node:test");

const { OutboundMessage } = require("../dist/models/outboundMessage.model");
const { Restaurant } = require("../dist/models/Restaurant");
const {
  cancelStaffReminder,
  createStaffReminder,
  createStaffReminderSchema,
  listStaffReminders,
  rescheduleStaffReminder
} = require("../dist/services/staffReminder.service");
const wasenderQueue = require("../dist/services/wasenderQueue.service");
const {
  getQueuedStaffReminderStaleReason,
  isQueuedConversationalMessageStale,
  isTransactionalQueuedMessage,
  processNextQueuedWasenderMessage
} = wasenderQueue;
const {
  isToolAllowedForRole
} = require("../dist/agent-tools/tool.permissions");
const {
  getAgentToolDefinitionsForRole
} = require("../dist/services/ai/agentToolDefinitions.service");

const restaurantId = "64b000000000000000000e01";
const otherRestaurantId = "64b000000000000000000e02";
const reminderId = "64b000000000000000000e11";
const ownerPhone = "+233507879374";
const managerPhone = "+233241234567";
const otherManagerPhone = "+233241234568";
const now = new Date("2026-08-08T12:00:00.000Z");

const makeRestaurant = (overrides = {}) => ({
  _id: restaurantId,
  name: "Reminder Restaurant",
  ownerName: "Owner",
  ownerPhone,
  managerPhones: [managerPhone, otherManagerPhone],
  managerContacts: [],
  status: "active",
  timezone: "Africa/Accra",
  wasenderSessionId: "staff-session",
  wasenderApiToken: "staff-secret-token",
  ...overrides
});

const resolvedQuery = (value) => ({
  select() {
    return Promise.resolve(value);
  }
});

const makeReminder = (overrides = {}) => ({
  _id: reminderId,
  restaurantId,
  sessionId: "staff-session",
  to: ownerPhone,
  type: "text",
  text: "Reminder from OrderBridge:\n\nCheck stock.",
  status: "pending",
  attempts: 0,
  maxAttempts: 5,
  nextAttemptAt: new Date("2026-08-09T08:00:00.000Z"),
  metadata: {
    kind: "staff_reminder",
    restaurantId,
    createdByPhone: ownerPhone,
    createdByRole: "owner",
    recipientPhone: ownerPhone,
    recipientRole: "owner",
    reminderText: "Check stock",
    scheduledFor: "2026-08-09T08:00:00.000Z"
  },
  createdAt: now,
  ...overrides
});

const withRestaurant = async (restaurant, callback) => {
  const originalFindById = Restaurant.findById;
  Restaurant.findById = (id) => {
    assert.equal(String(id), restaurantId);
    return resolvedQuery(restaurant);
  };

  try {
    return await callback();
  } finally {
    Restaurant.findById = originalFindById;
  }
};

test("owner and manager reminder tools are permitted but customer tools are not", () => {
  for (const toolName of [
    "create_staff_reminder",
    "list_staff_reminders",
    "reschedule_staff_reminder",
    "cancel_staff_reminder"
  ]) {
    assert.equal(isToolAllowedForRole(toolName, "owner"), true);
    assert.equal(isToolAllowedForRole(toolName, "manager"), true);
    assert.equal(isToolAllowedForRole(toolName, "customer"), false);
  }
});

test("reminder tool schemas do not expose or accept identity and credential fields", () => {
  const definition = getAgentToolDefinitionsForRole("owner").find(
    (tool) => tool.function.name === "create_staff_reminder"
  );
  const properties = definition.function.parameters.properties;

  assert.deepEqual(Object.keys(properties).sort(), ["scheduledAt", "text"]);
  assert.equal(
    createStaffReminderSchema.safeParse({
      text: "Check stock",
      scheduledAt: "2026-08-09T08:00",
      restaurantId: otherRestaurantId,
      recipientPhone: otherManagerPhone,
      apiKey: "injected"
    }).success,
    false
  );
});

test("owner reminder uses backend sender, restaurant credentials, local timezone, and future queue time", async () => {
  const originalEnqueue = wasenderQueue.enqueueWasenderMessage;
  let enqueued;

  try {
    wasenderQueue.enqueueWasenderMessage = async (input) => {
      enqueued = input;
      return makeReminder({
        nextAttemptAt: input.nextAttemptAt,
        to: input.to,
        text: input.text,
        metadata: input.metadata,
        idempotencyKey: input.idempotencyKey
      });
    };

    const reminder = await withRestaurant(makeRestaurant(), () =>
      createStaffReminder(
        {
          restaurantId,
          senderPhone: ownerPhone,
          requestId: "inbound-owner-1",
          text: "Check stock",
          scheduledAt: "2026-08-09T08:00"
        },
        now
      )
    );

    assert.equal(enqueued.restaurantId, restaurantId);
    assert.equal(enqueued.to, ownerPhone);
    assert.equal(enqueued.sessionId, "staff-session");
    assert.equal(enqueued.apiKey, "staff-secret-token");
    assert.equal(enqueued.nextAttemptAt.toISOString(), "2026-08-09T08:00:00.000Z");
    assert.equal(enqueued.metadata.recipientPhone, ownerPhone);
    assert.equal(enqueued.metadata.recipientRole, "owner");
    assert.equal(enqueued.metadata.apiKey, undefined);
    assert.match(enqueued.idempotencyKey, /inbound-owner-1$/);
    assert.equal(reminder.text, "Check stock");
  } finally {
    wasenderQueue.enqueueWasenderMessage = originalEnqueue;
  }
});

test("manager reminder is scoped to that exact verified manager", async () => {
  const originalEnqueue = wasenderQueue.enqueueWasenderMessage;
  let enqueued;

  try {
    wasenderQueue.enqueueWasenderMessage = async (input) => {
      enqueued = input;
      return makeReminder({
        to: input.to,
        nextAttemptAt: input.nextAttemptAt,
        metadata: input.metadata
      });
    };

    await withRestaurant(makeRestaurant(), () =>
      createStaffReminder(
        {
          restaurantId,
          senderPhone: managerPhone,
          text: "Review deliveries",
          scheduledAt: "2026-08-09T09:00"
        },
        now
      )
    );

    assert.equal(enqueued.to, managerPhone);
    assert.equal(enqueued.metadata.createdByPhone, managerPhone);
    assert.equal(enqueued.metadata.recipientPhone, managerPhone);
    assert.equal(enqueued.metadata.recipientRole, "manager");
  } finally {
    wasenderQueue.enqueueWasenderMessage = originalEnqueue;
  }
});

test("past reminders are rejected before anything is queued", async () => {
  const originalEnqueue = wasenderQueue.enqueueWasenderMessage;
  let enqueueCount = 0;

  try {
    wasenderQueue.enqueueWasenderMessage = async () => {
      enqueueCount += 1;
    };

    await assert.rejects(
      withRestaurant(makeRestaurant(), () =>
        createStaffReminder(
          {
            restaurantId,
            senderPhone: ownerPhone,
            text: "Check stock",
            scheduledAt: "2026-08-08T11:59"
          },
          now
        )
      ),
      /future/i
    );
    assert.equal(enqueueCount, 0);
  } finally {
    wasenderQueue.enqueueWasenderMessage = originalEnqueue;
  }
});

test("listing reminders is tenant and current-sender scoped and returns safe fields", async () => {
  const originalFind = OutboundMessage.find;
  let capturedFilter;

  try {
    OutboundMessage.find = (filter) => {
      capturedFilter = filter;
      const query = {
        sort() {
          return query;
        },
        limit() {
          return Promise.resolve([
            makeReminder({ providerData: { secret: true }, apiKey: "hidden" })
          ]);
        }
      };
      return query;
    };

    const reminders = await withRestaurant(makeRestaurant(), () =>
      listStaffReminders({ restaurantId, senderPhone: ownerPhone })
    );

    assert.equal(capturedFilter.restaurantId, restaurantId);
    assert.equal(capturedFilter.to, ownerPhone);
    assert.equal(capturedFilter["metadata.createdByPhone"], ownerPhone);
    assert.deepEqual(Object.keys(reminders[0]).sort(), [
      "createdAt",
      "reminderId",
      "scheduledFor",
      "status",
      "text"
    ]);
  } finally {
    OutboundMessage.find = originalFind;
  }
});

test("rescheduling and cancelling use exact restaurant and sender scope", async () => {
  const originalFindOneAndUpdate = OutboundMessage.findOneAndUpdate;
  const calls = [];

  try {
    OutboundMessage.findOneAndUpdate = async (filter, update) => {
      calls.push({ filter, update });
      return makeReminder({
        status: update.$set.status ?? "pending",
        nextAttemptAt: update.$set.nextAttemptAt ?? makeReminder().nextAttemptAt,
        metadata: {
          ...makeReminder().metadata,
          scheduledFor:
            update.$set["metadata.scheduledFor"] ??
            makeReminder().metadata.scheduledFor
        }
      });
    };

    const rescheduled = await withRestaurant(makeRestaurant(), () =>
      rescheduleStaffReminder(
        {
          restaurantId,
          senderPhone: ownerPhone,
          reminderId,
          scheduledAt: "2026-08-10T10:30"
        },
        now
      )
    );
    const cancelled = await withRestaurant(makeRestaurant(), () =>
      cancelStaffReminder(
        { restaurantId, senderPhone: ownerPhone, reminderId },
        now
      )
    );

    assert.equal(rescheduled.scheduledFor.toISOString(), "2026-08-10T10:30:00.000Z");
    assert.equal(cancelled.status, "cancelled");
    for (const { filter } of calls) {
      assert.equal(filter.restaurantId, restaurantId);
      assert.equal(filter.to, ownerPhone);
      assert.equal(filter["metadata.recipientPhone"], ownerPhone);
      assert.equal(filter.status, "pending");
    }
  } finally {
    OutboundMessage.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("sent reminders cannot be rescheduled or cancelled and cancellation is idempotent", async () => {
  const originalFindOneAndUpdate = OutboundMessage.findOneAndUpdate;
  const originalFindOne = OutboundMessage.findOne;

  try {
    OutboundMessage.findOneAndUpdate = async () => null;
    OutboundMessage.findOne = async () => makeReminder({ status: "sent", sentAt: now });

    await assert.rejects(
      withRestaurant(makeRestaurant(), () =>
        rescheduleStaffReminder(
          {
            restaurantId,
            senderPhone: ownerPhone,
            reminderId,
            scheduledAt: "2026-08-10T10:30"
          },
          now
        )
      ),
      /already been sent/i
    );
    await assert.rejects(
      withRestaurant(makeRestaurant(), () =>
        cancelStaffReminder(
          { restaurantId, senderPhone: ownerPhone, reminderId },
          now
        )
      ),
      /already been sent/i
    );

    OutboundMessage.findOne = async () => makeReminder({ status: "cancelled" });
    const cancelled = await withRestaurant(makeRestaurant(), () =>
      cancelStaffReminder(
        { restaurantId, senderPhone: ownerPhone, reminderId },
        now
      )
    );
    assert.equal(cancelled.status, "cancelled");
  } finally {
    OutboundMessage.findOneAndUpdate = originalFindOneAndUpdate;
    OutboundMessage.findOne = originalFindOne;
  }
});

test("one manager cannot read or mutate another manager's reminders", async () => {
  const originalFind = OutboundMessage.find;
  const originalFindOneAndUpdate = OutboundMessage.findOneAndUpdate;
  const originalFindOne = OutboundMessage.findOne;
  let listFilter;

  try {
    OutboundMessage.find = (filter) => {
      listFilter = filter;
      const query = {
        sort() {
          return query;
        },
        limit() {
          return Promise.resolve([]);
        }
      };
      return query;
    };
    OutboundMessage.findOneAndUpdate = async () => null;
    OutboundMessage.findOne = async () => null;

    await withRestaurant(makeRestaurant(), () =>
      listStaffReminders({ restaurantId, senderPhone: managerPhone })
    );
    assert.equal(listFilter.to, managerPhone);
    assert.equal(listFilter["metadata.recipientPhone"], managerPhone);

    await assert.rejects(
      withRestaurant(makeRestaurant(), () =>
        cancelStaffReminder(
          { restaurantId, senderPhone: managerPhone, reminderId },
          now
        )
      ),
      /not found/i
    );
  } finally {
    OutboundMessage.find = originalFind;
    OutboundMessage.findOneAndUpdate = originalFindOneAndUpdate;
    OutboundMessage.findOne = originalFindOne;
  }
});

test("staff reminders are transactional and survive conversation-version changes", () => {
  assert.equal(isTransactionalQueuedMessage({ kind: "staff_reminder" }), true);
  assert.equal(
    isQueuedConversationalMessageStale(
      { kind: "staff_reminder", conversationVersion: 1 },
      { conversationVersion: 99, currentStep: "idle" }
    ),
    false
  );
});

test("send-time validation rejects removed managers and inactive restaurants", async () => {
  const originalFindOne = Restaurant.findOne;
  const metadata = {
    ...makeReminder({
      to: managerPhone,
      metadata: {
        ...makeReminder().metadata,
        createdByPhone: managerPhone,
        recipientPhone: managerPhone,
        createdByRole: "manager",
        recipientRole: "manager",
        scheduledFor: "2026-08-08T11:59:00.000Z"
      }
    }).metadata
  };

  try {
    Restaurant.findOne = () => resolvedQuery(makeRestaurant({ managerPhones: [] }));
    assert.equal(
      await getQueuedStaffReminderStaleReason(
        metadata,
        now,
        managerPhone,
        "staff-session",
        "staff-secret-token",
        restaurantId
      ),
      "staff_recipient_removed_or_changed"
    );

    Restaurant.findOne = () => resolvedQuery(null);
    assert.equal(
      await getQueuedStaffReminderStaleReason(
        metadata,
        now,
        managerPhone,
        "staff-session",
        "staff-secret-token",
        restaurantId
      ),
      "restaurant_inactive_or_missing"
    );
  } finally {
    Restaurant.findOne = originalFindOne;
  }
});

test("valid unchanged staff reminder passes send-time validation", async () => {
  const originalFindOne = Restaurant.findOne;
  const reminder = makeReminder({
    metadata: {
      ...makeReminder().metadata,
      scheduledFor: "2026-08-08T11:59:00.000Z"
    }
  });

  try {
    Restaurant.findOne = () => resolvedQuery(makeRestaurant());
    assert.equal(
      await getQueuedStaffReminderStaleReason(
        reminder.metadata,
        now,
        reminder.to,
        reminder.sessionId,
        "staff-secret-token",
        restaurantId
      ),
      null
    );
  } finally {
    Restaurant.findOne = originalFindOne;
  }
});

test("the queue cancels removed-manager and inactive-restaurant reminders before provider send", async () => {
  const originalOutboundFindOne = OutboundMessage.findOne;
  const originalOutboundFindOneAndUpdate = OutboundMessage.findOneAndUpdate;
  const originalRestaurantFindOne = Restaurant.findOne;
  const scenarios = [
    {
      restaurant: makeRestaurant({ managerPhones: [] }),
      expectedReason: "staff_recipient_removed_or_changed"
    },
    {
      restaurant: null,
      expectedReason: "restaurant_inactive_or_missing"
    }
  ];

  try {
    for (const scenario of scenarios) {
      const queued = makeReminder({
        to: managerPhone,
        apiKey: "staff-secret-token",
        nextAttemptAt: new Date(0),
        metadata: {
          ...makeReminder().metadata,
          createdByPhone: managerPhone,
          recipientPhone: managerPhone,
          createdByRole: "manager",
          recipientRole: "manager",
          scheduledFor: new Date(0).toISOString()
        },
        async save() {
          return this;
        }
      });
      let pendingLookupCount = 0;
      let providerSendCount = 0;
      OutboundMessage.findOne = (filter) => {
        const value = filter.status === "pending" && pendingLookupCount++ === 0
          ? queued
          : null;
        const query = {
          sort() {
            return query;
          },
          select() {
            return Promise.resolve(value);
          }
        };
        return query;
      };
      OutboundMessage.findOneAndUpdate = () => ({
        select: async () => queued
      });
      Restaurant.findOne = () => resolvedQuery(scenario.restaurant);

      const processed = await processNextQueuedWasenderMessage({
        sendMessage: async () => {
          providerSendCount += 1;
          return { success: true };
        }
      });

      assert.equal(processed, true);
      assert.equal(providerSendCount, 0);
      assert.equal(queued.status, "cancelled");
      assert.match(queued.lastError, new RegExp(scenario.expectedReason));
    }
  } finally {
    OutboundMessage.findOne = originalOutboundFindOne;
    OutboundMessage.findOneAndUpdate = originalOutboundFindOneAndUpdate;
    Restaurant.findOne = originalRestaurantFindOne;
  }
});
