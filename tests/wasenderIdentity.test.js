const assert = require("node:assert/strict");
const test = require("node:test");

const { CustomerChannelIdentity } = require("../dist/models/customerChannelIdentity.model");
const { CustomerProfile } = require("../dist/models/customerProfile.model");
const { CustomerSession } = require("../dist/models/customerSession.model");
const { Order } = require("../dist/models/order.model");
const { Restaurant } = require("../dist/models/Restaurant");
const {
  normalizeIncomingWebhook,
  resolveWasenderPhoneFromLid,
  resolveWasenderUsername
} = require("../dist/services/wasender.service");
const {
  rememberWasenderCustomerIdentity,
  resolveWasenderCustomerIdentity
} = require("../dist/services/wasenderIdentity.service");
const { resolveSenderIdentity } = require("../dist/services/senderIdentity.service");
const {
  recordInboundCustomerTurn
} = require("../dist/services/orderDraft.service");
const {
  getCustomerProfile,
  rememberConfirmedCustomerName
} = require("../dist/services/customerProfile.service");
const {
  loadCustomerMemorySummary
} = require("../dist/services/customerMemory.service");
const {
  sendAgentReplyDirectly
} = require("../dist/controllers/wasender.controller");
const {
  normalizeGhanaPhone,
  normalizeWhatsappRecipient,
  normalizeWhatsappUsername
} = require("../dist/utils/phone.util");
const {
  handleCustomerMarketingPreferenceCommand
} = require("../dist/services/customerMarketingPreference.service");
const { CustomerCampaignRecipient } = require("../dist/models/customerCampaignRecipient.model");
const { OutboundMessage } = require("../dist/models/outboundMessage.model");
const {
  sendDocumentMessage,
  sendImageMessage
} = require("../dist/services/wasender.service");
const wasenderQueueService = require("../dist/services/wasenderQueue.service");
const {
  notifyCustomerOfConfirmedOrderAndSendReceipt,
  notifyCustomerOfRejectedOrder,
  notifyCustomerOfCancellationResolution
} = require("../dist/services/orderSideEffects.service");
const { cancelCustomerOrder } = require("../dist/services/order.service");
const {
  getCustomerIdentityFilter,
  isOrderOwnedByCustomer,
  resolveCurrentWhatsappRecipient,
  resolveCurrentWhatsappRecipientResult
} = require("../dist/services/customerIdentity.service");
const {
  ensureCustomerIdentityIndexes
} = require("../dist/models/customerIdentityIndexes");

const restaurantId = "64b000000000000000000901";
const otherRestaurantId = "64b000000000000000000902";
const customerPhone = "+233557038547";
const customerPhoneDigits = "233557038547";
const lid = "123456789@lid";
const username = "@aduamah.maxwell";

const makePayload = (key) => ({
  event: "messages.received",
  sessionId: "session-1",
  data: {
    messages: {
      key: {
        id: "message-1",
        fromMe: false,
        ...key
      },
      messageBody: "Hello",
      message: { conversation: "Hello" }
    }
  }
});

test("normal PN webhook keeps the legacy from field and exposes a canonical phone", () => {
  const webhook = normalizeIncomingWebhook(
    makePayload({
      remoteJid: `${customerPhoneDigits}@s.whatsapp.net`,
      cleanedSenderPn: customerPhoneDigits,
      addressingMode: "pn"
    })
  );

  assert.equal(webhook.from, customerPhoneDigits);
  assert.equal(webhook.senderPhone, customerPhone);
  assert.equal(webhook.senderPhoneSource, "cleanedSenderPn");
  assert.equal(webhook.senderLid, undefined);
  assert.equal(webhook.senderAddress, `${customerPhoneDigits}@s.whatsapp.net`);
  assert.equal(webhook.addressingMode, "pn");
});

test("LID plus cleaned sender phone uses the phone and remembers the LID mapping", async () => {
  const webhook = normalizeIncomingWebhook(
    makePayload({
      remoteJid: lid,
      senderLid: lid,
      cleanedSenderPn: customerPhoneDigits,
      addressingMode: "lid"
    })
  );
  const remembered = [];
  const identity = await resolveWasenderCustomerIdentity(
    restaurantId,
    webhook,
    "restaurant-token",
    {
      remember: async (...args) => {
        remembered.push(args);
        return { lid: args[1], phone: args[2] };
      }
    }
  );

  assert.equal(webhook.from, customerPhoneDigits);
  assert.equal(webhook.senderLid, lid);
  assert.equal(identity.customerPhone, customerPhone);
  assert.equal(identity.customerKey, `wasender:lid:${lid}`);
  assert.equal(identity.recipientAddress, customerPhone);
  assert.equal(identity.resolutionSource, "phone_field");
  assert.deepEqual(remembered, [[restaurantId, lid, customerPhone]]);
});

test("LID plus senderPn uses the trusted sender phone and remembers the mapping", async () => {
  const webhook = normalizeIncomingWebhook(
    makePayload({
      remoteJid: lid,
      senderLid: lid,
      senderPn: `${customerPhoneDigits}@s.whatsapp.net`,
      addressingMode: "lid"
    })
  );
  let remembered;
  const identity = await resolveWasenderCustomerIdentity(
    restaurantId,
    webhook,
    undefined,
    {
      remember: async (...args) => {
        remembered = args;
        return { lid: args[1], phone: args[2] };
      }
    }
  );

  assert.equal(webhook.senderPhoneSource, "senderPn");
  assert.equal(identity.customerPhone, customerPhone);
  assert.equal(identity.customerKey, `wasender:lid:${lid}`);
  assert.equal(identity.recipientAddress, customerPhone);
  assert.deepEqual(remembered, [restaurantId, lid, customerPhone]);
});

test("LID-only webhook resolves through an existing restaurant-scoped mapping", async () => {
  const webhook = normalizeIncomingWebhook(
    makePayload({ remoteJid: lid, senderLid: lid, addressingMode: "lid" })
  );
  let lookupCalled = false;
  const identity = await resolveWasenderCustomerIdentity(
    restaurantId,
    webhook,
    undefined,
    {
      findByLid: async (seenRestaurantId, seenLid) => {
        assert.equal(seenRestaurantId, restaurantId);
        assert.equal(seenLid, lid);
        return { lid, phone: customerPhone };
      },
      resolvePhoneFromLid: async () => {
        lookupCalled = true;
        return { success: false };
      }
    }
  );

  assert.equal(identity.customerPhone, customerPhone);
  assert.equal(identity.recipientAddress, customerPhone);
  assert.equal(identity.resolutionSource, "stored_mapping");
  assert.equal(lookupCalled, false);
});

test("LID-only webhook can use the documented WaSender PN lookup and persist it", async () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.WASENDER_API_URL;
  const requests = [];
  process.env.WASENDER_API_URL = "https://wasender.example";
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        success: true,
        data: { pn: `${customerPhoneDigits}@s.whatsapp.net` }
      })
    };
  };

  try {
    const providerResult = await resolveWasenderPhoneFromLid(lid, {
      apiKey: "restaurant-token"
    });
    assert.equal(providerResult.phone, customerPhone);
    assert.equal(requests[0].url, "https://wasender.example/api/pn-from-lid/123456789%40lid");
    assert.equal(requests[0].options.method, "GET");

    const webhook = normalizeIncomingWebhook(
      makePayload({ remoteJid: lid, senderLid: lid, addressingMode: "lid" })
    );
    const remembered = [];
    const identity = await resolveWasenderCustomerIdentity(
      restaurantId,
      webhook,
      "restaurant-token",
      {
        findByLid: async () => null,
        resolvePhoneFromLid: async () => providerResult,
        remember: async (...args) => {
          remembered.push(args);
          return { lid: args[1], phone: args[2] };
        }
      }
    );

    assert.equal(identity.customerPhone, customerPhone);
    assert.equal(identity.recipientAddress, customerPhone);
    assert.equal(identity.resolutionSource, "provider_lookup");
    assert.deepEqual(remembered, [[restaurantId, lid, customerPhone]]);
  } finally {
    global.fetch = originalFetch;
    if (originalApiUrl === undefined) {
      delete process.env.WASENDER_API_URL;
    } else {
      process.env.WASENDER_API_URL = originalApiUrl;
    }
  }
});

test("direct username webhook preserves the username as the customer address", async () => {
  const webhook = normalizeIncomingWebhook(
    makePayload({
      remoteJid: username,
      senderUsername: "aduamah.maxwell",
      addressingMode: "username"
    })
  );
  const identity = await resolveWasenderCustomerIdentity(
    restaurantId,
    webhook
  );

  assert.equal(webhook.from, username);
  assert.equal(webhook.senderPhone, undefined);
  assert.equal(webhook.senderUsername, username);
  assert.equal(identity.customerAddress, username);
  assert.equal(identity.customerKey, username);
  assert.equal(identity.recipientAddress, username);
  assert.equal(identity.resolutionSource, "username_field");
});

