const assert = require("node:assert/strict");
const test = require("node:test");

const { AgentConversationMessage } = require("../dist/models/agentConversation.model");
const { CustomerProfile } = require("../dist/models/customerProfile.model");
const { CustomerCampaignRecipient } = require("../dist/models/customerCampaignRecipient.model");
const { MenuItem } = require("../dist/models/MenuItem");
const { Order } = require("../dist/models/order.model");
const { OutboundMessage } = require("../dist/models/outboundMessage.model");
const { toolRegistry } = require("../dist/agent-tools/tool.registry");
const {
  buildCustomerCampaignPreviewMessage,
  formatCustomerCampaignMessage
} = require("../dist/services/customerCampaign.service");
const {
  buildMarketingConsentRequestMessage,
  getMarketingConsentRequestIdempotencyKey,
  getPendingMarketingConsentContext,
  isOrderEligibleForMarketingConsentPrompt,
  parseMarketingConsentResponse,
  queueMarketingConsentRequestAfterSuccessfulOrder
} = require("../dist/services/customerMarketingOnboarding.service");
const {
  handleCustomerMarketingPreferenceCommand
} = require("../dist/services/customerMarketingPreference.service");
const {
  getCustomerProfileStatistics
} = require("../dist/services/customerProfile.service");
const {
  getQueuedMarketingConsentRequestStaleReason,
  isTransactionalQueuedMessage,
  sendQueuedWasenderMessage
} = require("../dist/services/wasenderQueue.service");

const restaurantId = "64b000000000000000000c01";
const orderId = "64b000000000000000000c11";
const customerPhone = "+233557038547";
const now = new Date("2026-08-13T12:00:00.000Z");

const makeCompletedOrder = (overrides = {}) => ({
  _id: orderId,
  restaurantId,
  customerPhone,
  status: "completed",
  completionSource: "customer_confirmed",
  completionConfirmedByCustomer: true,
  ...overrides
});

test("first customer-confirmed successful order queues one consent request and records the prompt after queueing", async () => {
  const profile = {
    orderCount: 1,
    marketingConsent: null,
    isOptedOut: false
  };
  const events = [];
  const queuedMessages = [];
  const dependencies = {
    findProfile: async () => profile,
    findRestaurant: async () => ({
      name: "Golden Grill",
      status: "active",
      wasenderSessionId: "golden-session",
      wasenderApiToken: "golden-token"
    }),
    enqueueMessage: async (input) => {
      events.push("queued");
      queuedMessages.push(input);
      return { _id: "queue-consent-1" };
    },
    markPrompted: async (_filter, update) => {
      events.push("marked");
      profile.marketingConsentPromptedAt = update.$set.marketingConsentPromptedAt;
      profile.marketingConsentPromptOrderId = update.$set.marketingConsentPromptOrderId;
      return { modifiedCount: 1 };
    }
  };

  const first = await queueMarketingConsentRequestAfterSuccessfulOrder(
    makeCompletedOrder(),
    dependencies,
    now
  );
  const second = await queueMarketingConsentRequestAfterSuccessfulOrder(
    makeCompletedOrder({ _id: "64b000000000000000000c12" }),
    dependencies,
    new Date("2026-08-14T12:00:00.000Z")
  );

  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  assert.equal(second.reason, "already_prompted");
  assert.deepEqual(events, ["queued", "marked"]);
  assert.equal(queuedMessages.length, 1);
  assert.equal(profile.marketingConsent, null);
  assert.equal(
    queuedMessages[0].idempotencyKey,
    getMarketingConsentRequestIdempotencyKey(restaurantId, customerPhone)
  );
  assert.equal(
    queuedMessages[0].text,
    "Would you like Golden Grill to occasionally send you offers, discounts and new menu updates here on WhatsApp? You can stop them anytime."
  );
  assert.deepEqual(queuedMessages[0].metadata, {
    kind: "marketing_consent_request",
    purpose: "transactional_preference",
    restaurantId,
    customerPhone,
    orderId
  });
});

