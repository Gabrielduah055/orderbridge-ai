const assert = require("node:assert/strict");
const test = require("node:test");

const { PendingAgentAction } = require("../dist/models/pendingAgentAction.model");
const { OutboundMessage } = require("../dist/models/outboundMessage.model");
const { Restaurant } = require("../dist/models/Restaurant");
const {
  createRestaurantSchema
} = require("../dist/middleware/validateRequest");
const {
  buildOwnerPendingActionReminderMessage,
  findEligibleOwnerPendingActions,
  hasNewerOwnerPendingAction,
  rereadOwnerPendingAction,
  runOwnerPendingActionReminderPass
} = require("../dist/services/ownerPendingActionReminder.service");
const {
  getQueuedOwnerActionReminderStaleReason,
  isTransactionalQueuedMessage,
  processNextQueuedWasenderMessage
} = require("../dist/services/wasenderQueue.service");

const restaurantId = "64b000000000000000000a01";
const ownerActionId = "64b000000000000000000a11";
const now = new Date("2026-07-30T12:00:00.000Z");

const makeRestaurant = (overrides = {}) => ({
  _id: restaurantId,
  name: "Reminder Restaurant",
  ownerName: "Owner",
  ownerPhone: "0557038547",
  managerPhones: ["0241234567"],
  managerContacts: [{ name: "Manager", phone: "0500000001" }],
  wasenderSessionId: "wasender-session-1",
  wasenderApiToken: "restaurant-api-key",
  ownerPendingActionReminderEnabled: true,
  ownerPendingActionReminderDelayMinutes: 3,
  ...overrides
});

const makeAction = (overrides = {}) => ({
  _id: ownerActionId,
  restaurantId,
  senderPhone: "+233557038547",
  senderRole: "owner",
  action: "TOOL_CALL",
  toolName: "update_menu_price",
  arguments: {
    itemName: "Jollof",
    newPrice: 45
  },
  summary: "Jollof is currently GHS 40. Should I change it to GHS 45?",
  data: {
    itemName: "Jollof",
    newPrice: 45
  },
  status: "pending",
  confirmationMessage: "Should I change Jollof to GHS 45?",
  actionVersion: 1,
  expiresAt: new Date("2026-07-30T12:06:00.000Z"),
  createdAt: new Date("2026-07-30T11:55:00.000Z"),
  updatedAt: new Date("2026-07-30T11:55:00.000Z"),
  ...overrides
});

const createReminderHarness = ({
  restaurants = [makeRestaurant()],
  actions = [makeAction()],
  rereadById,
  hasNewerPendingAction,
  reminderKeys
} = {}) => {
  const enqueued = [];
  const keys = reminderKeys ?? new Set();
  const actionById = new Map(actions.map((action) => [String(action._id), action]));
  const calls = {
    findEligible: [],
    reread: [],
    newer: [],
    enqueue: 0
  };
  const dependencies = {
    loadRestaurants: async () => restaurants,
    findEligibleActions: async (scopedRestaurantId, passNow, delayMinutes) => {
      calls.findEligible.push({
        restaurantId: scopedRestaurantId,
        now: passNow,
        delayMinutes
      });
      return actions;
    },
    rereadAction: async (scopedRestaurantId, pendingActionId) => {
      calls.reread.push({
        restaurantId: scopedRestaurantId,
        pendingActionId
      });

      if (rereadById) {
        return rereadById(scopedRestaurantId, pendingActionId);
      }

      return actionById.get(pendingActionId) ?? null;
    },
    hasNewerPendingAction: async (scopedRestaurantId, action, passNow) => {
      calls.newer.push({
        restaurantId: scopedRestaurantId,
        pendingActionId: String(action._id),
        now: passNow
      });
      return hasNewerPendingAction
        ? hasNewerPendingAction(scopedRestaurantId, action, passNow)
        : false;
    },
    reminderExists: async (_scopedRestaurantId, idempotencyKey) =>
      keys.has(idempotencyKey),
    enqueueMessage: async (input) => {
      calls.enqueue += 1;
      keys.add(input.idempotencyKey);
      enqueued.push(input);
      return { _id: `queue-${enqueued.length}` };
    },
    logError: () => {}
  };

  return {
    calls,
    dependencies,
    enqueued,
    keys
  };
};