test("WaSender username lookup normalizes the documented response handle", async () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.WASENDER_API_URL;
  const requests = [];
  process.env.WASENDER_API_URL = "https://wasender.example";
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        success: true,
        data: { jid: lid, username: "aduamah.maxwell" }
      })
    };
  };

  try {
    const result = await resolveWasenderUsername(lid, {
      apiKey: "restaurant-token"
    });

    assert.equal(result.success, true);
    assert.equal(result.username, username);
    assert.equal(result.jid, lid);
    assert.equal(
      requests[0].url,
      "https://wasender.example/api/fetch-username/123456789%40lid"
    );
    assert.equal(requests[0].options.method, "GET");
  } finally {
    global.fetch = originalFetch;
    if (originalApiUrl === undefined) {
      delete process.env.WASENDER_API_URL;
    } else {
      process.env.WASENDER_API_URL = originalApiUrl;
    }
  }
});

test("LID-only webhook falls back to username when no phone is available", async () => {
  const webhook = normalizeIncomingWebhook(
    makePayload({ remoteJid: lid, senderLid: lid, addressingMode: "lid" })
  );
  const remembered = [];
  const identity = await resolveWasenderCustomerIdentity(
    restaurantId,
    webhook,
    "restaurant-token",
    {
      findByLid: async () => null,
      resolvePhoneFromLid: async () => ({ success: true, data: { pn: null } }),
      resolveUsername: async () => ({
        success: true,
        username,
        jid: lid
      }),
      remember: async (...args) => {
        remembered.push(args);
        return { lid: args[1], phone: args[2], username: args[3] };
      }
    }
  );

  assert.equal(identity.customerPhone, undefined);
  assert.equal(identity.customerKey, `wasender:lid:${lid}`);
  assert.equal(identity.customerAddress, username);
  assert.equal(identity.username, username);
  assert.equal(identity.recipientAddress, username);
  assert.equal(identity.addressingMode, "username");
  assert.equal(identity.resolutionSource, "provider_username_lookup");
  assert.deepEqual(remembered, [[restaurantId, lid, undefined, username]]);
  assert.equal(normalizeGhanaPhone(username), "");
});

test("phone and username normalization remain separate", () => {
  assert.equal(normalizeGhanaPhone(username), "");
  assert.equal(normalizeWhatsappRecipient(username), username);
  assert.equal(normalizeWhatsappUsername("WhatsApp:@Ada_Name.1"), "@ada_name.1");

  for (const invalid of [
    "@a",
    "@123456",
    "@john-doe",
    "@john+doe",
    `@${"a".repeat(36)}`,
    "aduamah.maxwell"
  ]) {
    assert.equal(normalizeWhatsappUsername(invalid), "", invalid);
  }
});

test("fresh username replaces a stale stored username for the same LID", async () => {
  const newUsername = "@maxwell.aduamah";
  const webhook = normalizeIncomingWebhook(
    makePayload({
      remoteJid: lid,
      senderLid: lid,
      senderUsername: newUsername,
      addressingMode: "lid"
    })
  );
  const remembered = [];
  const identity = await resolveWasenderCustomerIdentity(
    restaurantId,
    webhook,
    undefined,
    {
      findByLid: async () => ({ lid, username }),
      remember: async (...args) => {
        remembered.push(args);
        return { lid: args[1], username: args[3] };
      },
      resolvePhoneFromLid: async () => {
        throw new Error("fresh username must not require a phone lookup");
      }
    }
  );

  assert.equal(identity.customerAddress, newUsername);
  assert.equal(identity.resolutionSource, "username_field");
  assert.deepEqual(remembered, [[restaurantId, lid, undefined, newUsername]]);
});

test("mutable usernames and username reuse are reconciled by trusted LID within a tenant", async () => {
  const originalFindOne = CustomerChannelIdentity.findOne;
  const originalCreate = CustomerChannelIdentity.create;
  const originalUpdateMany = CustomerChannelIdentity.updateMany;
  const records = [];
  const makeRecord = (data) => {
    const record = {
      ...data,
      save: async function () {
        return this;
      }
    };
    records.push(record);
    return record;
  };

  try {
    CustomerChannelIdentity.findOne = async (filter) =>
      records.find(
        (record) =>
          String(record.restaurantId) === String(filter.restaurantId) &&
          record.provider === filter.provider &&
          record.channel === filter.channel &&
          record.lid === filter.lid
      ) ?? null;
    CustomerChannelIdentity.create = async (data) => makeRecord(data);
    CustomerChannelIdentity.updateMany = async (filter) => {
      let modifiedCount = 0;
      for (const record of records) {
        if (
          String(record.restaurantId) === String(filter.restaurantId) &&
          record.provider === filter.provider &&
          record.channel === filter.channel &&
          record.username === filter.username &&
          record.lid !== filter.lid.$ne
        ) {
          delete record.username;
          modifiedCount += 1;
        }
      }
      return { modifiedCount };
    };

    const lidA = "111111111@lid";
    const lidB = "222222222@lid";
    await rememberWasenderCustomerIdentity(restaurantId, lidA, undefined, "@old.name");
    await rememberWasenderCustomerIdentity(restaurantId, lidA, undefined, "@new.name");
    await rememberWasenderCustomerIdentity(restaurantId, lidB, undefined, "@old.name");

    assert.equal(records.find((record) => record.lid === lidA).username, "@new.name");
    assert.equal(records.find((record) => record.lid === lidB).username, "@old.name");
    assert.equal(records.filter((record) => record.username === "@old.name").length, 1);

    await rememberWasenderCustomerIdentity(otherRestaurantId, "333333333@lid", undefined, "@old.name");
    assert.equal(records.filter((record) => record.username === "@old.name").length, 2);
  } finally {
    CustomerChannelIdentity.findOne = originalFindOne;
    CustomerChannelIdentity.create = originalCreate;
    CustomerChannelIdentity.updateMany = originalUpdateMany;
  }
});

test("username customer STOP updates marketing preference without E.164 failure", async () => {
  const originalFindOne = CustomerProfile.findOne;
  const originalFindOneAndUpdate = CustomerProfile.findOneAndUpdate;
  const originalOutboundUpdateMany = OutboundMessage.updateMany;
  const originalRecipientUpdateMany = CustomerCampaignRecipient.updateMany;

  try {
    CustomerProfile.findOne = async () => null;
    CustomerProfile.findOneAndUpdate = async (filter, update) => ({
      restaurantId: filter.restaurantId,
      customerPhone: filter.customerPhone,
      ...update.$set
    });
    OutboundMessage.updateMany = async () => ({ modifiedCount: 0 });
    CustomerCampaignRecipient.updateMany = async () => ({ modifiedCount: 0 });

    const result = await handleCustomerMarketingPreferenceCommand(
      restaurantId,
      username,
      "STOP"
    );

    assert.equal(result.handled, true);
    assert.equal(result.command, "opt_out");
    assert.equal(result.profile.customerPhone, username);
  } finally {
    CustomerProfile.findOne = originalFindOne;
    CustomerProfile.findOneAndUpdate = originalFindOneAndUpdate;
    OutboundMessage.updateMany = originalOutboundUpdateMany;
    CustomerCampaignRecipient.updateMany = originalRecipientUpdateMany;
  }
});

test("username recipients can receive image and receipt document messages", async () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.WASENDER_API_URL;
  const bodies = [];
  process.env.WASENDER_API_URL = "https://wasender.example";
  global.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ success: true, data: { msgId: bodies.length } })
    };
  };

  try {
    await sendImageMessage("session-1", username, "https://example.com/menu.jpg", "Menu", {
      apiKey: "restaurant-token"
    });
    await sendDocumentMessage("session-1", username, "https://example.com/receipt.pdf", "Receipt", {
      apiKey: "restaurant-token"
    });

    assert.equal(bodies[0].to, username);
    assert.equal(bodies[0].imageUrl, "https://example.com/menu.jpg");
    assert.equal(bodies[1].to, username);
    assert.equal(bodies[1].documentUrl, "https://example.com/receipt.pdf");
  } finally {
    global.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.WASENDER_API_URL;
    else process.env.WASENDER_API_URL = originalApiUrl;
  }
});

test("username customer can create a persistent conversation and order identity", async () => {
  const originalSessionFindOne = CustomerSession.findOne;
  const originalSessionCreate = CustomerSession.create;
  let createdSession;

  try {
    CustomerSession.findOne = async () => null;
    CustomerSession.create = async (input) => {
      createdSession = { ...input, save: async function () { return this; } };
      return createdSession;
    };

    const session = await recordInboundCustomerTurn(
      restaurantId,
      username,
      "username-order-turn-1"
    );
    assert.equal(session.customerPhone, username);
    assert.equal(createdSession.customerPhone, username);

    const order = new Order({
      restaurantId,
      customerName: "Maxwell",
      customerPhone: username,
      items: [{
        menuItemId: "64b000000000000000000904",
        name: "Jollof",
        quantity: 1,
        unitPrice: 40,
        totalPrice: 40
      }],
      subtotal: 40,
      deliveryFee: 0,
      total: 40,
      orderType: "pickup",
      status: "awaiting_restaurant_confirmation",
      paymentMethod: "cash",
      paymentStatus: "unpaid",
      customerConfirmedAt: new Date()
    });
    assert.equal(order.validateSync(), undefined);
    assert.equal(order.customerPhone, username);
  } finally {
    CustomerSession.findOne = originalSessionFindOne;
    CustomerSession.create = originalSessionCreate;
  }
});