test("consent prompt failures before queueing never mark the profile as prompted", async () => {
  let promptMarks = 0;

  await assert.rejects(
    queueMarketingConsentRequestAfterSuccessfulOrder(
      makeCompletedOrder(),
      {
        findProfile: async () => ({
          orderCount: 1,
          marketingConsent: null,
          isOptedOut: false
        }),
        findRestaurant: async () => ({
          name: "Golden Grill",
          status: "active",
          wasenderSessionId: "golden-session",
          wasenderApiToken: "golden-token"
        }),
        enqueueMessage: async () => {
          throw new Error("queue unavailable");
        },
        markPrompted: async () => {
          promptMarks += 1;
          return { modifiedCount: 1 };
        }
      }
    ),
    /queue unavailable/
  );

  assert.equal(promptMarks, 0);
});

test("opted-in and opted-out profiles are never prompted", async () => {
  for (const [profile, expectedReason] of [
    [{ orderCount: 2, marketingConsent: true, isOptedOut: false }, "already_opted_in"],
    [{ orderCount: 2, marketingConsent: false, isOptedOut: true }, "already_opted_out"]
  ]) {
    let queued = 0;
    const result = await queueMarketingConsentRequestAfterSuccessfulOrder(
      makeCompletedOrder(),
      {
        findProfile: async () => profile,
        enqueueMessage: async () => {
          queued += 1;
          return {};
        }
      }
    );

    assert.equal(result.queued, false);
    assert.equal(result.reason, expectedReason);
    assert.equal(queued, 0);
  }
});

test("rejected, cancelled, automatic-timeout, and unconfirmed orders cannot prompt", () => {
  for (const order of [
    makeCompletedOrder({ status: "rejected" }),
    makeCompletedOrder({ status: "cancelled" }),
    makeCompletedOrder({
      completionSource: "automatic_timeout",
      completionConfirmedByCustomer: false
    }),
    makeCompletedOrder({
      status: "accepted",
      completionConfirmedByCustomer: false
    })
  ]) {
    assert.equal(isOrderEligibleForMarketingConsentPrompt(order), false);
  }
});

test("consent response parser accepts bounded natural answers only", () => {
  assert.deepEqual(parseMarketingConsentResponse("yes please"), {
    command: "opt_in",
    explicitlyMentionsMarketing: false
  });
  assert.deepEqual(parseMarketingConsentResponse("send me offers"), {
    command: "opt_in",
    explicitlyMentionsMarketing: true
  });
  assert.deepEqual(parseMarketingConsentResponse("no promotions"), {
    command: "opt_out",
    explicitlyMentionsMarketing: true
  });
  assert.equal(parseMarketingConsentResponse("yes, add two more"), null);
  assert.match(buildMarketingConsentRequestMessage("Golden Grill"), /Golden Grill/);
});

test("an intervening unrelated customer message closes the unquoted consent window", async () => {
  const originals = {
    profileFindOne: CustomerProfile.findOne,
    outboundFindOne: OutboundMessage.findOne,
    conversationExists: AgentConversationMessage.exists
  };
  const sentAt = new Date("2026-08-13T10:00:00.000Z");
  const outboundFilters = [];
  let conversationFilter;

  try {
    CustomerProfile.findOne = () => ({
      select: async () => ({
        marketingConsent: null,
        isOptedOut: false,
        marketingConsentPromptedAt: sentAt,
        marketingConsentPromptOrderId: orderId
      })
    });
    OutboundMessage.findOne = (filter) => {
      outboundFilters.push(filter);
      return {
        sort() {
          return this;
        },
        select: async () => ({ _id: "queue-consent-1", sentAt })
      };
    };
    AgentConversationMessage.exists = async (filter) => {
      conversationFilter = filter;
      return { _id: "unrelated-customer-message" };
    };

    const context = await getPendingMarketingConsentContext(
      restaurantId,
      customerPhone
    );

    assert.equal(context.pending, true);
    assert.equal(context.quotedRequest, false);
    assert.equal(context.genericResponseWindowOpen, false);
    assert.equal(outboundFilters[0].restaurantId, restaurantId);
    assert.equal(outboundFilters[0].to, customerPhone);
    assert.equal(conversationFilter.restaurantId, restaurantId);
    assert.equal(conversationFilter.senderPhone, customerPhone);
    assert.equal(conversationFilter.direction, "user");
    assert.deepEqual(conversationFilter.createdAt, { $gt: sentAt });
  } finally {
    CustomerProfile.findOne = originals.profileFindOne;
    OutboundMessage.findOne = originals.outboundFindOne;
    AgentConversationMessage.exists = originals.conversationExists;
  }
});

