const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CustomerProfile
} = require("../dist/models/customerProfile.model");
const {
  CustomerCampaign
} = require("../dist/models/customerCampaign.model");
const {
  CustomerCampaignRecipient
} = require("../dist/models/customerCampaignRecipient.model");
const {
  OutboundMessage
} = require("../dist/models/outboundMessage.model");
const { Restaurant } = require("../dist/models/Restaurant");
const { MenuItem } = require("../dist/models/MenuItem");
const { Order } = require("../dist/models/order.model");
const {
  AgentConversationMessage
} = require("../dist/models/agentConversation.model");
const {
  handleCustomerMarketingPreferenceCommand,
  parseCustomerMarketingPreferenceCommand,
  setCustomerMarketingPreference
} = require("../dist/services/customerMarketingPreference.service");
const {
  refreshCustomerProfileFromCompletedOrders
} = require("../dist/services/customerProfile.service");
const {
  approveCustomerCampaign,
  customerCampaignTargetingSchema,
  createCustomerCampaignDraftSchema,
  resolveCustomerCampaignScheduledAt,
  selectCustomerCampaignAudience,
  updateCustomerCampaignAggregate
} = require("../dist/services/customerCampaign.service");
const {
  CUSTOMER_CAMPAIGN_BATCH_SIZE,
  getCustomerCampaignIdempotencyKey,
  runCustomerCampaignSchedulerPass
} = require("../dist/services/customerCampaignScheduler.service");
const {
  getQueuedCustomerCampaignStaleReason,
  isTransactionalQueuedMessage,
  processNextQueuedWasenderMessage
} = require("../dist/services/wasenderQueue.service");
const {
  isToolAllowedForRole
} = require("../dist/agent-tools/tool.permissions");
const {
  getAgentToolDefinitionsForRole
} = require("../dist/services/ai/agentToolDefinitions.service");
const {
  handleRestaurantAgentMessage
} = require("../dist/services/restaurantAgent.service");

const restaurantId = "64b000000000000000000b01";
const otherRestaurantId = "64b000000000000000000b02";
const campaignId = "64b000000000000000000b11";
const recipientId = "64b000000000000000000b21";
const profileId = "64b000000000000000000b31";
const menuItemId = "64b000000000000000000b41";
const customerPhone = "+233557038547";
const now = new Date("2026-07-30T12:00:00.000Z");

const resolvedQuery = (value) => ({
  select() {
    return Promise.resolve(value);
  },
  sort() {
    return this;
  },
  limit() {
    return Promise.resolve(value);
  }
});

const makeRestaurant = (overrides = {}) => ({
  _id: restaurantId,
  name: "Campaign Restaurant",
  ownerName: "Owner",
  ownerPhone: "+233507879374",
  managerPhones: ["+233241234567"],
  managerContacts: [],
  status: "active",
  timezone: "Africa/Accra",
  wasenderSessionId: "wasender-session-1",
  wasenderApiToken: "restaurant-token",
  ...overrides
});

const makeCampaign = (overrides = {}) => ({
  _id: campaignId,
  restaurantId,
  name: "Weekend offer",
  message: "Try our weekend special.",
  campaignType: "promotion",
  targeting: {
    type: "all_eligible_customers"
  },
  timezone: "Africa/Accra",
  status: "sending",
  campaignVersion: 1,
  approvedAt: new Date("2026-07-30T11:00:00.000Z"),
  estimatedRecipientCount: 1,
  totalRecipientCount: 1,
  queuedRecipientCount: 0,
  sentRecipientCount: 0,
  failedRecipientCount: 0,
  cancelledRecipientCount: 0,
  excludedNoConsentCount: 0,
  excludedOptOutCount: 0,
  excludedInvalidPhoneCount: 0,
  ...overrides
});

const makeRecipient = (overrides = {}) => ({
  _id: recipientId,
  restaurantId,
  campaignId,
  customerProfileId: profileId,
  customerPhone,
  campaignVersion: 1,
  qualificationReason: "explicit marketing consent",
  consentSnapshotUpdatedAt: new Date(
    "2026-07-30T10:00:00.000Z"
  ),
  status: "pending",
  ...overrides
});

test("marketing preference commands are explicit and bounded", () => {
  assert.equal(parseCustomerMarketingPreferenceCommand(" STOP! "), "opt_out");
  assert.equal(
    parseCustomerMarketingPreferenceCommand(
      "don't send me promotions"
    ),
    "opt_out"
  );
  assert.equal(
    parseCustomerMarketingPreferenceCommand(
      "send me promotions again"
    ),
    "opt_in"
  );
  assert.equal(
    parseCustomerMarketingPreferenceCommand(
      "stop by the restaurant tomorrow"
    ),
    null
  );
  assert.equal(
    CustomerProfile.schema.path("marketingConsent").options.default,
    null
  );
  assert.equal(
    CustomerProfile.schema.path("isOptedOut").options.default,
    false
  );
});