test("acceptance and rejection notifications keep the username recipient", async () => {
  const originalEnqueue = wasenderQueueService.enqueueWasenderMessage;
  const queued = [];
  const restaurant = {
    _id: restaurantId,
    name: "Golden Grill",
    wasenderSessionId: "session-1",
    wasenderApiToken: "restaurant-token"
  };
  const baseOrder = {
    _id: "64b000000000000000000905",
    orderNumber: "ORD-USERNAME-1",
    customerName: "Maxwell",
    customerPhone: username,
    status: "accepted",
    receiptUrl: "https://example.com/receipt.pdf",
    receiptGeneratedAt: new Date(),
    receiptSentAt: new Date(),
    save: async function () { return this; }
  };

  try {
    wasenderQueueService.enqueueWasenderMessage = async (input) => {
      queued.push(input);
      return { _id: `queued-${queued.length}`, status: "pending" };
    };

    await notifyCustomerOfConfirmedOrderAndSendReceipt(restaurant, baseOrder);
    await notifyCustomerOfRejectedOrder(restaurant, {
      ...baseOrder,
      _id: "64b000000000000000000906",
      status: "rejected",
      receiptSentAt: undefined
    });

    assert.equal(queued.length, 2);
    assert.equal(queued[0].to, username);
    assert.equal(queued[0].metadata.kind, "customer_order_confirmed_notification");
    assert.equal(queued[1].to, username);
    assert.equal(queued[1].metadata.kind, "customer_order_rejected_notification");
  } finally {
    wasenderQueueService.enqueueWasenderMessage = originalEnqueue;
  }
});

test("agent replies can be sent directly to a resolved WhatsApp username", async () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.WASENDER_API_URL;
  const requests = [];
  process.env.WASENDER_API_URL = "https://wasender.example";
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ success: true, data: { msgId: 1 } })
    };
  };

  try {
    await sendAgentReplyDirectly(
      "session-1",
      username,
      "Hello",
      { restaurantId, eventId: "message-username-1", action: "reply" },
      "restaurant-token"
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://wasender.example/api/send-message");
    assert.equal(JSON.parse(requests[0].options.body).to, username);
  } finally {
    global.fetch = originalFetch;
    if (originalApiUrl === undefined) {
      delete process.env.WASENDER_API_URL;
    } else {
      process.env.WASENDER_API_URL = originalApiUrl;
    }
  }
});

test("failed LID lookup remains LID-only without fabricating a customer phone", async () => {
  const webhook = normalizeIncomingWebhook(
    makePayload({ remoteJid: lid, senderLid: lid, addressingMode: "lid" })
  );
  const remembered = [];
  const identity = await resolveWasenderCustomerIdentity(
    restaurantId,
    webhook,
    undefined,
    {
      findByLid: async () => null,
      resolvePhoneFromLid: async () => ({ success: false, status: 404 }),
      resolveUsername: async () => ({ success: false, status: 404 }),
      remember: async (...args) => {
        remembered.push(args);
        return { lid: args[1] };
      }
    }
  );

  assert.equal(identity.customerPhone, undefined);
  assert.equal(identity.recipientAddress, undefined);
  assert.equal(identity.resolutionSource, "lid_only");
  assert.deepEqual(remembered, [[restaurantId, lid]]);
  assert.equal(normalizeGhanaPhone(lid), "");
});

test("mapped LID reuses the existing session, profile, and memory phone key", async () => {
  const webhook = normalizeIncomingWebhook(
    makePayload({ remoteJid: lid, senderLid: lid, addressingMode: "lid" })
  );
  const identity = await resolveWasenderCustomerIdentity(
    restaurantId,
    webhook,
    undefined,
    {
      findByLid: async () => ({ lid, phone: customerPhone }),
      resolvePhoneFromLid: async () => {
        throw new Error("provider lookup should not run");
      }
    }
  );
  const originalSessionFindOne = CustomerSession.findOne;
  const originalSessionCreate = CustomerSession.create;
  const originalProfileFindOne = CustomerProfile.findOne;
  const originalOrderFind = Order.find;
  let sessionCreateCalls = 0;
  const existingSession = {
    _id: "64b000000000000000000903",
    customerPhone,
    customerName: "Ama",
    cartItems: [],
    currentStep: "idle",
    orderType: null,
    deliveryFeeResolved: false,
    conversationVersion: 3,
    expiresAt: new Date(Date.now() + 60_000),
    save: async function () {
      return this;
    }
  };
  const existingProfile = {
    customerName: "Ama",
    orderCount: 1,
    frequentlyOrderedItems: [],
    dietaryPreferences: [],
    spicePreference: null,
    marketingConsent: null,
    isOptedOut: false
  };

  try {
    CustomerSession.findOne = async (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      assert.equal(filter.customerPhone, customerPhone);
      return existingSession;
    };
    CustomerSession.create = async () => {
      sessionCreateCalls += 1;
      return existingSession;
    };

    const session = await recordInboundCustomerTurn(
      restaurantId,
      identity.customerPhone,
      "lid-message-1"
    );
    assert.equal(session, existingSession);
    assert.equal(sessionCreateCalls, 0);

    CustomerProfile.findOne = async (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      assert.equal(filter.customerPhone, customerPhone);
      return existingProfile;
    };
    assert.equal(
      await getCustomerProfile(restaurantId, identity.customerPhone),
      existingProfile
    );

    CustomerProfile.findOne = (filter) => ({
      select: async () => {
        assert.equal(filter.customerPhone, customerPhone);
        return existingProfile;
      }
    });
    Order.find = (filter) => ({
      select() {
        assert.equal(filter.restaurantId, restaurantId);
        assert.equal(filter.customerPhone.$in.includes(customerPhone), true);
        return this;
      },
      sort() {
        return this;
      },
      limit: async () => []
    });
    const memory = await loadCustomerMemorySummary(
      restaurantId,
      identity.customerPhone
    );
    assert.equal(memory.name, "Ama");
    assert.equal(memory.completedOrderCount, 1);
  } finally {
    CustomerSession.findOne = originalSessionFindOne;
    CustomerSession.create = originalSessionCreate;
    CustomerProfile.findOne = originalProfileFindOne;
    Order.find = originalOrderFind;
  }
});

test("the same LID is isolated by restaurant", async () => {
  const webhook = normalizeIncomingWebhook(
    makePayload({ remoteJid: lid, senderLid: lid, addressingMode: "lid" })
  );
  const mappings = new Map([
    [`${restaurantId}:${lid}`, customerPhone],
    [`${otherRestaurantId}:${lid}`, "+233500000002"]
  ]);
  const dependencies = {
    findByLid: async (seenRestaurantId, seenLid) => ({
      lid: seenLid,
      phone: mappings.get(`${seenRestaurantId}:${seenLid}`)
    })
  };

  const restaurantA = await resolveWasenderCustomerIdentity(
    restaurantId,
    webhook,
    undefined,
    dependencies
  );
  const restaurantB = await resolveWasenderCustomerIdentity(
    otherRestaurantId,
    webhook,
    undefined,
    dependencies
  );

  assert.equal(restaurantA.customerPhone, customerPhone);
  assert.equal(restaurantB.customerPhone, "+233500000002");
  assert.notEqual(restaurantA.customerPhone, restaurantB.customerPhone);
});

test("provider identity indexes include the restaurant tenant boundary", () => {
  const indexes = CustomerChannelIdentity.schema.indexes();
  const lidIndex = indexes.find(([keys]) => keys.lid === 1);
  const phoneIndex = indexes.find(([keys]) => keys.phone === 1);
  const usernameIndex = indexes.find(([keys]) => keys.username === 1);

  for (const [keys, options] of [lidIndex, phoneIndex, usernameIndex]) {
    assert.equal(keys.restaurantId, 1);
    assert.equal(keys.provider, 1);
    assert.equal(keys.channel, 1);
    assert.equal(options.unique, true);
  }
});

test("an unresolved LID never receives owner or manager permissions", () => {
  const sender = resolveSenderIdentity(
    {
      ownerName: "Owner",
      ownerPhone: customerPhone,
      managerPhones: [""],
      managerContacts: [{ name: "Invalid", phone: "" }]
    },
    lid
  );

  assert.equal(sender.role, "customer");
  assert.equal(sender.verified, false);
  assert.equal(sender.normalizedPhone, "");
});

test("a username-only sender remains an unverified customer", () => {
  const sender = resolveSenderIdentity(
    {
      ownerName: "Owner",
      ownerPhone: customerPhone,
      managerPhones: ["+233500000001"],
      managerContacts: [{ name: "Manager", phone: "+233500000002" }]
    },
    username
  );

  assert.equal(sender.role, "customer");
  assert.equal(sender.verified, false);
  assert.equal(sender.normalizedPhone, username);
});