test("a just-sent consent request keeps the immediate unquoted generic window open", async () => {
  const originals = {
    profileFindOne: CustomerProfile.findOne,
    outboundFindOne: OutboundMessage.findOne,
    conversationExists: AgentConversationMessage.exists
  };
  const sentAt = new Date("2026-08-13T10:00:00.000Z");

  try {
    CustomerProfile.findOne = () => ({
      select: async () => ({
        marketingConsent: null,
        isOptedOut: false,
        marketingConsentPromptedAt: sentAt,
        marketingConsentPromptOrderId: orderId
      })
    });
    OutboundMessage.findOne = () => ({
      sort() {
        return this;
      },
      select: async () => ({ _id: "queue-consent-1", sentAt })
    });
    AgentConversationMessage.exists = async () => null;

    const context = await getPendingMarketingConsentContext(
      restaurantId,
      customerPhone
    );

    assert.equal(context.pending, true);
    assert.equal(context.genericResponseWindowOpen, true);
  } finally {
    CustomerProfile.findOne = originals.profileFindOne;
    OutboundMessage.findOne = originals.outboundFindOne;
    AgentConversationMessage.exists = originals.conversationExists;
  }
});

test("quoted consent reply remains trusted after the generic window closes", async () => {
  const originals = {
    profileFindOne: CustomerProfile.findOne,
    outboundFindOne: OutboundMessage.findOne,
    conversationExists: AgentConversationMessage.exists
  };
  const sentAt = new Date("2026-08-13T10:00:00.000Z");

  try {
    CustomerProfile.findOne = () => ({
      select: async () => ({
        marketingConsent: null,
        isOptedOut: false,
        marketingConsentPromptedAt: sentAt,
        marketingConsentPromptOrderId: orderId
      })
    });
    OutboundMessage.findOne = (filter) => ({
      sort() {
        return this;
      },
      select: async () => ({
        _id: filter.providerMessageId
          ? "quoted-consent-message"
          : "latest-consent-message",
        sentAt
      })
    });
    AgentConversationMessage.exists = async () => ({
      _id: "later-unrelated-message"
    });

    const context = await getPendingMarketingConsentContext(
      restaurantId,
      customerPhone,
      "provider-consent-1"
    );

    assert.equal(context.quotedRequest, true);
    assert.equal(context.genericResponseWindowOpen, false);
  } finally {
    CustomerProfile.findOne = originals.profileFindOne;
    OutboundMessage.findOne = originals.outboundFindOne;
    AgentConversationMessage.exists = originals.conversationExists;
  }
});