test("placing and completing an order does not create marketing consent", async () => {
  const originalOrderFind = Order.find;
  const originalProfileFindOne = CustomerProfile.findOne;
  const originalProfileFindOneAndUpdate =
    CustomerProfile.findOneAndUpdate;
  let capturedUpdate;

  try {
    Order.find = (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      assert.equal(filter.status, "completed");
      return {
        sort: async () => [
          {
            restaurantId,
            customerPhone,
            customerName: "Ama",
            status: "completed",
            items: [
              {
                menuItemId,
                name: "Jollof",
                quantity: 1,
                unitPrice: 30,
                totalPrice: 30
              }
            ],
            total: 30,
            orderType: "pickup",
            completedAt: now,
            createdAt: now,
            updatedAt: now
          }
        ]
      };
    };
    CustomerProfile.findOne = () => resolvedQuery(null);
    CustomerProfile.findOneAndUpdate = async (_filter, update) => {
      capturedUpdate = update;
      return update.$set;
    };

    await refreshCustomerProfileFromCompletedOrders(
      restaurantId,
      customerPhone
    );

    assert.equal("marketingConsent" in capturedUpdate.$set, false);
    assert.equal("isOptedOut" in capturedUpdate.$set, false);
    assert.equal(
      "marketingConsent" in capturedUpdate.$setOnInsert,
      false
    );
  } finally {
    Order.find = originalOrderFind;
    CustomerProfile.findOne = originalProfileFindOne;
    CustomerProfile.findOneAndUpdate =
      originalProfileFindOneAndUpdate;
  }
});