test("LID inbound resolves to a phone before the agent reply is sent", async () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.WASENDER_API_URL;
  const requests = [];
  process.env.WASENDER_API_URL = "https://wasender.example";
  global.fetch = async (url, options) => {
    requests.push({ url, options });

    if (url.includes("/api/pn-from-lid/")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({
          success: true,
          data: { pn: `${customerPhoneDigits}@s.whatsapp.net` }
        })
      };
    }

    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ success: true, data: { msgId: 1 } })
    };
  };

  try {
    const webhook = normalizeIncomingWebhook(
      makePayload({ remoteJid: lid, senderLid: lid, addressingMode: "lid" })
    );
    const identity = await resolveWasenderCustomerIdentity(
      restaurantId,
      webhook,
      "restaurant-token",
      {
        findByLid: async () => null,
        remember: async (_seenRestaurantId, seenLid, phone) => ({
          lid: seenLid,
          phone
        })
      }
    );

    assert.equal(identity.customerPhone, customerPhone);
    assert.equal(identity.recipientAddress, customerPhone);

    await sendAgentReplyDirectly(
      "session-1",
      identity.recipientAddress,
      "Hello",
      { restaurantId, eventId: "message-1", action: "reply" },
      "restaurant-token"
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "https://wasender.example/api/send-message");
    assert.equal(JSON.parse(requests[1].options.body).to, customerPhone);
  } finally {
    global.fetch = originalFetch;
    if (originalApiUrl === undefined) {
      delete process.env.WASENDER_API_URL;
    } else {
      process.env.WASENDER_API_URL = originalApiUrl;
    }
  }
});

test("same LID keeps one active cart and conversation chain after username changes", async () => {
  const lidValue = "111111111@lid";
  const oldUsername = "@old.name";
  const newUsername = "@new.name";
  const mappings = new Map();
  const sessions = [];
  const originalFindOne = CustomerSession.findOne;
  const originalCreate = CustomerSession.create;
  const dependencies = {
    findByLid: async () => mappings.get(lidValue) ?? null,
    remember: async (_restaurantId, seenLid, phone, seenUsername) => {
      const record = {
        lid: seenLid,
        ...(phone ? { phone } : {}),
        ...(seenUsername ? { username: seenUsername } : {})
      };
      mappings.set(seenLid, record);
      return record;
    },
    resolvePhoneFromLid: async () => ({ success: false }),
    resolveUsername: async () => ({ success: false })
  };
  const matches = (session, filter) => {
    if (String(session.restaurantId) !== String(filter.restaurantId)) return false;
    if (filter.customerKey) return session.customerKey === filter.customerKey;
    if (filter.$or) {
      return filter.$or.some((condition) =>
        condition.customerKey
          ? session.customerKey === condition.customerKey
          : !session.customerKey && session.customerPhone === condition.customerPhone
      );
    }
    return session.customerPhone === filter.customerPhone;
  };

  try {
    CustomerSession.findOne = async (filter) =>
      sessions.find((session) => matches(session, filter)) ?? null;
    CustomerSession.create = async (input) => {
      const session = {
        _id: `session-${sessions.length + 1}`,
        ...input,
        save: async function () { return this; }
      };
      sessions.push(session);
      return session;
    };

    const firstIdentity = await resolveWasenderCustomerIdentity(
      restaurantId,
      normalizeIncomingWebhook(makePayload({
        remoteJid: lidValue,
        senderLid: lidValue,
        senderUsername: oldUsername,
        addressingMode: "lid"
      })),
      undefined,
      dependencies
    );
    const firstTurn = await recordInboundCustomerTurn(
      restaurantId,
      firstIdentity.recipientAddress,
      "turn-1",
      undefined,
      firstIdentity.customerKey
    );
    firstTurn.cartItems.push({ name: "Jollof", quantity: 2 });
    firstTurn.currentStep = "choosing_items";
    await firstTurn.save();

    const secondIdentity = await resolveWasenderCustomerIdentity(
      restaurantId,
      normalizeIncomingWebhook(makePayload({
        remoteJid: lidValue,
        senderLid: lidValue,
        senderUsername: newUsername,
        addressingMode: "lid"
      })),
      undefined,
      dependencies
    );
    const secondTurn = await recordInboundCustomerTurn(
      restaurantId,
      secondIdentity.recipientAddress,
      "turn-2",
      undefined,
      secondIdentity.customerKey
    );

    assert.equal(firstIdentity.customerKey, "wasender:lid:111111111@lid");
    assert.equal(secondIdentity.customerKey, firstIdentity.customerKey);
    assert.equal(secondTurn, firstTurn);
    assert.equal(sessions.length, 1);
    assert.equal(secondTurn.customerPhone, newUsername);
    assert.equal(secondTurn.cartItems[0].quantity, 2);
    assert.equal(secondTurn.conversationVersion, 2);
  } finally {
    CustomerSession.findOne = originalFindOne;
    CustomerSession.create = originalCreate;
  }
});

test("same LID updates one profile instead of creating a username-keyed duplicate", async () => {
  const customerKey = "wasender:lid:111111111@lid";
  const profiles = [];
  const originalFindOne = CustomerProfile.findOne;
  const originalCreate = CustomerProfile.create;
  const matches = (profile, filter) => {
    if (String(profile.restaurantId) !== String(filter.restaurantId)) return false;
    if (filter.customerKey) return profile.customerKey === filter.customerKey;
    if (filter.$or) {
      return filter.$or.some((condition) =>
        condition.customerKey
          ? profile.customerKey === condition.customerKey
          : !profile.customerKey && profile.customerPhone === condition.customerPhone
      );
    }
    return profile.customerPhone === filter.customerPhone;
  };

  try {
    CustomerProfile.findOne = async (filter) =>
      profiles.find((profile) => matches(profile, filter)) ?? null;
    CustomerProfile.create = async (input) => {
      const profile = {
        ...input,
        save: async function () { return this; }
      };
      profiles.push(profile);
      return profile;
    };

    const first = await rememberConfirmedCustomerName(
      restaurantId,
      "@old.name",
      "Maxwell",
      customerKey
    );
    const second = await rememberConfirmedCustomerName(
      restaurantId,
      "@new.name",
      "Maxwell",
      customerKey
    );

    assert.equal(second, first);
    assert.equal(profiles.length, 1);
    assert.equal(second.customerKey, customerKey);
    assert.equal(second.customerPhone, "@new.name");
  } finally {
    CustomerProfile.findOne = originalFindOne;
    CustomerProfile.create = originalCreate;
  }
});

