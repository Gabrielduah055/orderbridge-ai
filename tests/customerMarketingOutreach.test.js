const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildMarketingConsentOutreachPreviewMessage,
  executeMarketingConsentOutreach,
  previewMarketingConsentOutreach
} = require("../dist/services/customerMarketingOutreach.service");
const {
  recordMarketingConsentPromptResponse
} = require("../dist/services/customerMarketingOnboarding.service");
const { CustomerProfile } = require("../dist/models/customerProfile.model");
const { Restaurant } = require("../dist/models/Restaurant");
const { PendingAgentAction } = require("../dist/models/pendingAgentAction.model");
const { toolRegistry } = require("../dist/agent-tools/tool.registry");
const { isToolAllowedForRole } = require("../dist/agent-tools/tool.permissions");

const restaurantId = "64b000000000000000000d01";
const ownerPhone = "+233500000001";
const managerPhone = "+233500000002";

const restaurant = {
  _id: restaurantId,
  name: "Golden Grill",
  ownerName: "Ama",
  ownerPhone,
  managerPhones: [managerPhone],
  managerContacts: [],
  status: "active",
  wasenderSessionId: "golden-session",
  wasenderApiToken: "golden-token"
};

const dependenciesFor = (profiles, queueRequest) => ({
  findRestaurant: async () => restaurant,
  findProfiles: async () => profiles,
  ...(queueRequest ? { queueRequest } : {})
});

test("staff outreach preview derives a mixed audience without exposing phones", async () => {
  const profiles = [
    { customerPhone: "+233500000011", marketingConsent: true, isOptedOut: false },
    { customerPhone: "+233500000012", marketingConsent: true, isOptedOut: false },
    { customerPhone: "+233500000013", marketingConsent: false, isOptedOut: true },
    ...[14, 15, 16].map((suffix) => ({
      customerPhone: `+2335000000${suffix}`,
      marketingConsent: null,
      isOptedOut: false,
      marketingConsentPromptedAt: new Date()
    })),
    { customerPhone: "+233500000017", marketingConsent: null, isOptedOut: false },
    { customerPhone: "@lid", marketingConsent: null, isOptedOut: false }
  ];
  const preview = await previewMarketingConsentOutreach(
    restaurantId,
    ownerPhone,
    dependenciesFor(profiles)
  );

  assert.deepEqual(
    {
      total: preview.totalCustomers,
      eligible: preview.eligible,
      optedIn: preview.excludedAlreadyOptedIn,
      optedOut: preview.excludedOptedOut,
      asked: preview.excludedAlreadyAsked,
      invalid: preview.excludedInvalidPhone
    },
    { total: 8, eligible: 1, optedIn: 2, optedOut: 1, asked: 3, invalid: 1 }
  );
  assert.match(preview.message, /Reply YES/);
  assert.match(preview.message, /reply STOP/i);
  assert.doesNotMatch(JSON.stringify(preview), /\+233500000017/);
  assert.match(buildMarketingConsentOutreachPreviewMessage(preview), /Eligible to ask now: 1/);
});

test("confirmed staff outreach isolates queue failures and manager is allowed", async () => {
  const profiles = [
    { customerPhone: "+233500000021", marketingConsent: null, isOptedOut: false },
    { customerPhone: "+233500000022", marketingConsent: null, isOptedOut: false }
  ];
  const queued = [];
  const result = await executeMarketingConsentOutreach(
    restaurantId,
    managerPhone,
    dependenciesFor(profiles, async (input) => {
      queued.push(input);
      if (input.customerPhone.endsWith("22")) throw new Error("queue down");
      return { queued: true };
    })
  );

  assert.equal(isToolAllowedForRole("invite_customers_to_marketing", "owner"), true);
  assert.equal(isToolAllowedForRole("invite_customers_to_marketing", "manager"), true);
  assert.equal(isToolAllowedForRole("invite_customers_to_marketing", "customer"), false);
  assert.equal(result.eligible, 2);
  assert.equal(result.queued, 1);
  assert.equal(result.failedToQueue, 1);
  assert.equal(queued[0].source, "staff_outreach");
  assert.equal(queued[0].requestedByPhone, managerPhone);
});