test("STOP then START preserves the hard opt-out boundary and re-enables future campaigns", async () => {
  const originals = {
    profileFindOne: CustomerProfile.findOne,
    profileFindOneAndUpdate: CustomerProfile.findOneAndUpdate,
    outboundUpdateMany: OutboundMessage.updateMany,
    recipientUpdateMany: CustomerCampaignRecipient.updateMany
  };
  const profile = {
    marketingConsent: true,
    isOptedOut: false
  };
  const outboundFilters = [];

  try {
    CustomerProfile.findOne = async () => profile;
    CustomerProfile.findOneAndUpdate = async (_filter, update) => {
      Object.assign(profile, update.$set);
      for (const field of Object.keys(update.$unset || {})) {
        delete profile[field];
      }
      return profile;
    };
    OutboundMessage.updateMany = async (filter) => {
      outboundFilters.push(filter);
      return { modifiedCount: 1 };
    };
    CustomerCampaignRecipient.updateMany = async () => ({ modifiedCount: 1 });

    await handleCustomerMarketingPreferenceCommand(
      restaurantId,
      customerPhone,
      "STOP",
      now
    );
    assert.equal(profile.marketingConsent, false);
    assert.equal(profile.isOptedOut, true);
    assert.equal(profile.optedOutSource, "customer_message");
    assert.ok(
      outboundFilters.some(
        (filter) =>
          filter["metadata.kind"] === "customer_campaign" &&
          filter.status === "pending"
      )
    );

    await handleCustomerMarketingPreferenceCommand(
      restaurantId,
      customerPhone,
      "START",
      new Date("2026-08-13T13:00:00.000Z")
    );
    assert.equal(profile.marketingConsent, true);
    assert.equal(profile.isOptedOut, false);
    assert.equal(profile.marketingConsentSource, "customer_message");
    assert.equal(profile.optedOutAt, undefined);
  } finally {
    CustomerProfile.findOne = originals.profileFindOne;
    CustomerProfile.findOneAndUpdate = originals.profileFindOneAndUpdate;
    OutboundMessage.updateMany = originals.outboundUpdateMany;
    CustomerCampaignRecipient.updateMany = originals.recipientUpdateMany;
  }
});

test("lifetime customer statistics are exact and restaurant scoped", async () => {
  const originalCountDocuments = CustomerProfile.countDocuments;
  const filters = [];

  try {
    CustomerProfile.countDocuments = async (filter) => {
      filters.push(filter);
      if (filter.orderCount?.$gte === 2) return 2;
      if (filter.orderCount?.$gte === 1) return 6;
      if (filter.marketingConsent === true) return 5;
      if (filter.isOptedOut === true) return 2;
      return 8;
    };

    const statistics = await getCustomerProfileStatistics(restaurantId);

    assert.deepEqual(statistics, {
      totalCustomers: 8,
      customersWithCompletedOrders: 6,
      returningCustomers: 2,
      marketingEligibleCustomers: 5,
      marketingNotOptedInCustomers: 1,
      marketingOptedOutCustomers: 2
    });
    assert.equal(filters.every((filter) => filter.restaurantId === restaurantId), true);
  } finally {
    CustomerProfile.countDocuments = originalCountDocuments;
  }
});

test("get_business_summary returns lifetime profile totals even with zero orders today", async () => {
  const originals = {
    orderFind: Order.find,
    itemCountDocuments: MenuItem.countDocuments,
    profileCountDocuments: CustomerProfile.countDocuments
  };

  try {
    Order.find = () => ({ select: async () => [] });
    MenuItem.countDocuments = async () => 0;
    CustomerProfile.countDocuments = async (filter) => {
      if (filter.orderCount?.$gte === 2) return 2;
      if (filter.orderCount?.$gte === 1) return 6;
      if (filter.marketingConsent === true) return 5;
      if (filter.isOptedOut === true) return 2;
      return 8;
    };

    const result = await toolRegistry.get_business_summary.handler(
      {},
      {
        restaurantId,
        restaurant: {
          _id: restaurantId,
          name: "Golden Grill",
          timezone: "Africa/Accra"
        },
        sender: {
          role: "owner",
          phone: "+233500000001",
          normalizedPhone: "+233500000001",
          verified: true
        },
        originalMessage: "How many customers do we have?"
      }
    );

    assert.equal(result.data.todayOrderCount, 0);
    assert.equal(result.data.totalCustomers, 8);
    assert.equal(result.data.marketingEligibleCustomers, 5);
    assert.equal(result.data.marketingOptedOutCustomers, 2);
    assert.equal(result.data.marketingNotOptedInCustomers, 1);
    assert.match(
      toolRegistry.get_business_summary.definition.description,
      /lifetime CustomerProfile counts/i
    );
  } finally {
    Order.find = originals.orderFind;
    MenuItem.countDocuments = originals.itemCountDocuments;
    CustomerProfile.countDocuments = originals.profileCountDocuments;
  }
});