test("stable order ownership survives a username change and blocks username reuse", async () => {
  const orderId = "64b000000000000000000990";
  const keyA = "wasender:lid:111111111@lid";
  const keyB = "wasender:lid:222222222@lid";
  const order = {
    _id: orderId,
    restaurantId,
    customerKey: keyA,
    customerPhone: "@old.name",
    status: "pending",
    feedbackFollowUpStatus: "not_scheduled"
  };
  const originalFindOne = Order.findOne;
  const originalFindOneAndUpdate = Order.findOneAndUpdate;

  try {
    Order.findOne = async () => order;
    Order.findOneAndUpdate = async (_filter, update) => {
      Object.assign(order, update.$set);
      return order;
    };

    const result = await cancelCustomerOrder(
      restaurantId,
      orderId,
      "@new.name",
      keyA
    );
    assert.equal(result.order.status, "cancelled");
    assert.equal(isOrderOwnedByCustomer(order, "@old.name", keyB), false);
  } finally {
    Order.findOne = originalFindOne;
    Order.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("acceptance, rejection, and receipt delivery resolve the latest username", async () => {
  const customerKey = "wasender:lid:111111111@lid";
  const oldUsername = "@old.name";
  const newUsername = "@new.name";
  const originalIdentityFindOne = CustomerChannelIdentity.findOne;
  const originalProfileFindOne = CustomerProfile.findOne;
  const originalEnqueue = wasenderQueueService.enqueueWasenderMessage;
  const queued = [];
  const restaurant = {
    _id: restaurantId,
    name: "Golden Grill",
    wasenderSessionId: "session-1",
    wasenderApiToken: "restaurant-token"
  };
  const makeOrder = (id, status) => ({
    _id: id,
    restaurantId,
    orderNumber: `ORD-${id.slice(-3)}`,
    customerName: "Maxwell",
    customerKey,
    customerPhone: oldUsername,
    status,
    receiptUrl: "https://example.com/receipt.pdf",
    receiptGeneratedAt: new Date(),
    save: async function () { return this; }
  });

  try {
    CustomerChannelIdentity.findOne = () => ({
      select: async () => ({ lid: "111111111@lid", username: newUsername })
    });
    CustomerProfile.findOne = () => ({ select: async () => null });
    wasenderQueueService.enqueueWasenderMessage = async (input) => {
      queued.push(input);
      return { _id: `queued-${queued.length}`, status: "pending" };
    };

    await notifyCustomerOfConfirmedOrderAndSendReceipt(
      restaurant,
      makeOrder("64b000000000000000000991", "accepted")
    );
    await notifyCustomerOfRejectedOrder(
      restaurant,
      makeOrder("64b000000000000000000992", "rejected")
    );

    assert.deepEqual(
      queued
        .filter((message) => [
          "customer_order_confirmed_notification",
          "receipt_delivery",
          "customer_order_rejected_notification"
        ].includes(message.metadata.kind))
        .map((message) => message.to),
      [newUsername, newUsername, newUsername]
    );
  } finally {
    CustomerChannelIdentity.findOne = originalIdentityFindOne;
    CustomerProfile.findOne = originalProfileFindOne;
    wasenderQueueService.enqueueWasenderMessage = originalEnqueue;
  }
});

test("stable identity schema indexes are additive, partial, and tenant scoped", () => {
  for (const model of [CustomerSession, CustomerProfile]) {
    const [keys, options] = model.schema.indexes().find(
      ([indexKeys]) =>
        indexKeys.restaurantId === 1 &&
        indexKeys.customerKey === 1 &&
        Object.keys(indexKeys).length === 2
    );
    assert.equal(keys.restaurantId, 1);
    assert.equal(options.unique, true);
    assert.deepEqual(options.partialFilterExpression, {
      customerKey: { $type: "string" }
    });

    const obsoleteUniqueRecipientIndex = model.schema.indexes().find(
      ([indexKeys, indexOptions]) =>
        indexKeys.restaurantId === 1 &&
        indexKeys.customerPhone === 1 &&
        Object.keys(indexKeys).length === 2 &&
        indexOptions.unique === true
    );
    assert.equal(obsoleteUniqueRecipientIndex, undefined);

    const recipientLookupIndex = model.schema.indexes().find(
      ([indexKeys]) =>
        indexKeys.restaurantId === 1 &&
        indexKeys.customerPhone === 1 &&
        indexKeys.customerKey === 1
    );
    assert.equal(recipientLookupIndex[1].unique, undefined);
  }

  const orderIndex = Order.schema.indexes().find(
    ([indexKeys]) => indexKeys.customerKey === 1
  );
  assert.equal(orderIndex[0].restaurantId, 1);
  assert.equal(orderIndex[1].unique, undefined);
});

test("current recipient lookup is tenant scoped and never falls back to a stale username", async () => {
  const originalFindOne = CustomerChannelIdentity.findOne;
  const seenFilters = [];

  try {
    CustomerChannelIdentity.findOne = (filter) => ({
      select: async () => {
        seenFilters.push(filter);
        return String(filter.restaurantId) === restaurantId
          ? { username: "@current.name" }
          : null;
      }
    });

    assert.equal(
      await resolveCurrentWhatsappRecipient({
        restaurantId,
        customerKey: "wasender:lid:111111111@lid",
        fallbackAddress: "@old.name"
      }),
      "@current.name"
    );
    assert.equal(
      await resolveCurrentWhatsappRecipient({
        restaurantId: otherRestaurantId,
        customerKey: "wasender:lid:111111111@lid",
        fallbackAddress: "@tenant.two"
      }),
      ""
    );
    assert.equal(
      await resolveCurrentWhatsappRecipient({
        restaurantId,
        fallbackAddress: customerPhone
      }),
      customerPhone
    );
    assert.equal(seenFilters[0].restaurantId, restaurantId);
    assert.equal(seenFilters[1].restaurantId, otherRestaurantId);
  } finally {
    CustomerChannelIdentity.findOne = originalFindOne;
  }
});

test("stable LID lookup uses legacy fallback for phones but never for usernames", () => {
  const customerKey = "wasender:lid:222222222@lid";

  assert.deepEqual(
    getCustomerIdentityFilter(restaurantId, "@old.name", customerKey),
    { restaurantId, customerKey }
  );
  assert.deepEqual(
    getCustomerIdentityFilter(restaurantId, customerPhone, customerKey),
    {
      restaurantId,
      $or: [
        { customerKey },
        {
          customerKey: { $exists: false },
          customerPhone
        }
      ]
    }
  );
});

test("trusted LID plus phone can safely backfill legacy session and profile records", async () => {
  const customerKey = "wasender:lid:333333333@lid";
  const originalSessionFindOne = CustomerSession.findOne;
  const originalSessionCreate = CustomerSession.create;
  const originalProfileFindOne = CustomerProfile.findOne;
  const originalProfileCreate = CustomerProfile.create;
  const legacySession = {
    restaurantId,
    customerPhone,
    cartItems: [{ name: "Waakye", quantity: 1 }],
    currentStep: "choosing_items",
    orderType: null,
    deliveryFeeResolved: false,
    conversationVersion: 2,
    expiresAt: new Date(Date.now() + 60_000),
    save: async function () { return this; }
  };
  const legacyProfile = {
    restaurantId,
    customerPhone,
    customerName: "Ama",
    customerNameSource: "customer_confirmed",
    save: async function () { return this; }
  };

  try {
    CustomerSession.findOne = async (filter) => {
      assert.equal(filter.$or[1].customerPhone, customerPhone);
      return legacySession;
    };
    CustomerSession.create = async () => {
      throw new Error("legacy phone session should be reused");
    };
    CustomerProfile.findOne = async (filter) => {
      assert.equal(filter.$or[1].customerPhone, customerPhone);
      return legacyProfile;
    };
    CustomerProfile.create = async () => {
      throw new Error("legacy phone profile should be reused");
    };

    const session = await recordInboundCustomerTurn(
      restaurantId,
      customerPhone,
      "legacy-phone-turn",
      undefined,
      customerKey
    );
    const profile = await rememberConfirmedCustomerName(
      restaurantId,
      customerPhone,
      "Ama",
      customerKey
    );

    assert.equal(session, legacySession);
    assert.equal(session.customerKey, customerKey);
    assert.equal(session.cartItems[0].name, "Waakye");
    assert.equal(profile, legacyProfile);
    assert.equal(profile.customerKey, customerKey);
  } finally {
    CustomerSession.findOne = originalSessionFindOne;
    CustomerSession.create = originalSessionCreate;
    CustomerProfile.findOne = originalProfileFindOne;
    CustomerProfile.create = originalProfileCreate;
  }
});

test("customer identity index migration is inspected and idempotent", async () => {
  const makeCollection = (legacyName) => {
    let indexes = [
      { name: "_id_", key: { _id: 1 } },
      {
        name: legacyName,
        key: { restaurantId: 1, customerPhone: 1 },
        unique: true
      }
    ];
    const dropped = [];

    return {
      dropped,
      createIndex: async (key, options = {}) => {
        const existing = indexes.find(
          (index) => JSON.stringify(index.key) === JSON.stringify(key)
        );
        if (!existing) {
          indexes.push({
            name:
              options.name ||
              Object.entries(key).map(([field, value]) => `${field}_${value}`).join("_"),
            key: { ...key },
            ...(options.unique ? { unique: true } : {}),
            ...(options.partialFilterExpression
              ? { partialFilterExpression: options.partialFilterExpression }
              : {})
          });
        }
        return options.name || "created";
      },
      indexes: async () => indexes.map((index) => ({ ...index })),
      dropIndex: async (name) => {
        dropped.push(name);
        indexes = indexes.filter((index) => index.name !== name);
      }
    };
  };
  const sessionCollection = makeCollection("legacy_session_phone_unique");
  const profileCollection = makeCollection("custom_profile_phone_constraint");

  await ensureCustomerIdentityIndexes({ sessionCollection, profileCollection });
  await ensureCustomerIdentityIndexes({ sessionCollection, profileCollection });

  for (const [collection, legacyName, lookupName] of [
    [sessionCollection, "legacy_session_phone_unique", "customer_session_recipient_lookup"],
    [profileCollection, "custom_profile_phone_constraint", "customer_profile_recipient_lookup"]
  ]) {
    const indexes = await collection.indexes();
    assert.deepEqual(collection.dropped, [legacyName]);
    assert.equal(indexes.some((index) => index.name === legacyName), false);
    assert.equal(indexes.some((index) => index.name === lookupName), true);
    assert.equal(
      indexes.some((index) =>
        index.unique === true &&
        index.key.restaurantId === 1 &&
        index.key.customerKey === 1
      ),
      true
    );
  }
});

test("reassigned username cannot claim legacy state or receive the original customer's order", async () => {
  const keyA = "wasender:lid:111111111@lid";
  const keyB = "wasender:lid:222222222@lid";
  const oldUsername = "@old.name";
  const legacySessionA = {
    _id: "legacy-session-a",
    restaurantId,
    customerPhone: oldUsername,
    cartItems: [{ name: "A's Jollof", quantity: 2 }],
    currentStep: "choosing_items",
    orderType: null,
    deliveryFeeResolved: false,
    conversationVersion: 4,
    expiresAt: new Date(Date.now() + 60_000),
    save: async function () { return this; }
  };
  const legacyProfileA = {
    restaurantId,
    customerPhone: oldUsername,
    customerName: "Customer A",
    customerNameSource: "customer_confirmed",
    save: async function () { return this; }
  };
  const sessions = [legacySessionA];
  const profiles = [legacyProfileA];
  const queued = [];
  const originalSessionFindOne = CustomerSession.findOne;
  const originalSessionCreate = CustomerSession.create;
  const originalProfileFindOne = CustomerProfile.findOne;
  const originalProfileCreate = CustomerProfile.create;
  const originalIdentityFindOne = CustomerChannelIdentity.findOne;
  const originalEnqueue = wasenderQueueService.enqueueWasenderMessage;
  const orderA = {
    _id: "64b000000000000000000995",
    restaurantId,
    orderNumber: "ORD-995",
    customerKey: keyA,
    customerPhone: oldUsername,
    customerName: "Customer A",
    status: "accepted",
    receiptUrl: "https://example.com/a-receipt.pdf",
    receiptGeneratedAt: new Date(),
    save: async function () { return this; }
  };
  const restaurant = {
    _id: restaurantId,
    name: "Golden Grill",
    wasenderSessionId: "session-1",
    wasenderApiToken: "restaurant-token"
  };

  try {
    CustomerSession.findOne = async (filter) =>
      sessions.find((session) =>
        filter.customerKey && session.customerKey === filter.customerKey
      ) ?? null;
    CustomerSession.create = async (input) => {
      const session = {
        _id: "session-b",
        ...input,
        save: async function () { return this; }
      };
      sessions.push(session);
      return session;
    };
    CustomerProfile.findOne = async (filter) =>
      profiles.find((profile) =>
        filter.customerKey && profile.customerKey === filter.customerKey
      ) ?? null;
    CustomerProfile.create = async (input) => {
      const profile = {
        ...input,
        save: async function () { return this; }
      };
      profiles.push(profile);
      return profile;
    };
    CustomerChannelIdentity.findOne = (filter) => ({
      select: async () => {
        assert.equal(filter.restaurantId, restaurantId);
        assert.equal(filter.lid, "111111111@lid");
        return { lid: "111111111@lid" };
      }
    });
    wasenderQueueService.enqueueWasenderMessage = async (input) => {
      queued.push(input);
      return { _id: `queued-${queued.length}`, status: "pending" };
    };

    const sessionB = await recordInboundCustomerTurn(
      restaurantId,
      oldUsername,
      "b-turn-1",
      "Customer B",
      keyB
    );
    const profileB = await rememberConfirmedCustomerName(
      restaurantId,
      oldUsername,
      "Customer B",
      keyB
    );
    const result = await notifyCustomerOfConfirmedOrderAndSendReceipt(
      restaurant,
      orderA
    );

    assert.notEqual(sessionB, legacySessionA);
    assert.equal(sessionB.customerKey, keyB);
    assert.deepEqual(sessionB.cartItems, []);
    assert.notEqual(profileB, legacyProfileA);
    assert.equal(profileB.customerKey, keyB);
    assert.equal(isOrderOwnedByCustomer(orderA, oldUsername, keyB), false);
    assert.equal(queued.length, 0);
    assert.equal(result.customerNotification, "failed");
    assert.equal(result.receiptDelivery, "failed");
  } finally {
    CustomerSession.findOne = originalSessionFindOne;
    CustomerSession.create = originalSessionCreate;
    CustomerProfile.findOne = originalProfileFindOne;
    CustomerProfile.create = originalProfileCreate;
    CustomerChannelIdentity.findOne = originalIdentityFindOne;
    wasenderQueueService.enqueueWasenderMessage = originalEnqueue;
  }
});

test("stale username suppresses acceptance, receipt, rejection, and cancellation delivery", async () => {
  const customerKey = "wasender:lid:111111111@lid";
  const originalIdentityFindOne = CustomerChannelIdentity.findOne;
  const originalEnqueue = wasenderQueueService.enqueueWasenderMessage;
  const queued = [];
  const restaurant = {
    _id: restaurantId,
    name: "Golden Grill",
    wasenderSessionId: "session-1",
    wasenderApiToken: "restaurant-token"
  };
  const makeOrder = (id, status) => ({
    _id: id,
    restaurantId,
    orderNumber: `ORD-${id.slice(-3)}`,
    customerName: "Customer A",
    customerKey,
    customerPhone: "@old.name",
    status,
    receiptUrl: "https://example.com/receipt.pdf",
    receiptGeneratedAt: new Date(),
    customerCancellationRequestStatus: "approved",
    save: async function () { return this; }
  });

  try {
    CustomerChannelIdentity.findOne = () => ({
      select: async () => ({ lid: "111111111@lid" })
    });
    wasenderQueueService.enqueueWasenderMessage = async (input) => {
      queued.push(input);
      return { _id: `queued-${queued.length}`, status: "pending" };
    };

    const accepted = await notifyCustomerOfConfirmedOrderAndSendReceipt(
      restaurant,
      makeOrder("64b000000000000000000996", "accepted")
    );
    const rejected = await notifyCustomerOfRejectedOrder(
      restaurant,
      makeOrder("64b000000000000000000997", "rejected")
    );
    const cancellation = await notifyCustomerOfCancellationResolution(
      restaurant,
      makeOrder("64b000000000000000000998", "cancelled")
    );

    assert.equal(queued.length, 0);
    assert.equal(accepted.customerNotification, "failed");
    assert.equal(accepted.receiptDelivery, "failed");
    assert.equal(rejected.customerNotification, "failed");
    assert.equal(cancellation.customerNotification, "failed");
  } finally {
    CustomerChannelIdentity.findOne = originalIdentityFindOne;
    wasenderQueueService.enqueueWasenderMessage = originalEnqueue;
  }
});

test("queued customer messages verify usernames at send time and reject stale stored usernames", async () => {
  const originalFindOne = CustomerChannelIdentity.findOne;
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.WASENDER_API_URL;
  const customerKey = "wasender:lid:111111111@lid";
  let currentIdentity = { username: "@new.name" };
  let providerUsername = "new.name";

  try {
    process.env.WASENDER_API_URL = "https://wasender.example";
    global.fetch = async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer restaurant-token");
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({
          success: true,
          data: providerUsername
            ? { jid: "111111111@lid", username: providerUsername }
            : {}
        })
      };
    };
    CustomerChannelIdentity.findOne = (filter) => ({
      select: async () => {
        assert.equal(filter.restaurantId, restaurantId);
        assert.equal(filter.lid, "111111111@lid");
        return currentIdentity;
      }
    });
    const queued = {
      to: "@old.name",
      apiKey: "restaurant-token",
      metadata: { restaurantId, customerKey, kind: "receipt_delivery" }
    };
    const refreshed = await wasenderQueueService.refreshQueuedCustomerRecipient(queued);

    assert.equal(refreshed.safe, true);
    assert.equal(queued.to, "@new.name");

    currentIdentity = {};
    providerUsername = "";
    queued.to = "@old.name";
    const stale = await wasenderQueueService.refreshQueuedCustomerRecipient(queued);
    assert.equal(stale.safe, false);
    assert.equal(stale.reason, "no_current_whatsapp_recipient");
  } finally {
    CustomerChannelIdentity.findOne = originalFindOne;
    global.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.WASENDER_API_URL;
    else process.env.WASENDER_API_URL = originalApiUrl;
  }
});

test("LID recipient resolution prefers a current phone and reports stale usernames", async () => {
  const originalFindOne = CustomerChannelIdentity.findOne;

  try {
    CustomerChannelIdentity.findOne = () => ({
      select: async () => ({ phone: customerPhone, username: "@new.name" })
    });
    const phoneResult = await resolveCurrentWhatsappRecipientResult({
      restaurantId,
      customerKey: "wasender:lid:111111111@lid",
      fallbackAddress: "@old.name"
    });
    assert.deepEqual(phoneResult, {
      recipient: customerPhone,
      resolved: true,
      reason: "current_phone"
    });

    CustomerChannelIdentity.findOne = () => ({ select: async () => null });
    const staleResult = await resolveCurrentWhatsappRecipientResult({
      restaurantId,
      customerKey: "wasender:lid:111111111@lid",
      fallbackAddress: "@old.name"
    });
    assert.deepEqual(staleResult, {
      resolved: false,
      reason: "stale_username"
    });
  } finally {
    CustomerChannelIdentity.findOne = originalFindOne;
  }
});

test("provider verification replaces a stored LID username in the same tenant", async () => {
  const originalFindOne = CustomerChannelIdentity.findOne;
  const remembered = [];

  try {
    CustomerChannelIdentity.findOne = (filter) => ({
      select: async () => {
        assert.equal(filter.restaurantId, restaurantId);
        assert.equal(filter.provider, "wasender");
        assert.equal(filter.channel, "whatsapp");
        assert.equal(filter.lid, "111111111@lid");
        return { username: "@old.name" };
      }
    });

    const result = await resolveCurrentWhatsappRecipientResult(
      {
        restaurantId,
        customerKey: "wasender:lid:111111111@lid",
        fallbackAddress: "@old.name",
        apiKey: "restaurant-token",
        verifyUsername: true
      },
      {
        resolveUsername: async (_lid, options) => {
          assert.equal(options.apiKey, "restaurant-token");
          return {
            success: true,
            status: 200,
            username: "@new.name",
            jid: "111111111@lid"
          };
        },
        rememberIdentity: async (...args) => {
          remembered.push(args);
          return { lid: args[1], username: args[3] };
        }
      }
    );

    assert.equal(result.resolved, true);
    assert.equal(result.recipient, "@new.name");
    assert.equal(result.reason, "current_username");
    assert.deepEqual(remembered, [[
      restaurantId,
      "111111111@lid",
      undefined,
      "@new.name"
    ]]);
  } finally {
    CustomerChannelIdentity.findOne = originalFindOne;
  }
});

test("temporary provider failures never fall back to a stored LID username", async () => {
  const originalFindOne = CustomerChannelIdentity.findOne;

  try {
    CustomerChannelIdentity.findOne = () => ({
      select: async () => ({ username: "@old.name" })
    });
    const input = {
      restaurantId,
      customerKey: "wasender:lid:111111111@lid",
      fallbackAddress: "@old.name",
      apiKey: "restaurant-token",
      verifyUsername: true
    };

    const unavailable = await resolveCurrentWhatsappRecipientResult(input, {
      resolveUsername: async () => ({
        success: false,
        status: 503,
        data: { retry_after: 2 },
        error: "temporarily unavailable"
      })
    });
    assert.deepEqual(unavailable, {
      resolved: false,
      reason: "username_lookup_failed",
      temporary: true,
      providerStatus: 503,
      retryAfterMs: 2_000
    });

    const timeout = await resolveCurrentWhatsappRecipientResult(input, {
      resolveUsername: async () => {
        throw new Error("timeout");
      }
    });
    assert.deepEqual(timeout, {
      resolved: false,
      reason: "username_lookup_failed",
      temporary: true
    });
  } finally {
    CustomerChannelIdentity.findOne = originalFindOne;
  }
});

test("a provider-confirmed unchanged LID username is safe without rewriting its mapping", async () => {
  const originalFindOne = CustomerChannelIdentity.findOne;
  let rememberCalled = false;

  try {
    CustomerChannelIdentity.findOne = () => ({
      select: async () => ({ username: "@current.name" })
    });
    const result = await resolveCurrentWhatsappRecipientResult(
      {
        restaurantId,
        customerKey: "wasender:lid:111111111@lid",
        fallbackAddress: "@current.name",
        apiKey: "restaurant-token",
        verifyUsername: true
      },
      {
        resolveUsername: async () => ({
          success: true,
          status: 200,
          username: "@current.name",
          jid: "111111111@lid"
        }),
        rememberIdentity: async () => {
          rememberCalled = true;
          return { lid: "111111111@lid", username: "@current.name" };
        }
      }
    );

    assert.equal(result.resolved, true);
    assert.equal(result.recipient, "@current.name");
    assert.equal(rememberCalled, false);
  } finally {
    CustomerChannelIdentity.findOne = originalFindOne;
  }
});

test("a provider response with no username rejects the stored LID username", async () => {
  const originalFindOne = CustomerChannelIdentity.findOne;

  try {
    CustomerChannelIdentity.findOne = () => ({
      select: async () => ({ username: "@old.name" })
    });
    const result = await resolveCurrentWhatsappRecipientResult(
      {
        restaurantId,
        customerKey: "wasender:lid:111111111@lid",
        fallbackAddress: "@old.name",
        apiKey: "restaurant-token",
        verifyUsername: true
      },
      {
        resolveUsername: async () => ({
          success: false,
          status: 200,
          error: "no username"
        })
      }
    );

    assert.deepEqual(result, {
      resolved: false,
      reason: "no_current_whatsapp_recipient",
      providerStatus: 200
    });
  } finally {
    CustomerChannelIdentity.findOne = originalFindOne;
  }
});

test("a current phone wins without performing LID username verification", async () => {
  const originalFindOne = CustomerChannelIdentity.findOne;
  let providerCalled = false;

  try {
    CustomerChannelIdentity.findOne = () => ({
      select: async () => ({ phone: customerPhone, username: "@current.name" })
    });
    const result = await resolveCurrentWhatsappRecipientResult(
      {
        restaurantId,
        customerKey: "wasender:lid:111111111@lid",
        fallbackAddress: "@old.name",
        apiKey: "restaurant-token",
        verifyUsername: true
      },
      {
        resolveUsername: async () => {
          providerCalled = true;
          return { success: false, status: 500 };
        }
      }
    );

    assert.equal(result.recipient, customerPhone);
    assert.equal(result.reason, "current_phone");
    assert.equal(providerCalled, false);
  } finally {
    CustomerChannelIdentity.findOne = originalFindOne;
  }
});

const queueResolvedQuery = (value) => ({
  sort() {
    return this;
  },
  select() {
    return Promise.resolve(value);
  }
});

test("a temporary send-time username lookup failure remains pending for retry", async () => {
  const originalOutboundFindOne = OutboundMessage.findOne;
  const originalOutboundFindOneAndUpdate = OutboundMessage.findOneAndUpdate;
  const originalIdentityFindOne = CustomerChannelIdentity.findOne;
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.WASENDER_API_URL;
  const originalWarn = console.warn;
  const before = Date.now();
  let sends = 0;
  const candidate = {
    _id: "receipt-temp-lookup",
    sessionId: "session-1",
    nextAttemptAt: new Date(0),
    async save() { return this; }
  };
  const locked = {
    ...candidate,
    restaurantId,
    to: "@old.name",
    type: "document",
    documentUrl: "https://example.com/receipt.pdf",
    apiKey: "restaurant-token",
    status: "sending",
    attempts: 1,
    maxAttempts: 5,
    metadata: {
      kind: "receipt_delivery",
      restaurantId,
      orderId: "64b000000000000000000903",
      recipientType: "customer",
      customerPhone: "@old.name",
      customerKey: "wasender:lid:111111111@lid"
    },
    async save() { return this; }
  };

  try {
    console.warn = () => undefined;
    process.env.WASENDER_API_URL = "https://wasender.example";
    global.fetch = async () => ({
      ok: false,
      status: 503,
      headers: { get: () => "application/json" },
      json: async () => ({ success: false, retry_after: 2 })
    });
    CustomerChannelIdentity.findOne = () => ({
      select: async () => ({ username: "@old.name" })
    });
    OutboundMessage.findOne = (filter) =>
      queueResolvedQuery(filter.status === "sent" ? null : candidate);
    OutboundMessage.findOneAndUpdate = () => queueResolvedQuery(locked);

    const processed = await wasenderQueueService.processNextQueuedWasenderMessage({
      sendMessage: async () => {
        sends += 1;
        return { success: true, status: 200 };
      }
    });

    assert.equal(processed, true);
    assert.equal(sends, 0);
    assert.equal(locked.status, "pending");
    assert.equal(locked.lastError, "username_lookup_failed");
    assert.equal(locked.nextAttemptAt.getTime() >= before + 1_500, true);
  } finally {
    OutboundMessage.findOne = originalOutboundFindOne;
    OutboundMessage.findOneAndUpdate = originalOutboundFindOneAndUpdate;
    CustomerChannelIdentity.findOne = originalIdentityFindOne;
    global.fetch = originalFetch;
    console.warn = originalWarn;
    if (originalApiUrl === undefined) delete process.env.WASENDER_API_URL;
    else process.env.WASENDER_API_URL = originalApiUrl;
  }
});

test("a no-safe-recipient cancellation later reuses and reactivates its idempotent row", async () => {
  const originalOutboundFindOne = OutboundMessage.findOne;
  const originalOutboundFindOneAndUpdate = OutboundMessage.findOneAndUpdate;
  const originalOutboundCreate = OutboundMessage.create;
  const originalIdentityFindOne = CustomerChannelIdentity.findOne;
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.WASENDER_API_URL;
  const originalWarn = console.warn;
  let creates = 0;
  let saves = 0;
  let sends = 0;
  let providerUsername = "";
  let currentIdentity = { username: "@old.name" };
  const existing = {
    _id: "existing-receipt-row",
    restaurantId,
    sessionId: "old-session",
    to: "@old.name",
    type: "document",
    documentUrl: "https://example.com/old-receipt.pdf",
    apiKey: "restaurant-token",
    status: "pending",
    attempts: 3,
    maxAttempts: 5,
    nextAttemptAt: new Date(0),
    lastError: undefined,
    metadata: {
      kind: "receipt_delivery",
      restaurantId,
      orderId: "64b000000000000000000903",
      recipientType: "customer",
      customerKey: "wasender:lid:111111111@lid",
      customerPhone: "@old.name"
    },
    async save() {
      saves += 1;
      return this;
    }
  };

  try {
    console.warn = () => undefined;
    process.env.WASENDER_API_URL = "https://wasender.example";
    global.fetch = async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer restaurant-token");
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({
          success: true,
          data: providerUsername
            ? { jid: "111111111@lid", username: providerUsername }
            : {}
        })
      };
    };
    CustomerChannelIdentity.findOne = () => ({
      select: async () => currentIdentity
    });
    OutboundMessage.findOne = (filter) => {
      if (filter.status === "sent") {
        return queueResolvedQuery(null);
      }
      if (filter.status === "pending") {
        return queueResolvedQuery(existing);
      }
      return { select: async () => existing };
    };
    OutboundMessage.findOneAndUpdate = () => {
      existing.status = "sending";
      existing.attempts += 1;
      return queueResolvedQuery(existing);
    };
    OutboundMessage.create = async () => {
      creates += 1;
      throw new Error("must not create a duplicate row");
    };

    const processed = await wasenderQueueService.processNextQueuedWasenderMessage({
      sendMessage: async () => {
        sends += 1;
        return { success: true, status: 200 };
      }
    });
    assert.equal(processed, true);
    assert.equal(sends, 0);
    assert.equal(existing.status, "cancelled");
    assert.equal(existing.lastError, "no_current_whatsapp_recipient");

    providerUsername = "new.name";
    currentIdentity = { username: "@new.name" };

    const result = await wasenderQueueService.enqueueWasenderMessage({
      restaurantId,
      sessionId: "session-1",
      to: "@old.name",
      type: "document",
      documentUrl: "https://example.com/current-receipt.pdf",
      apiKey: "restaurant-token",
      idempotencyKey: "receipt-delivery:64b000000000000000000903",
      metadata: {
        kind: "receipt_delivery",
        restaurantId,
        customerKey: "wasender:lid:111111111@lid",
        customerPhone: "@old.name"
      }
    });

    assert.equal(result, existing);
    assert.equal(existing.status, "pending");
    assert.equal(existing.to, "@new.name");
    assert.equal(existing.metadata.customerPhone, "@new.name");
    assert.equal(existing.attempts, 0);
    assert.equal(existing.lastError, undefined);
    assert.equal(existing.lastStatus, undefined);
    assert.equal(existing.nextAttemptAt instanceof Date, true);
    assert.equal(saves, 2);
    assert.equal(creates, 0);
  } finally {
    OutboundMessage.findOne = originalOutboundFindOne;
    OutboundMessage.findOneAndUpdate = originalOutboundFindOneAndUpdate;
    OutboundMessage.create = originalOutboundCreate;
    CustomerChannelIdentity.findOne = originalIdentityFindOne;
    global.fetch = originalFetch;
    console.warn = originalWarn;
    if (originalApiUrl === undefined) delete process.env.WASENDER_API_URL;
    else process.env.WASENDER_API_URL = originalApiUrl;
  }
});