test("staff tool creates a backend preview confirmation without queueing invitations", async () => {
  const originals = {
    restaurantFindOne: Restaurant.findOne,
    profileFind: CustomerProfile.find,
    pendingUpdateMany: PendingAgentAction.updateMany,
    pendingCreate: PendingAgentAction.create
  };
  let pendingInput;

  try {
    Restaurant.findOne = () => ({ select: async () => restaurant });
    CustomerProfile.find = () => ({
      select: async () => [
        { customerPhone: "+233500000031", marketingConsent: null, isOptedOut: false }
      ]
    });
    PendingAgentAction.updateMany = async () => ({ modifiedCount: 0 });
    PendingAgentAction.create = async (input) => {
      pendingInput = input;
      return { _id: "pending-outreach-1", ...input };
    };

    const result = await toolRegistry.invite_customers_to_marketing.handler(
      {},
      {
        restaurantId,
        restaurant,
        sender: {
          role: "owner",
          phone: ownerPhone,
          normalizedPhone: ownerPhone,
          verified: true
        }
      }
    );

    assert.equal(result.requiresConfirmation, true);
    assert.equal(result.data.eligible, 1);
    assert.equal(pendingInput.toolName, "invite_customers_to_marketing");
    assert.deepEqual(pendingInput.arguments, {});
    assert.match(pendingInput.confirmationMessage, /Send this to 1 customer\?/);
  } finally {
    Restaurant.findOne = originals.restaurantFindOne;
    CustomerProfile.find = originals.profileFind;
    PendingAgentAction.updateMany = originals.pendingUpdateMany;
    PendingAgentAction.create = originals.pendingCreate;
  }
});

test("a repeated confirmed outreach finds no recipients after the first prompt", async () => {
  const profiles = [
    { customerPhone: "+233500000041", marketingConsent: null, isOptedOut: false }
  ];
  let queues = 0;
  const dependencies = dependenciesFor(profiles, async () => {
    queues += 1;
    profiles[0].marketingConsentPromptedAt = new Date();
    return { queued: true };
  });

  const first = await executeMarketingConsentOutreach(
    restaurantId,
    ownerPhone,
    dependencies
  );
  const second = await executeMarketingConsentOutreach(
    restaurantId,
    ownerPhone,
    dependencies
  );

  assert.equal(first.queued, 1);
  assert.equal(second.eligible, 0);
  assert.equal(second.queued, 0);
  assert.equal(queues, 1);
});

test("trusted consent replies record accepted or declined invitation outcome", async () => {
  const originalUpdateOne = CustomerProfile.updateOne;
  const calls = [];

  try {
    CustomerProfile.updateOne = async (filter, update) => {
      calls.push({ filter, update });
      return { modifiedCount: 1 };
    };
    const respondedAt = new Date("2026-08-13T15:00:00.000Z");

    assert.equal(
      await recordMarketingConsentPromptResponse(
        restaurantId,
        "+233500000023",
        "opt_in",
        respondedAt
      ),
      true
    );
    await recordMarketingConsentPromptResponse(
      restaurantId,
      "+233500000024",
      "opt_out",
      respondedAt
    );

    assert.equal(calls[0].update.$set.marketingConsentPromptResponse, "opt_in");
    assert.equal(calls[1].update.$set.marketingConsentPromptResponse, "opt_out");
    assert.deepEqual(calls[0].filter.marketingConsentPromptedAt, { $exists: true });
    assert.deepEqual(calls[0].filter.marketingConsentPromptResponse, { $exists: false });
  } finally {
    CustomerProfile.updateOne = originalUpdateOne;
  }
});