test("eligible pending owner action queues one deterministic reminder without executing it", async () => {
  const action = makeAction();
  const harness = createReminderHarness({ actions: [action] });
  const result = await runOwnerPendingActionReminderPass(
    now,
    harness.dependencies
  );

  assert.equal(result.remindersQueued, 1);
  assert.equal(harness.enqueued.length, 1);
  assert.equal(harness.enqueued[0].to, "+233557038547");
  assert.equal(harness.enqueued[0].sessionId, "wasender-session-1");
  assert.equal(harness.enqueued[0].apiKey, "restaurant-api-key");
  assert.equal(
    harness.enqueued[0].idempotencyKey,
    `owner-action-reminder:${restaurantId}:${ownerActionId}:1`
  );
  assert.deepEqual(harness.enqueued[0].metadata, {
    kind: "owner_action_reminder",
    restaurantId,
    pendingActionId: ownerActionId,
    actionVersion: 1,
    pendingActionPhone: "+233557038547",
    pendingActionCreatedAt: "2026-07-30T11:55:00.000Z",
    action: "TOOL_CALL",
    toolName: "update_menu_price",
    recipientRole: "owner"
  });
  assert.match(harness.enqueued[0].text, /Jollof/);
  assert.match(harness.enqueued[0].text, /Reply confirm/);
  assert.equal(action.status, "pending");
});

test("actions below the configured reminder delay are not queued", async () => {
  const action = makeAction({
    createdAt: new Date("2026-07-30T11:59:00.000Z"),
    updatedAt: new Date("2026-07-30T11:59:00.000Z")
  });
  const harness = createReminderHarness({ actions: [action] });
  const result = await runOwnerPendingActionReminderPass(
    now,
    harness.dependencies
  );

  assert.equal(result.remindersQueued, 0);
  assert.equal(harness.calls.enqueue, 0);
});

test("disabled restaurant reminder settings prevent action lookup and queueing", async () => {
  const harness = createReminderHarness({
    restaurants: [
      makeRestaurant({
        ownerPendingActionReminderEnabled: false
      })
    ]
  });
  const result = await runOwnerPendingActionReminderPass(
    now,
    harness.dependencies
  );

  assert.equal(result.remindersQueued, 0);
  assert.equal(harness.calls.findEligible.length, 0);
  assert.equal(harness.calls.enqueue, 0);
});

test("an unverified sender cannot receive an owner pending-action reminder", async () => {
  const harness = createReminderHarness({
    actions: [
      makeAction({
        senderPhone: "+233509999999",
        senderRole: "manager"
      })
    ]
  });
  const result = await runOwnerPendingActionReminderPass(
    now,
    harness.dependencies
  );

  assert.equal(result.remindersQueued, 0);
  assert.equal(harness.calls.enqueue, 0);
});

test("completed, cancelled, and expired actions are skipped after re-read", async () => {
  const actions = [
    makeAction({
      _id: "64b000000000000000000a21",
      status: "completed"
    }),
    makeAction({
      _id: "64b000000000000000000a22",
      status: "cancelled"
    }),
    makeAction({
      _id: "64b000000000000000000a23",
      expiresAt: new Date("2026-07-30T11:59:59.000Z")
    })
  ];
  const harness = createReminderHarness({ actions });
  const result = await runOwnerPendingActionReminderPass(
    now,
    harness.dependencies
  );

  assert.equal(result.actionsChecked, 3);
  assert.equal(result.remindersQueued, 0);
  assert.equal(harness.calls.enqueue, 0);
});

test("pending-action reminder database lookups are tenant-scoped", async () => {
  const originalFind = PendingAgentAction.find;
  const originalFindOne = PendingAgentAction.findOne;
  const originalExists = PendingAgentAction.exists;
  const filters = [];
  const action = makeAction();

  try {
    PendingAgentAction.find = (filter) => {
      filters.push(filter);
      return {
        sort: async () => []
      };
    };
    PendingAgentAction.findOne = (filter) => {
      filters.push(filter);
      return Promise.resolve(null);
    };
    PendingAgentAction.exists = async (filter) => {
      filters.push(filter);
      return null;
    };

    await findEligibleOwnerPendingActions(restaurantId, now, 3);
    await rereadOwnerPendingAction(restaurantId, ownerActionId);
    await hasNewerOwnerPendingAction(restaurantId, action, now);
  } finally {
    PendingAgentAction.find = originalFind;
    PendingAgentAction.findOne = originalFindOne;
    PendingAgentAction.exists = originalExists;
  }

  assert.equal(filters.length, 3);

  for (const filter of filters) {
    assert.equal(filter.restaurantId, restaurantId);
  }

  assert.equal(filters[0].status, "pending");
  assert.equal(filters[1]._id, ownerActionId);
  assert.equal(filters[2].senderPhone, action.senderPhone);
});