test("non-recoverable cancelled idempotent messages remain cancelled", async () => {
  const originalOutboundFindOne = OutboundMessage.findOne;
  const originalOutboundCreate = OutboundMessage.create;
  let creates = 0;
  let saves = 0;
  const existing = {
    _id: "cancelled-campaign-row",
    status: "cancelled",
    lastError: "Stale customer campaign message: campaign_version_changed",
    async save() {
      saves += 1;
      return this;
    }
  };

  try {
    OutboundMessage.findOne = () => ({ select: async () => existing });
    OutboundMessage.create = async () => {
      creates += 1;
      return {};
    };
    const result = await wasenderQueueService.enqueueWasenderMessage({
      restaurantId,
      sessionId: "session-1",
      to: "@current.name",
      type: "text",
      text: "Campaign",
      apiKey: "restaurant-token",
      idempotencyKey: "campaign:1:recipient:1:v2",
      metadata: {
        kind: "customer_campaign",
        restaurantId,
        customerKey: "wasender:lid:111111111@lid"
      }
    });

    assert.equal(result, existing);
    assert.equal(existing.status, "cancelled");
    assert.equal(saves, 0);
    assert.equal(creates, 0);
    assert.deepEqual(
      [...wasenderQueueService.recoverableRecipientCancellationReasons].sort(),
      ["no_current_whatsapp_recipient", "stale_username"]
    );
  } finally {
    OutboundMessage.findOne = originalOutboundFindOne;
    OutboundMessage.create = originalOutboundCreate;
  }
});

