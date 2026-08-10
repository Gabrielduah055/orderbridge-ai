const assert = require("node:assert/strict");
const test = require("node:test");

const { CustomerChannelIdentity } = require("../dist/models/customerChannelIdentity.model");
const { CustomerProfile } = require("../dist/models/customerProfile.model");
const { CustomerSession } = require("../dist/models/customerSession.model");
const { Order } = require("../dist/models/order.model");
const {
  normalizeIncomingWebhook,
  resolveWasenderPhoneFromLid
} = require("../dist/services/wasender.service");
const {
  resolveWasenderCustomerIdentity
} = require("../dist/services/wasenderIdentity.service");
const { resolveSenderIdentity } = require("../dist/services/senderIdentity.service");
const {
  recordInboundCustomerTurn
} = require("../dist/services/orderDraft.service");
const {
  getCustomerProfile
} = require("../dist/services/customerProfile.service");
const {
  loadCustomerMemorySummary
} = require("../dist/services/customerMemory.service");
const {
  sendAgentReplyDirectly
} = require("../dist/controllers/wasender.controller");
const { normalizeGhanaPhone } = require("../dist/utils/phone.util");

const restaurantId = "64b000000000000000000901";
const otherRestaurantId = "64b000000000000000000902";
const customerPhone = "+233557038547";
const customerPhoneDigits = "233557038547";
const lid = "123456789@lid";

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
  assert.equal(identity.recipientAddress, lid);
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
  assert.equal(identity.recipientAddress, lid);
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
      remember: async (...args) => {
        remembered.push(args);
        return { lid: args[1] };
      }
    }
  );

  assert.equal(identity.customerPhone, undefined);
  assert.equal(identity.recipientAddress, lid);
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

  for (const [keys, options] of [lidIndex, phoneIndex]) {
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

test("an immediate reply to a LID-addressed webhook preserves the trusted LID recipient", async () => {
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
      lid,
      "Hello",
      { restaurantId, eventId: "message-1", action: "reply" },
      "restaurant-token"
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://wasender.example/api/send-message");
    assert.equal(JSON.parse(requests[0].options.body).to, lid);
  } finally {
    global.fetch = originalFetch;
    if (originalApiUrl === undefined) {
      delete process.env.WASENDER_API_URL;
    } else {
      process.env.WASENDER_API_URL = originalApiUrl;
    }
  }
});