test("campaign preview uses human-friendly backend audience counts", () => {
  const message = buildCustomerCampaignPreviewMessage(
    {
      name: "Chicken Salad Promotion",
      message: "Enjoy our delicious Chicken Salad! Fresh and tasty, order yours today.",
      timezone: "Africa/Accra"
    },
    {
      targetingDescription: "All customers",
      targetedProfiles: 8,
      estimatedEligibleRecipients: 5,
      excludedNoConsent: 1,
      excludedOptOut: 2,
      excludedInvalidPhone: 0,
      recipients: []
    }
  );

  assert.match(message, /Campaign Preview: Chicken Salad Promotion/);
  assert.match(message, /Customers in audience: 8/);
  assert.match(message, /Can receive promotions: 5/);
  assert.match(message, /Not opted in yet: 1/);
  assert.match(message, /Opted out: 2/);
  assert.match(message, /sent to 5 customers/);
  assert.match(message, /Send: As soon as approved/);
  assert.doesNotMatch(message, /Estimated eligible|Excluded without consent/);
  assert.doesNotMatch(message, /Invalid\/unreachable/);
});

test("scheduled campaign preview shows the restaurant-local send time before confirmation", () => {
  const message = buildCustomerCampaignPreviewMessage(
    {
      name: "Lunch Promotion",
      message: "Lunch is ready.",
      scheduledAt: new Date("2026-08-14T14:00:00.000Z"),
      timezone: "Africa/Accra"
    },
    {
      targetingDescription: "All customers",
      targetedProfiles: 8,
      estimatedEligibleRecipients: 5,
      excludedNoConsent: 1,
      excludedOptOut: 2,
      excludedInvalidPhone: 0,
      recipients: []
    }
  );

  assert.match(message, /Send: 2026-08-14 14:00 \(Africa\/Accra\)/);
  assert.match(message, /Would you like to confirm or cancel it\?/);
});

test("campaign delivery appends one restaurant-specific STOP footer", () => {
  const appended = formatCustomerCampaignMessage(
    "Golden Grill",
    "Weekend chicken offer."
  );
  const preserved = formatCustomerCampaignMessage(
    "Golden Grill",
    "Weekend chicken offer. Reply STOP anytime to stop promotions."
  );

  assert.match(
    appended,
    /Reply STOP to stop receiving promotions from Golden Grill\.$/
  );
  assert.equal((appended.match(/Reply STOP/gi) || []).length, 1);
  assert.equal((preserved.match(/Reply STOP/gi) || []).length, 1);
});

test("transactional delivery keeps its original body and receives no campaign footer", async () => {
  let deliveredText;
  const result = await sendQueuedWasenderMessage(
    {
      sessionId: "golden-session",
      to: customerPhone,
      type: "text",
      text: "Your receipt is ready.",
      metadata: {
        kind: "receipt_delivery",
        purpose: "transactional"
      }
    },
    {
      sendText: async (_sessionId, _to, text) => {
        deliveredText = text;
        return { success: true, status: 200 };
      }
    }
  );

  assert.equal(result.success, true);
  assert.equal(deliveredText, "Your receipt is ready.");
  assert.doesNotMatch(deliveredText, /Reply STOP/);
  assert.equal(isTransactionalQueuedMessage({ kind: "marketing_consent_request" }), true);
});

test("queued consent request becomes stale as soon as a preference is resolved", async () => {
  const originalFindOne = CustomerProfile.findOne;

  try {
    CustomerProfile.findOne = () => ({
      select: async () => ({
        marketingConsent: true,
        isOptedOut: false
      })
    });

    const reason = await getQueuedMarketingConsentRequestStaleReason(
      {
        restaurantId,
        customerPhone
      },
      customerPhone
    );

    assert.equal(reason, "marketing_preference_already_resolved");
  } finally {
    CustomerProfile.findOne = originalFindOne;
  }
});