test("order side effects do not report an unrecoverable cancelled row as queued", async () => {
  const originalIdentityFindOne = CustomerChannelIdentity.findOne;
  const originalEnqueue = wasenderQueueService.enqueueWasenderMessage;
  const restaurant = {
    _id: restaurantId,
    name: "Golden Grill",
    wasenderSessionId: "session-1",
    wasenderApiToken: "restaurant-token"
  };
  const order = {
    _id: "64b000000000000000000903",
    restaurantId,
    orderNumber: "ORD-903",
    customerName: "Ama",
    customerKey: "wasender:lid:111111111@lid",
    customerPhone: "@current.name",
    status: "accepted",
    receiptUrl: "https://example.com/receipt.pdf",
    receiptGeneratedAt: new Date(),
    async save() { return this; }
  };

  try {
    CustomerChannelIdentity.findOne = () => ({
      select: async () => ({ username: "@current.name" })
    });
    wasenderQueueService.enqueueWasenderMessage = async () => ({
      _id: "cancelled-row",
      status: "cancelled",
      lastError: "Stale customer campaign message: campaign_version_changed"
    });

    const result = await notifyCustomerOfConfirmedOrderAndSendReceipt(
      restaurant,
      order
    );
    assert.equal(result.customerNotification, "failed");
    assert.equal(result.receiptDelivery, "failed");
  } finally {
    CustomerChannelIdentity.findOne = originalIdentityFindOne;
    wasenderQueueService.enqueueWasenderMessage = originalEnqueue;
  }
});