test("duplicate scheduler passes do not enqueue the same action version twice", async () => {
  const harness = createReminderHarness();
  const first = await runOwnerPendingActionReminderPass(
    now,
    harness.dependencies
  );
  const second = await runOwnerPendingActionReminderPass(
    now,
    harness.dependencies
  );

  assert.equal(first.remindersQueued, 1);
  assert.equal(second.remindersQueued, 0);
  assert.equal(harness.calls.enqueue, 1);
});

test("one pending action failure does not block another reminder", async () => {
  const firstAction = makeAction({
    _id: "64b000000000000000000a31"
  });
  const secondAction = makeAction({
    _id: "64b000000000000000000a32",
    senderPhone: "+233241234567",
    senderRole: "manager",
    toolName: "set_item_availability",
    summary: "Should I mark Banku as unavailable?"
  });
  const harness = createReminderHarness({
    actions: [firstAction, secondAction],
    rereadById: async (_scopedRestaurantId, pendingActionId) => {
      if (pendingActionId === String(firstAction._id)) {
        throw new Error("Action lookup failed");
      }

      return secondAction;
    }
  });
  const result = await runOwnerPendingActionReminderPass(
    now,
    harness.dependencies
  );

  assert.equal(result.errors, 1);
  assert.equal(result.remindersQueued, 1);
  assert.equal(harness.enqueued[0].to, "+233241234567");
});

test("reminders route to the verified owner or manager phone attached to each action", async () => {
  const ownerAction = makeAction();
  const managerAction = makeAction({
    _id: "64b000000000000000000a41",
    senderPhone: "0500000001",
    senderRole: "manager",
    toolName: "set_item_availability",
    summary: "Should I mark Fish as available?"
  });
  const harness = createReminderHarness({
    actions: [ownerAction, managerAction]
  });
  const result = await runOwnerPendingActionReminderPass(
    now,
    harness.dependencies
  );

  assert.equal(result.remindersQueued, 2);
  assert.deepEqual(
    harness.enqueued.map((message) => message.to).sort(),
    ["+233500000001", "+233557038547"]
  );
  assert.deepEqual(
    harness.enqueued.map((message) => message.metadata.recipientRole).sort(),
    ["manager", "owner"]
  );
});

test("action-aware reminder messages use backend action details", () => {
  assert.match(
    buildOwnerPendingActionReminderMessage(makeAction()),
    /Jollof is currently GHS 40/
  );
  assert.match(
    buildOwnerPendingActionReminderMessage(
      makeAction({
        toolName: "set_item_availability",
        summary: "Should I mark Fish as unavailable?"
      })
    ),
    /Fish as unavailable/
  );
  assert.match(
    buildOwnerPendingActionReminderMessage(
      makeAction({
        toolName: "add_menu_items",
        summary: "Should I add 2 menu items?"
      })
    ),
    /add 2 menu items/
  );
  assert.match(
    buildOwnerPendingActionReminderMessage(
      makeAction({
        toolName: "cancel_order",
        summary: "Should I cancel order ORD-123?"
      })
    ),
    /cancel order ORD-123/
  );
});

const resolvedQuery = (value) => ({
  sort() {
    return this;
  },
  select() {
    return Promise.resolve(value);
  }
});

const processQueuedReminder = async ({ action, newerAction = false }) => {
  const originalOutboundFindOne = OutboundMessage.findOne;
  const originalOutboundFindOneAndUpdate = OutboundMessage.findOneAndUpdate;
  const originalActionFindOne = PendingAgentAction.findOne;
  const originalActionExists = PendingAgentAction.exists;
  let sendCount = 0;
  let saveCount = 0;
  const candidate = {
    _id: "64b000000000000000000a51",
    sessionId: "wasender-session-1",
    nextAttemptAt: new Date(0)
  };
  const locked = {
    ...candidate,
    restaurantId,
    to: "+233557038547",
    type: "text",
    text: "Reminder",
    status: "sending",
    attempts: 1,
    maxAttempts: 5,
    metadata: {
      kind: "owner_action_reminder",
      restaurantId,
      pendingActionId: ownerActionId,
      actionVersion: 1,
      pendingActionPhone: "+233557038547"
    },
    async save() {
      saveCount += 1;
      return this;
    }
  };

  try {
    OutboundMessage.findOne = (filter) =>
      resolvedQuery(filter.status === "pending" ? candidate : null);
    OutboundMessage.findOneAndUpdate = () => resolvedQuery(locked);
    PendingAgentAction.findOne = () => resolvedQuery(action);
    PendingAgentAction.exists = async () =>
      newerAction ? { _id: "64b000000000000000000a52" } : null;

    const processed = await processNextQueuedWasenderMessage({
      sendMessage: async () => {
        sendCount += 1;
        return {
          success: true,
          status: 200,
          data: { id: "provider-message-1" }
        };
      }
    });

    return {
      locked,
      processed,
      saveCount,
      sendCount
    };
  } finally {
    OutboundMessage.findOne = originalOutboundFindOne;
    OutboundMessage.findOneAndUpdate = originalOutboundFindOneAndUpdate;
    PendingAgentAction.findOne = originalActionFindOne;
    PendingAgentAction.exists = originalActionExists;
  }
};