test("explicit opt-in is normalized, audited, and restaurant-scoped", async () => {
  const originalFindOne = CustomerProfile.findOne;
  const originalFindOneAndUpdate = CustomerProfile.findOneAndUpdate;
  let capturedFilter;
  let capturedUpdate;

  try {
    CustomerProfile.findOne = async () => null;
    CustomerProfile.findOneAndUpdate = async (filter, update) => {
      capturedFilter = filter;
      capturedUpdate = update;
      return {
        ...filter,
        ...update.$set
      };
    };

    const profile = await setCustomerMarketingPreference(
      restaurantId,
      "0557038547",
      "opt_in",
      "customer_message",
      now
    );

    assert.deepEqual(capturedFilter, {
      restaurantId,
      customerPhone
    });
    assert.equal(capturedUpdate.$set.marketingConsent, true);
    assert.equal(capturedUpdate.$set.isOptedOut, false);
    assert.equal(
      capturedUpdate.$set.marketingConsentSource,
      "customer_message"
    );
    assert.equal(
      capturedUpdate.$set.marketingConsentAt,
      now
    );
    assert.equal(profile.marketingConsent, true);
  } finally {
    CustomerProfile.findOne = originalFindOne;
    CustomerProfile.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("STOP is idempotent, scoped, and cancels queued marketing only", async () => {
  const originalFindOne = CustomerProfile.findOne;
  const originalFindOneAndUpdate = CustomerProfile.findOneAndUpdate;
  const originalOutboundUpdateMany = OutboundMessage.updateMany;
  const originalRecipientUpdateMany =
    CustomerCampaignRecipient.updateMany;
  const filters = [];
  let profileWrites = 0;

  try {
    CustomerProfile.findOne = async (filter) => {
      filters.push(filter);
      return {
        ...filter,
        marketingConsent: false,
        isOptedOut: true
      };
    };
    CustomerProfile.findOneAndUpdate = async () => {
      profileWrites += 1;
    };
    OutboundMessage.updateMany = async (filter) => {
      filters.push(filter);
      return { modifiedCount: 1 };
    };
    CustomerCampaignRecipient.updateMany = async (filter) => {
      filters.push(filter);
      return { modifiedCount: 1 };
    };

    const first = await handleCustomerMarketingPreferenceCommand(
      restaurantId,
      customerPhone,
      "STOP",
      now
    );
    const second = await handleCustomerMarketingPreferenceCommand(
      restaurantId,
      customerPhone,
      "STOP",
      now
    );

    assert.equal(first.handled, true);
    assert.equal(second.handled, true);
    assert.equal(profileWrites, 0);

    for (const filter of filters) {
      assert.equal(filter.restaurantId, restaurantId);
    }

    const queueFilter = filters.find(
      (filter) => filter["metadata.kind"] === "customer_campaign"
    );
    assert.equal(queueFilter.to, customerPhone);
    assert.equal(queueFilter.status, "pending");
  } finally {
    CustomerProfile.findOne = originalFindOne;
    CustomerProfile.findOneAndUpdate = originalFindOneAndUpdate;
    OutboundMessage.updateMany = originalOutboundUpdateMany;
    CustomerCampaignRecipient.updateMany =
      originalRecipientUpdateMany;
  }
});

test("clear preference commands override ordinary customer AI handling", async () => {
  const originalFindOne = CustomerProfile.findOne;
  const originalFindOneAndUpdate = CustomerProfile.findOneAndUpdate;
  const originalOutboundUpdateMany = OutboundMessage.updateMany;
  const originalRecipientUpdateMany =
    CustomerCampaignRecipient.updateMany;
  const originalConversationCreate = AgentConversationMessage.create;
  const savedMessages = [];

  try {
    CustomerProfile.findOne = async () => null;
    CustomerProfile.findOneAndUpdate = async (filter, update) => ({
      ...filter,
      ...update.$set
    });
    OutboundMessage.updateMany = async () => ({ modifiedCount: 0 });
    CustomerCampaignRecipient.updateMany = async () => ({
      modifiedCount: 0
    });
    AgentConversationMessage.create = async (input) => {
      savedMessages.push(input);
      return input;
    };

    const response = await handleRestaurantAgentMessage({
      restaurant: makeRestaurant(),
      senderPhone: customerPhone,
      message: "STOP"
    });

    assert.equal(response.success, true);
    assert.match(response.message, /opted out/i);
    assert.equal(savedMessages.length, 2);
    assert.equal(
      savedMessages[0].metadata.source,
      "deterministic_marketing_preference"
    );
    assert.equal(
      savedMessages[1].metadata.source,
      "deterministic_marketing_preference"
    );
  } finally {
    CustomerProfile.findOne = originalFindOne;
    CustomerProfile.findOneAndUpdate = originalFindOneAndUpdate;
    OutboundMessage.updateMany = originalOutboundUpdateMany;
    CustomerCampaignRecipient.updateMany =
      originalRecipientUpdateMany;
    AgentConversationMessage.create = originalConversationCreate;
  }
});

test("transactional customer messages remain allowed after opt-out", () => {
  assert.equal(
    isTransactionalQueuedMessage({ kind: "receipt_delivery" }),
    true
  );
  assert.equal(
    isTransactionalQueuedMessage({
      kind: "customer_order_confirmed_notification"
    }),
    true
  );
  assert.equal(
    isTransactionalQueuedMessage({ kind: "customer_campaign" }),
    false
  );
});

test("campaign permissions and schemas reject customers and injected scope", () => {
  for (const toolName of [
    "create_campaign_draft",
    "approve_campaign",
    "cancel_campaign",
    "list_campaigns"
  ]) {
    assert.equal(isToolAllowedForRole(toolName, "customer"), false);
    assert.equal(isToolAllowedForRole(toolName, "owner"), true);
    assert.equal(isToolAllowedForRole(toolName, "manager"), true);
  }

  const validDraft = {
    name: "Holiday greeting",
    message: "Happy holidays from our team.",
    campaignType: "holiday",
    targeting: {
      type: "all_eligible_customers"
    }
  };

  assert.equal(
    createCustomerCampaignDraftSchema.safeParse(validDraft).success,
    true
  );
  assert.equal(
    createCustomerCampaignDraftSchema.safeParse({
      ...validDraft,
      restaurantId
    }).success,
    false
  );
  assert.equal(
    createCustomerCampaignDraftSchema.safeParse({
      ...validDraft,
      recipientPhones: [customerPhone]
    }).success,
    false
  );
  assert.equal(
    customerCampaignTargetingSchema.safeParse({
      type: "all_eligible_customers",
      filter: {
        marketingConsent: true
      }
    }).success,
    false
  );

  const ownerDefinition = getAgentToolDefinitionsForRole("owner").find(
    (tool) => tool.function.name === "create_campaign_draft"
  );
  assert.ok(
    ownerDefinition.function.parameters.properties.targeting
      .properties.type
  );
  assert.equal(
    "restaurantId" in
      ownerDefinition.function.parameters.properties,
    false
  );
});

test("campaign approval revalidates staff and creates one immutable scoped snapshot", async () => {
  const originalCampaignFindOne = CustomerCampaign.findOne;
  const originalCampaignFindOneAndUpdate =
    CustomerCampaign.findOneAndUpdate;
  const originalRestaurantFindOne = Restaurant.findOne;
  const originalProfileFind = CustomerProfile.find;
  const originalRecipientBulkWrite =
    CustomerCampaignRecipient.bulkWrite;
  const originalRecipientCount =
    CustomerCampaignRecipient.countDocuments;
  const operations = [];
  let approvalFilter;

  try {
    CustomerCampaign.findOne = async (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      return makeCampaign({
        status: "pending_approval"
      });
    };
    Restaurant.findOne = (filter) => {
      assert.equal(filter._id, restaurantId);
      return resolvedQuery(makeRestaurant());
    };
    CustomerProfile.find = (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      return resolvedQuery([
        {
          _id: profileId,
          customerPhone,
          orderCount: 2,
          marketingConsent: true,
          isOptedOut: false,
          marketingPreferenceUpdatedAt: now,
          updatedAt: now
        }
      ]);
    };
    CustomerCampaignRecipient.bulkWrite = async (writes) => {
      operations.push(...writes);
      return { upsertedCount: writes.length };
    };
    CustomerCampaignRecipient.countDocuments = async (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      assert.equal(String(filter.campaignId), campaignId);
      return 1;
    };
    CustomerCampaign.findOneAndUpdate = async (filter, update) => {
      approvalFilter = filter;
      return {
        ...makeCampaign(),
        ...update.$set
      };
    };

    const approved = await approveCustomerCampaign(
      restaurantId,
      campaignId,
      "+233507879374",
      now
    );

    assert.equal(approved.status, "approved");
    assert.equal(approved.approvedByRole, "owner");
    assert.equal(approved.totalRecipientCount, 1);
    assert.equal(operations.length, 1);
    assert.equal(
      String(
        operations[0].updateOne.filter.restaurantId
      ),
      restaurantId
    );
    assert.equal(
      String(operations[0].updateOne.filter.campaignId),
      campaignId
    );
    assert.equal(
      operations[0].updateOne.filter.customerPhone,
      customerPhone
    );
    assert.equal(
      operations[0].updateOne.update.$setOnInsert.status,
      "pending"
    );
    assert.equal(approvalFilter.restaurantId, restaurantId);
    assert.equal(approvalFilter.status, "pending_approval");
  } finally {
    CustomerCampaign.findOne = originalCampaignFindOne;
    CustomerCampaign.findOneAndUpdate =
      originalCampaignFindOneAndUpdate;
    Restaurant.findOne = originalRestaurantFindOne;
    CustomerProfile.find = originalProfileFind;
    CustomerCampaignRecipient.bulkWrite =
      originalRecipientBulkWrite;
    CustomerCampaignRecipient.countDocuments =
      originalRecipientCount;
  }
});

test("audience selection deduplicates phones and reports consent exclusions", async () => {
  const originalProfileFind = CustomerProfile.find;
  let profileFilter;
  const profiles = [
    {
      _id: profileId,
      customerPhone: "0557038547",
      orderCount: 2,
      marketingConsent: true,
      isOptedOut: false,
      marketingPreferenceUpdatedAt: now,
      updatedAt: now
    },
    {
      _id: "64b000000000000000000b32",
      customerPhone,
      orderCount: 3,
      marketingConsent: true,
      isOptedOut: false,
      marketingPreferenceUpdatedAt: now,
      updatedAt: now
    },
    {
      _id: "64b000000000000000000b33",
      customerPhone: "+233500000001",
      orderCount: 1,
      marketingConsent: null,
      isOptedOut: false,
      updatedAt: now
    },
    {
      _id: "64b000000000000000000b34",
      customerPhone: "+233500000002",
      orderCount: 1,
      marketingConsent: true,
      isOptedOut: true,
      updatedAt: now
    },
    {
      _id: "64b000000000000000000b35",
      customerPhone: "invalid",
      orderCount: 1,
      marketingConsent: true,
      isOptedOut: false,
      updatedAt: now
    }
  ];

  try {
    CustomerProfile.find = (filter) => {
      profileFilter = filter;
      return resolvedQuery(profiles);
    };

    const preview = await selectCustomerCampaignAudience(
      restaurantId,
      {
        type: "all_eligible_customers"
      },
      now
    );

    assert.equal(profileFilter.restaurantId, restaurantId);
    assert.equal(preview.estimatedEligibleRecipients, 1);
    assert.equal(preview.excludedNoConsent, 1);
    assert.equal(preview.excludedOptOut, 1);
    assert.equal(preview.excludedInvalidPhone, 1);
    assert.equal(preview.recipients[0].customerPhone, customerPhone);
  } finally {
    CustomerProfile.find = originalProfileFind;
  }
});

test("behavioural targeting uses completed tenant-scoped orders and owned menu items", async () => {
  const originalProfileFind = CustomerProfile.find;
  const originalOrderFind = Order.find;
  const originalMenuFindOne = MenuItem.findOne;
  let orderFilter;
  let menuFilter;

  try {
    CustomerProfile.find = () =>
      resolvedQuery([
        {
          _id: profileId,
          customerPhone,
          orderCount: 1,
          marketingConsent: true,
          isOptedOut: false,
          marketingPreferenceUpdatedAt: now,
          updatedAt: now
        },
        {
          _id: "64b000000000000000000b36",
          customerPhone: "+233500000003",
          orderCount: 10,
          marketingConsent: true,
          isOptedOut: false,
          marketingPreferenceUpdatedAt: now,
          updatedAt: now
        }
      ]);
    MenuItem.findOne = (filter) => {
      menuFilter = filter;
      return resolvedQuery({
        _id: menuItemId,
        restaurantId,
        name: "Jollof",
        isAvailable: true
      });
    };
    Order.find = (filter) => {
      orderFilter = filter;
      return resolvedQuery([
        {
          customerPhone
        }
      ]);
    };

    const preview = await selectCustomerCampaignAudience(
      restaurantId,
      {
        type: "ordered_menu_item",
        menuItemId
      },
      now
    );

    assert.equal(menuFilter.restaurantId, restaurantId);
    assert.equal(orderFilter.restaurantId, restaurantId);
    assert.equal(orderFilter.status, "completed");
    assert.equal(orderFilter["items.menuItemId"], menuItemId);
    assert.deepEqual(
      preview.recipients.map((entry) => entry.customerPhone),
      [customerPhone]
    );
  } finally {
    CustomerProfile.find = originalProfileFind;
    Order.find = originalOrderFind;
    MenuItem.findOne = originalMenuFindOne;
  }
});

test("ordered-menu-item targeting rejects a cross-restaurant item", async () => {
  const originalMenuFindOne = MenuItem.findOne;
  let capturedFilter;

  try {
    MenuItem.findOne = (filter) => {
      capturedFilter = filter;
      return resolvedQuery(null);
    };

    await assert.rejects(
      selectCustomerCampaignAudience(
        restaurantId,
        {
          type: "ordered_menu_item",
          menuItemId
        },
        now
      ),
      /does not belong/
    );
    assert.equal(capturedFilter.restaurantId, restaurantId);
  } finally {
    MenuItem.findOne = originalMenuFindOne;
  }
});

test("restaurant-local campaign scheduling resolves to the correct UTC instant", () => {
  assert.equal(
    resolveCustomerCampaignScheduledAt(
      "2026-07-30T09:30",
      "Africa/Accra"
    ).toISOString(),
    "2026-07-30T09:30:00.000Z"
  );
  assert.equal(
    resolveCustomerCampaignScheduledAt(
      "2026-07-30T09:30",
      "America/New_York"
    ).toISOString(),
    "2026-07-30T13:30:00.000Z"
  );
});

const makeSchedulerHarness = ({
  campaigns = [makeCampaign({ status: "approved" })],
  recipients = [makeRecipient()],
  restaurant = makeRestaurant(),
  failRecipientId,
  batchSize
} = {}) => {
  const messageKeys = new Set();
  const enqueued = [];
  const calls = {
    recipientBatchSizes: [],
    errors: []
  };
  const dependencies = {
    loadRestaurants: async () => (restaurant ? [restaurant] : []),
    loadCampaigns: async () => campaigns,
    loadRecipients: async (
      scopedRestaurantId,
      scopedCampaignId,
      campaignVersion,
      requestedBatchSize
    ) => {
      assert.equal(scopedRestaurantId, restaurantId);
      assert.equal(scopedCampaignId, campaignId);
      assert.equal(campaignVersion, 1);
      calls.recipientBatchSizes.push(requestedBatchSize);
      return recipients;
    },
    messageExists: async (_scopedRestaurantId, key) =>
      messageKeys.has(key),
    enqueueMessage: async (input) => {
      const queuedRecipientId =
        input.metadata.campaignRecipientId;

      if (queuedRecipientId === failRecipientId) {
        throw new Error("simulated recipient failure");
      }

      messageKeys.add(input.idempotencyKey);
      enqueued.push(input);
      return {
        _id: `queue-${enqueued.length}`
      };
    },
    attachOutboundMessage: async () => {},
    markCampaignSending: async () => {},
    validateReferencedItem: async () => {},
    updateAggregate: async () => null,
    batchSize,
    logError: (message, context) =>
      calls.errors.push({ message, context })
  };

  return {
    calls,
    dependencies,
    enqueued,
    messageKeys
  };
};

test("approved campaigns queue once with privacy-safe marketing metadata", async () => {
  const recipient = makeRecipient();
  const harness = makeSchedulerHarness({
    recipients: [recipient]
  });

  const first = await runCustomerCampaignSchedulerPass(
    now,
    harness.dependencies
  );
  const second = await runCustomerCampaignSchedulerPass(
    now,
    harness.dependencies
  );

  assert.equal(first.messagesQueued, 1);
  assert.equal(second.messagesQueued, 0);
  assert.equal(harness.enqueued.length, 1);
  assert.equal(
    harness.enqueued[0].idempotencyKey,
    getCustomerCampaignIdempotencyKey(
      campaignId,
      recipientId,
      1
    )
  );
  assert.deepEqual(harness.enqueued[0].metadata, {
    kind: "customer_campaign",
    restaurantId,
    campaignId,
    campaignRecipientId: recipientId,
    campaignVersion: 1,
    customerPhone,
    consentSnapshotUpdatedAt:
      "2026-07-30T10:00:00.000Z",
    recipientType: "customer",
    purpose: "marketing"
  });
  assert.match(
    harness.enqueued[0].text,
    /Campaign Restaurant/
  );
  assert.match(harness.enqueued[0].text, /Reply STOP/);
  assert.equal(recipient.status, "pending");
});

test("campaign scheduler skips unapproved and inactive restaurant campaigns", async () => {
  const unapprovedHarness = makeSchedulerHarness({
    campaigns: [makeCampaign({ status: "pending_approval" })]
  });
  const inactiveHarness = makeSchedulerHarness({
    restaurant: null
  });

  await runCustomerCampaignSchedulerPass(
    now,
    unapprovedHarness.dependencies
  );
  await runCustomerCampaignSchedulerPass(
    now,
    inactiveHarness.dependencies
  );

  assert.equal(unapprovedHarness.enqueued.length, 0);
  assert.equal(inactiveHarness.enqueued.length, 0);
});

test("campaign scheduler bounds batches and isolates recipient failures", async () => {
  const recipients = Array.from({ length: 105 }, (_, index) =>
    makeRecipient({
      _id: `64b000000000000000000${String(index).padStart(3, "0")}`
    })
  );
  const failedId = String(recipients[0]._id);
  const harness = makeSchedulerHarness({
    recipients,
    failRecipientId: failedId,
    batchSize: 1000
  });
  const result = await runCustomerCampaignSchedulerPass(
    now,
    harness.dependencies
  );

  assert.equal(
    harness.calls.recipientBatchSizes[0],
    CUSTOMER_CAMPAIGN_BATCH_SIZE
  );
  assert.equal(result.recipientsChecked, 100);
  assert.equal(result.messagesQueued, 99);
  assert.equal(result.errors, 1);
});

test("one campaign failure does not block another restaurant campaign", async () => {
  const secondRestaurantId = otherRestaurantId;
  const secondCampaignId = "64b000000000000000000b12";
  const secondRecipientId = "64b000000000000000000b22";
  const enqueued = [];
  const result = await runCustomerCampaignSchedulerPass(now, {
    loadRestaurants: async () => [
      makeRestaurant(),
      makeRestaurant({
        _id: secondRestaurantId,
        name: "Healthy Restaurant"
      })
    ],
    loadCampaigns: async (scopedRestaurantId) => [
      makeCampaign({
        _id:
          scopedRestaurantId === restaurantId
            ? campaignId
            : secondCampaignId,
        restaurantId: scopedRestaurantId,
        status: "approved"
      })
    ],
    loadRecipients: async (scopedRestaurantId) => {
      if (scopedRestaurantId === restaurantId) {
        throw new Error("broken campaign");
      }

      return [
        makeRecipient({
          _id: secondRecipientId,
          restaurantId: secondRestaurantId,
          campaignId: secondCampaignId
        })
      ];
    },
    messageExists: async () => false,
    enqueueMessage: async (input) => {
      enqueued.push(input);
      return { _id: "healthy-queue" };
    },
    attachOutboundMessage: async () => {},
    markCampaignSending: async () => {},
    validateReferencedItem: async () => {},
    updateAggregate: async () => null,
    logError: () => {}
  });

  assert.equal(result.errors, 1);
  assert.equal(result.messagesQueued, 1);
  assert.equal(enqueued[0].restaurantId, secondRestaurantId);
});

test("future campaigns wait and unavailable referenced items cancel safely", async () => {
  const futureHarness = makeSchedulerHarness({
    campaigns: [
      makeCampaign({
        status: "scheduled",
        scheduledAt: new Date("2026-07-30T13:00:00.000Z")
      })
    ]
  });
  await runCustomerCampaignSchedulerPass(
    now,
    futureHarness.dependencies
  );
  assert.equal(futureHarness.enqueued.length, 0);

  let cancelled = 0;
  const unavailableHarness = makeSchedulerHarness({
    campaigns: [
      makeCampaign({
        status: "approved",
        referencedMenuItemId: menuItemId
      })
    ]
  });
  unavailableHarness.dependencies.validateReferencedItem =
    async () => {
      throw new Error("menu item unavailable");
    };
  unavailableHarness.dependencies.cancelInvalidCampaign =
    async (scopedRestaurantId, scopedCampaignId) => {
      assert.equal(scopedRestaurantId, restaurantId);
      assert.equal(scopedCampaignId, campaignId);
      cancelled += 1;
    };
  await runCustomerCampaignSchedulerPass(
    now,
    unavailableHarness.dependencies
  );

  assert.equal(cancelled, 1);
  assert.equal(unavailableHarness.enqueued.length, 0);
});

const runCampaignStaleCheck = async ({
  campaign = makeCampaign(),
  recipient = makeRecipient(),
  profile = {
    _id: profileId,
    restaurantId,
    customerPhone,
    marketingConsent: true,
    isOptedOut: false
  },
  restaurant = makeRestaurant(),
  referencedItemAvailable = true
} = {}) => {
  const originalCampaignFindOne = CustomerCampaign.findOne;
  const originalRecipientFindOne =
    CustomerCampaignRecipient.findOne;
  const originalProfileFindOne = CustomerProfile.findOne;
  const originalRestaurantFindOne = Restaurant.findOne;
  const originalMenuExists = MenuItem.exists;
  const filters = {};

  try {
    CustomerCampaign.findOne = (filter) => {
      filters.campaign = filter;
      return resolvedQuery(campaign);
    };
    CustomerCampaignRecipient.findOne = (filter) => {
      filters.recipient = filter;
      return resolvedQuery(recipient);
    };
    CustomerProfile.findOne = (filter) => {
      filters.profile = filter;
      return resolvedQuery(profile);
    };
    Restaurant.findOne = (filter) => {
      filters.restaurant = filter;
      return resolvedQuery(restaurant);
    };
    MenuItem.exists = async (filter) => {
      filters.menu = filter;
      return referencedItemAvailable ? { _id: menuItemId } : null;
    };

    const reason = await getQueuedCustomerCampaignStaleReason(
      {
        kind: "customer_campaign",
        restaurantId,
        campaignId,
        campaignRecipientId: recipientId,
        campaignVersion: 1,
        customerPhone,
        consentSnapshotUpdatedAt:
          "2026-07-30T10:00:00.000Z",
        recipientType: "customer",
        purpose: "marketing"
      },
      now,
      customerPhone,
      "wasender-session-1"
    );

    return {
      filters,
      reason
    };
  } finally {
    CustomerCampaign.findOne = originalCampaignFindOne;
    CustomerCampaignRecipient.findOne =
      originalRecipientFindOne;
    CustomerProfile.findOne = originalProfileFindOne;
    Restaurant.findOne = originalRestaurantFindOne;
    MenuItem.exists = originalMenuExists;
  }
};

test("send-time checks cancel revoked, opted-out, missing, cancelled, and changed campaigns", async () => {
  assert.equal(
    (
      await runCampaignStaleCheck({
        profile: {
          customerPhone,
          marketingConsent: false,
          isOptedOut: false
        }
      })
    ).reason,
    "marketing_consent_revoked"
  );
  assert.equal(
    (
      await runCampaignStaleCheck({
        profile: {
          customerPhone,
          marketingConsent: true,
          isOptedOut: true
        }
      })
    ).reason,
    "customer_opted_out"
  );
  assert.equal(
    (await runCampaignStaleCheck({ profile: null })).reason,
    "customer_profile_missing"
  );
  assert.equal(
    (
      await runCampaignStaleCheck({
        campaign: makeCampaign({ status: "cancelled" })
      })
    ).reason,
    "campaign_cancelled"
  );
  assert.equal(
    (
      await runCampaignStaleCheck({
        campaign: makeCampaign({ campaignVersion: 2 })
      })
    ).reason,
    "campaign_version_changed"
  );
});

test("send-time checks reject unavailable referenced items and keep lookups scoped", async () => {
  const unavailable = await runCampaignStaleCheck({
    campaign: makeCampaign({
      referencedMenuItemId: menuItemId
    }),
    referencedItemAvailable: false
  });

  assert.equal(
    unavailable.reason,
    "campaign_referenced_item_unavailable"
  );
  assert.equal(unavailable.filters.menu.restaurantId, restaurantId);

  const valid = await runCampaignStaleCheck();
  assert.equal(valid.reason, null);
  assert.equal(valid.filters.campaign.restaurantId, restaurantId);
  assert.equal(valid.filters.recipient.restaurantId, restaurantId);
  assert.equal(valid.filters.profile.restaurantId, restaurantId);
  assert.equal(valid.filters.restaurant._id, restaurantId);
});

const processQueuedCampaign = async ({
  campaign = makeCampaign(),
  profile = {
    customerPhone,
    marketingConsent: true,
    isOptedOut: false
  },
  sendResult = {
    success: true,
    status: 200,
    data: {
      id: "provider-message-1"
    }
  },
  attempts = 1,
  maxAttempts = 5
} = {}) => {
  const originals = {
    outboundFindOne: OutboundMessage.findOne,
    outboundFindOneAndUpdate: OutboundMessage.findOneAndUpdate,
    campaignFindOne: CustomerCampaign.findOne,
    campaignUpdateOne: CustomerCampaign.updateOne,
    recipientFindOne: CustomerCampaignRecipient.findOne,
    recipientFind: CustomerCampaignRecipient.find,
    recipientUpdateOne: CustomerCampaignRecipient.updateOne,
    profileFindOne: CustomerProfile.findOne,
    restaurantFindOne: Restaurant.findOne,
    menuExists: MenuItem.exists
  };
  const candidate = {
    _id: "64b000000000000000000b51",
    sessionId: "wasender-session-1",
    nextAttemptAt: new Date(0)
  };
  const locked = {
    ...candidate,
    restaurantId,
    to: customerPhone,
    type: "text",
    text: "Campaign Restaurant\n\nTry our weekend special.",
    status: "sending",
    attempts,
    maxAttempts,
    sessionId: "wasender-session-1",
    metadata: {
      kind: "customer_campaign",
      restaurantId,
      campaignId,
      campaignRecipientId: recipientId,
      campaignVersion: 1,
      customerPhone,
      consentSnapshotUpdatedAt:
        "2026-07-30T10:00:00.000Z",
      recipientType: "customer",
      purpose: "marketing"
    },
    async save() {
      return this;
    }
  };
  const recipient = makeRecipient({
    outboundMessageId: candidate._id
  });
  const recipientUpdates = [];
  let sendCount = 0;

  try {
    OutboundMessage.findOne = (filter) =>
      resolvedQuery(
        filter.status === "pending" ? candidate : null
      );
    OutboundMessage.findOneAndUpdate = () =>
      resolvedQuery(locked);
    CustomerCampaign.findOne = () => resolvedQuery(campaign);
    CustomerCampaign.updateOne = async () => ({
      modifiedCount: 1
    });
    CustomerCampaignRecipient.findOne = () =>
      resolvedQuery(recipient);
    CustomerCampaignRecipient.find = () =>
      resolvedQuery([recipient]);
    CustomerCampaignRecipient.updateOne = async (_filter, update) => {
      recipientUpdates.push(update);

      if (update.$set?.status) {
        recipient.status = update.$set.status;
      }

      return { modifiedCount: 1 };
    };
    CustomerProfile.findOne = () => resolvedQuery(profile);
    Restaurant.findOne = () =>
      resolvedQuery(makeRestaurant());
    MenuItem.exists = async () => ({ _id: menuItemId });

    const processed = await processNextQueuedWasenderMessage({
      sendMessage: async () => {
        sendCount += 1;
        return sendResult;
      }
    });

    return {
      locked,
      processed,
      recipient,
      recipientUpdates,
      sendCount
    };
  } finally {
    OutboundMessage.findOne = originals.outboundFindOne;
    OutboundMessage.findOneAndUpdate =
      originals.outboundFindOneAndUpdate;
    CustomerCampaign.findOne = originals.campaignFindOne;
    CustomerCampaign.updateOne = originals.campaignUpdateOne;
    CustomerCampaignRecipient.findOne =
      originals.recipientFindOne;
    CustomerCampaignRecipient.find = originals.recipientFind;
    CustomerCampaignRecipient.updateOne =
      originals.recipientUpdateOne;
    CustomerProfile.findOne = originals.profileFindOne;
    Restaurant.findOne = originals.restaurantFindOne;
    MenuItem.exists = originals.menuExists;
  }
};

test("valid unchanged campaign delivery marks the recipient sent only after provider success", async () => {
  const result = await processQueuedCampaign();

  assert.equal(result.processed, true);
  assert.equal(result.sendCount, 1);
  assert.equal(result.locked.status, "sent");
  assert.equal(result.recipient.status, "sent");
  assert.equal(
    result.recipientUpdates.some(
      (update) => update.$set?.status === "sent"
    ),
    true
  );
});

test("opt-out after approval cancels queued delivery without calling Wasender", async () => {
  const result = await processQueuedCampaign({
    profile: {
      customerPhone,
      marketingConsent: true,
      isOptedOut: true
    }
  });

  assert.equal(result.sendCount, 0);
  assert.equal(result.locked.status, "cancelled");
  assert.equal(result.recipient.status, "cancelled");
});

test("final provider failure records a recipient failure reason", async () => {
  const result = await processQueuedCampaign({
    sendResult: {
      success: false,
      status: 500,
      error: "provider unavailable"
    },
    attempts: 5,
    maxAttempts: 5
  });

  assert.equal(result.sendCount, 1);
  assert.equal(result.locked.status, "failed");
  assert.equal(result.recipient.status, "failed");
  const failureUpdate = result.recipientUpdates.find(
    (update) => update.$set?.status === "failed"
  );
  assert.match(failureUpdate.$set.failureReason, /provider unavailable/);
});

test("campaign aggregate counts and terminal status reflect recipient delivery audit", async () => {
  const originalCampaignFindOne = CustomerCampaign.findOne;
  const originalCampaignUpdateOne = CustomerCampaign.updateOne;
  const originalRecipientFind = CustomerCampaignRecipient.find;
  let capturedFilter;
  let capturedUpdate;

  try {
    CustomerCampaign.findOne = (filter) =>
      resolvedQuery({
        _id: campaignId,
        restaurantId,
        status: "sending"
      });
    CustomerCampaignRecipient.find = (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      assert.equal(filter.campaignId, campaignId);
      return resolvedQuery([
        { status: "sent", outboundMessageId: "queue-1" },
        { status: "failed", outboundMessageId: "queue-2" },
        { status: "cancelled", outboundMessageId: "queue-3" }
      ]);
    };
    CustomerCampaign.updateOne = async (filter, update) => {
      capturedFilter = filter;
      capturedUpdate = update;
      return { modifiedCount: 1 };
    };

    const aggregate = await updateCustomerCampaignAggregate(
      restaurantId,
      campaignId,
      now
    );

    assert.equal(aggregate.status, "partially_failed");
    assert.equal(aggregate.total, 3);
    assert.equal(aggregate.sent, 1);
    assert.equal(aggregate.failed, 1);
    assert.equal(aggregate.cancelled, 1);
    assert.equal(capturedFilter.restaurantId, restaurantId);
    assert.equal(capturedUpdate.$set.status, "partially_failed");
    assert.equal(capturedUpdate.$set.sentRecipientCount, 1);
    assert.equal(capturedUpdate.$set.failedRecipientCount, 1);
    assert.equal(capturedUpdate.$set.cancelledRecipientCount, 1);
    assert.equal(capturedUpdate.$set.completedAt, now);
  } finally {
    CustomerCampaign.findOne = originalCampaignFindOne;
    CustomerCampaign.updateOne = originalCampaignUpdateOne;
    CustomerCampaignRecipient.find = originalRecipientFind;
  }
});

test("campaign model indexes support scoped scheduling and unique recipient snapshots", () => {
  const campaignIndex = CustomerCampaign.schema
    .indexes()
    .find(
      ([fields]) =>
        fields.restaurantId === 1 &&
        fields.status === 1 &&
        fields.scheduledAt === 1
    );
  const recipientIndex = CustomerCampaignRecipient.schema
    .indexes()
    .find(
      ([fields, options]) =>
        fields.campaignId === 1 &&
        fields.customerPhone === 1 &&
        options.unique === true
    );

  assert.ok(campaignIndex);
  assert.ok(recipientIndex);
});

test("restaurant-scoped opt-in cannot alter another restaurant profile", async () => {
  const originalFindOne = CustomerProfile.findOne;
  const originalFindOneAndUpdate = CustomerProfile.findOneAndUpdate;
  const filters = [];

  try {
    CustomerProfile.findOne = async () => null;
    CustomerProfile.findOneAndUpdate = async (filter, update) => {
      filters.push(filter);
      return {
        ...filter,
        ...update.$set
      };
    };

    await setCustomerMarketingPreference(
      restaurantId,
      customerPhone,
      "opt_in",
      "customer_message",
      now
    );
    await setCustomerMarketingPreference(
      otherRestaurantId,
      customerPhone,
      "opt_in",
      "customer_message",
      now
    );

    assert.equal(filters[0].restaurantId, restaurantId);
    assert.equal(filters[1].restaurantId, otherRestaurantId);
    assert.equal(filters[0].customerPhone, customerPhone);
    assert.equal(filters[1].customerPhone, customerPhone);
  } finally {
    CustomerProfile.findOne = originalFindOne;
    CustomerProfile.findOneAndUpdate = originalFindOneAndUpdate;
  }
});