test("receipt worker verifies, reconciles, sends, and records the current username", async () => {
  const originalOutboundFindOne = OutboundMessage.findOne;
  const originalOutboundFindOneAndUpdate = OutboundMessage.findOneAndUpdate;
  const originalIdentityFindOne = CustomerChannelIdentity.findOne;
  const originalIdentityUpdateMany = CustomerChannelIdentity.updateMany;
  const originalOrderFindOne = Order.findOne;
  const originalOrderUpdateOne = Order.updateOne;
  const originalRestaurantFindOne = Restaurant.findOne;
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.WASENDER_API_URL;
  const originalInfo = console.info;
  const receiptUpdates = [];
  const identityUpdates = [];
  let sends = 0;
  let identitySaves = 0;
  const identity = {
    lid: "111111111@lid",
    username: "@old.name",
    async save() {
      identitySaves += 1;
      return this;
    }
  };
  const candidate = {
    _id: "receipt-successful-recovery",
    sessionId: "session-1",
    nextAttemptAt: new Date(0),
    async save() { return this; }
  };
  const locked = {
    ...candidate,
    restaurantId,
    to: "@old.name",
    type: "document",
    documentUrl: "https://example.com/receipt.pdf",
    caption: "Receipt",
    apiKey: "restaurant-token",
    status: "sending",
    attempts: 1,
    maxAttempts: 5,
    metadata: {
      kind: "receipt_delivery",
      restaurantId,
      orderId: "64b000000000000000000903",
      orderNumber: "ORD-903",
      recipientType: "customer",
      customerPhone: "@old.name",
      customerKey: "wasender:lid:111111111@lid"
    },
    async save() { return this; }
  };

  try {
    console.info = () => undefined;
    process.env.WASENDER_API_URL = "https://wasender.example";
    global.fetch = async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer restaurant-token");
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({
          success: true,
          data: { jid: "111111111@lid", username: "new.name" }
        })
      };
    };
    CustomerChannelIdentity.findOne = (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      const query = {
        select: async () => identity,
        then: (resolve, reject) => Promise.resolve(identity).then(resolve, reject)
      };
      return query;
    };
    CustomerChannelIdentity.updateMany = async (filter) => {
      identityUpdates.push(filter);
      return { modifiedCount: 0 };
    };
    OutboundMessage.findOne = (filter) =>
      queueResolvedQuery(filter.status === "sent" ? null : candidate);
    OutboundMessage.findOneAndUpdate = () => queueResolvedQuery(locked);
    Order.findOne = async () => null;
    Order.updateOne = async (filter, update) => {
      receiptUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    };
    Restaurant.findOne = () => queueResolvedQuery(null);

    const processed = await wasenderQueueService.processNextQueuedWasenderMessage({
      sendMessage: async (message) => {
        sends += 1;
        assert.equal(message.to, "@new.name");
        assert.equal(message.metadata.customerPhone, "@new.name");
        assert.equal(message.metadata.apiKey, undefined);
        return { success: true, status: 200, data: { id: "provider-receipt-1" } };
      }
    });

    assert.equal(processed, true);
    assert.equal(sends, 1);
    assert.equal(identity.username, "@new.name");
    assert.equal(identitySaves, 1);
    assert.equal(locked.to, "@new.name");
    assert.equal(locked.status, "sent");
    assert.equal(
      identityUpdates[0].restaurantId,
      restaurantId,
      "username reconciliation must stay tenant scoped"
    );
    assert.equal(identityUpdates[0].username, "@new.name");
    assert.equal(
      receiptUpdates.some(({ update }) => update.$set?.receiptSentAt instanceof Date),
      true
    );
  } finally {
    OutboundMessage.findOne = originalOutboundFindOne;
    OutboundMessage.findOneAndUpdate = originalOutboundFindOneAndUpdate;
    CustomerChannelIdentity.findOne = originalIdentityFindOne;
    CustomerChannelIdentity.updateMany = originalIdentityUpdateMany;
    Order.findOne = originalOrderFindOne;
    Order.updateOne = originalOrderUpdateOne;
    Restaurant.findOne = originalRestaurantFindOne;
    global.fetch = originalFetch;
    console.info = originalInfo;
    if (originalApiUrl === undefined) delete process.env.WASENDER_API_URL;
    else process.env.WASENDER_API_URL = originalApiUrl;
  }
});