test("an action completed after queueing cancels its reminder before send", async () => {
  const result = await processQueuedReminder({
    action: makeAction({
      status: "completed",
      expiresAt: new Date("2099-01-01T00:00:00.000Z")
    })
  });

  assert.equal(result.processed, true);
  assert.equal(result.locked.status, "cancelled");
  assert.equal(result.sendCount, 0);
  assert.equal(result.saveCount, 1);
  assert.match(result.locked.lastError, /pending_action_completed/);
});

test("a missing pending action cancels its queued reminder", async () => {
  const result = await processQueuedReminder({
    action: null
  });

  assert.equal(result.locked.status, "cancelled");
  assert.equal(result.sendCount, 0);
  assert.match(result.locked.lastError, /pending_action_missing/);
});

test("cancelled and expired actions cancel queued reminders before send", async () => {
  const cancelled = await processQueuedReminder({
    action: makeAction({
      status: "cancelled",
      expiresAt: new Date("2099-01-01T00:00:00.000Z")
    })
  });
  const expired = await processQueuedReminder({
    action: makeAction({
      expiresAt: new Date("2000-01-01T00:00:00.000Z")
    })
  });

  assert.equal(cancelled.locked.status, "cancelled");
  assert.equal(cancelled.sendCount, 0);
  assert.match(cancelled.locked.lastError, /pending_action_cancelled/);
  assert.equal(expired.locked.status, "cancelled");
  assert.equal(expired.sendCount, 0);
  assert.match(expired.locked.lastError, /pending_action_expired/);
});

test("a valid unchanged pending action reminder is sent", async () => {
  const result = await processQueuedReminder({
    action: makeAction({
      expiresAt: new Date("2099-01-01T00:00:00.000Z")
    })
  });

  assert.equal(result.locked.status, "sent");
  assert.equal(result.sendCount, 1);
  assert.equal(result.locked.sentAt instanceof Date, true);
  assert.equal(result.saveCount, 1);
});

test("a newer pending action makes an older queued reminder stale", async () => {
  const staleReason = await (async () => {
    const originalFindOne = PendingAgentAction.findOne;
    const originalExists = PendingAgentAction.exists;

    try {
      PendingAgentAction.findOne = () =>
        resolvedQuery(
          makeAction({
            expiresAt: new Date("2099-01-01T00:00:00.000Z")
          })
        );
      PendingAgentAction.exists = async () => ({
        _id: "64b000000000000000000a61"
      });

      return await getQueuedOwnerActionReminderStaleReason(
        {
          kind: "owner_action_reminder",
          restaurantId,
          pendingActionId: ownerActionId,
          actionVersion: 1,
          pendingActionPhone: "+233557038547"
        },
        now
      );
    } finally {
      PendingAgentAction.findOne = originalFindOne;
      PendingAgentAction.exists = originalExists;
    }
  })();

  assert.equal(staleReason, "pending_action_replaced");
});

test("pending-action reminders are transactional and settings enforce a safe delay", () => {
  assert.equal(
    isTransactionalQueuedMessage({ kind: "owner_action_reminder" }),
    true
  );
  assert.equal(
    Restaurant.schema.path("ownerPendingActionReminderEnabled").options.default,
    false
  );
  assert.equal(
    Restaurant.schema.path("ownerPendingActionReminderDelayMinutes").options.default,
    3
  );
  assert.equal(
    PendingAgentAction.schema.path("actionVersion").options.default,
    1
  );

  const invalid = createRestaurantSchema.safeParse({
    name: "Invalid Reminder Delay",
    ownerPhone: "0557038547",
    wasenderSessionId: "session",
    whatsappNumber: "0557038547",
    ownerPendingActionReminderEnabled: true,
    ownerPendingActionReminderDelayMinutes: 0
  });

  assert.equal(invalid.success, false);
});
