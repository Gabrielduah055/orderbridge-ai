const test = require("node:test");
const assert = require("node:assert/strict");
const { Types } = require("mongoose");

const { CustomerCampaign } = require("../dist/models/customerCampaign.model");
const { CustomerProfile } = require("../dist/models/customerProfile.model");
const { PendingAgentAction } = require("../dist/models/pendingAgentAction.model");
const { MenuItem } = require("../dist/models/MenuItem");
const {
  selectCustomerCampaignAudience,
  validateCustomerCampaignMedia
} = require("../dist/services/customerCampaign.service");
const {
  prepareUploadedCampaignImage,
  startCampaignImageUpload
} = require("../dist/services/campaignImageWorkflow.service");
const {
  runCustomerCampaignSchedulerPass
} = require("../dist/services/customerCampaignScheduler.service");
const {
  processInboundStaffMenuImage
} = require("../dist/controllers/wasender.controller");
const {
  runAgentOrchestrator
} = require("../dist/services/ai/agentOrchestrator.service");

const restaurantId = "64b000000000000000000001";
const campaignId = "64b000000000000000000011";
const profileId = new Types.ObjectId("64b000000000000000000021");
const senderPhone = "+233500000001";

const restore = (target, key, value) => {
  target[key] = value;
};

const resolvedQuery = (value) => ({
  select() {
    return this;
  },
  limit() {
    return Promise.resolve(value);
  },
  then(resolve, reject) {
    return Promise.resolve(value).then(resolve, reject);
  }
});

test("selected-customer campaign targeting remains tenant-scoped and excludes other profiles", async () => {
  const originalFind = CustomerProfile.find;
  try {
    CustomerProfile.find = (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      return resolvedQuery([
        {
          _id: profileId,
          customerKey: "customer:lady-ruth",
          customerName: "Lady Ruth",
          customerPhone: "+233555000001",
          orderCount: 2,
          marketingConsent: null,
          isOptedOut: false,
          updatedAt: new Date("2026-09-01T00:00:00.000Z")
        },
        {
          _id: new Types.ObjectId("64b000000000000000000022"),
          customerName: "Other tenant-like record",
          customerPhone: "+233555000002",
          orderCount: 4,
          marketingConsent: true,
          isOptedOut: false,
          updatedAt: new Date("2026-09-01T00:00:00.000Z")
        }
      ]);
    };

    const preview = await selectCustomerCampaignAudience(
      restaurantId,
      {
        type: "selected_customer",
        customerProfileId: profileId,
        customerName: "Lady Ruth"
      }
    );
    assert.equal(preview.targetedProfiles, 1);
    assert.equal(preview.estimatedEligibleRecipients, 1);
    assert.equal(preview.recipients[0].customerPhone, "+233555000001");
    assert.match(preview.targetingDescription, /Lady Ruth/);
  } finally {
    restore(CustomerProfile, "find", originalFind);
  }
});

test("natural greeting and invitation request can create a campaign draft without the campaign keyword", async () => {
  let round = 0;
  let executed = false;
  let executedArguments;
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
      message:
        "Can you send a happy new month message to all the customers and invite them to place an order today?"
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
                  {
                    id: "campaign-call",
                    name: "create_campaign_draft",
                    arguments: {
                      name: "Happy new month",
                      message:
                        "Happy new month! We wish you a wonderful month and warmly invite you to place an order.",
                      campaignType: "holiday",
                      targeting: { type: "all_eligible_customers" }
                    }
                  }
                ]
              }
            : { text: "Campaign draft created for approval.", toolCalls: [] };
        }
      },
      getHistory: async () => [],
      saveMessage: async () => {},
      buildSystemPrompt: async () => "test",
      executeTool: async (_toolName, args) => {
        executed = true;
        executedArguments = args;
        return {
          success: true,
          message: "Authoritative preview",
          requiresConfirmation: true
        };
      }
    }
  );

  assert.equal(executed, true);
  assert.equal(round, 1);
  assert.equal(executedArguments.campaignType, "holiday");
  assert.deepEqual(executedArguments.targeting, {
    type: "all_eligible_customers"
  });
  assert.equal(result.success, true);
  assert.equal(result.message, "Authoritative preview");
  assert.equal(result.executedTools[0].requiresConfirmation, true);
});

test("inactive-customer campaign asks for a duration instead of inventing one", async () => {
  let round = 0;
  let executionCount = 0;
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
      message: "send a promo to inactive customers"
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
                  {
                    id: "inactive-campaign-call",
                    name: "create_campaign_draft",
                    arguments: {
                      name: "We miss you",
                      message: "We miss you! Come back and order from us.",
                      campaignType: "inactivity_reengagement",
                      targeting: {
                        type: "inactive_customers",
                        inactiveDays: 30
                      }
                    }
                  }
                ]
              }
            : {
                text: "How many days should a customer have been inactive?",
                toolCalls: []
              };
        }
      },
      getHistory: async () => [],
      saveMessage: async () => {},
      buildSystemPrompt: async () => "test",
      executeTool: async () => {
        executionCount += 1;
        throw new Error("untrusted inactivity threshold reached the tool");
      }
    }
  );

  assert.equal(executionCount, 0);
  assert.equal(result.success, true);
  assert.match(result.message, /how many days/i);
  assert.equal(
    result.executedTools[0].code,
    "CAMPAIGN_INACTIVE_DAYS_REQUIRED"
  );
});

test("inactive-customer duration clarification can complete the original draft request", async () => {
  let executionCount = 0;
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
      message: "30 days"
    },
    {
      provider: {
        name: "openrouter",
        model: "test-model",
        complete: async () => ({
          text: null,
          toolCalls: [
            {
              id: "inactive-campaign-follow-up",
              name: "create_campaign_draft",
              arguments: {
                name: "We miss you",
                message: "We miss you! Come back and order from us.",
                campaignType: "inactivity_reengagement",
                targeting: {
                  type: "inactive_customers",
                  inactiveDays: 30
                }
              }
            }
          ]
        })
      },
      getHistory: async () => [
        {
          role: "user",
          content: "send a promo to inactive customers"
        },
        {
          role: "assistant",
          content: "How many days should a customer have been inactive?"
        },
        {
          role: "user",
          content: "30 days"
        }
      ],
      saveMessage: async () => {},
      buildSystemPrompt: async () => "test",
      executeTool: async (_toolName, args) => {
        executionCount += 1;
        assert.equal(args.targeting.inactiveDays, 30);
        return {
          success: true,
          message: "Inactive campaign preview",
          requiresConfirmation: true
        };
      }
    }
  );

  assert.equal(executionCount, 1);
  assert.equal(result.success, true);
  assert.equal(result.message, "Inactive campaign preview");
});

test("owner-uploaded campaign image changes the version and creates renewed approval", async () => {
  const originals = {
    actionFindOne: PendingAgentAction.findOne,
    actionUpdateMany: PendingAgentAction.updateMany,
    actionCreate: PendingAgentAction.create,
    campaignFindOne: CustomerCampaign.findOne,
    profileFind: CustomerProfile.find
  };
  const previousCloudName = process.env.CLOUDINARY_CLOUD_NAME;
  process.env.CLOUDINARY_CLOUD_NAME = "demo";
  const action = {
    data: { campaignId, expectedCampaignVersion: 1 },
    status: "pending",
    save: async () => action
  };
  const campaign = {
    _id: new Types.ObjectId(campaignId),
    restaurantId: new Types.ObjectId(restaurantId),
    name: "We are active",
    message: "We are active today. Bring your orders.",
    campaignType: "announcement",
    targeting: { type: "all_eligible_customers" },
    timezone: "Africa/Accra",
    status: "pending_approval",
    campaignVersion: 1,
    estimatedRecipientCount: 0,
    excludedNoConsentCount: 0,
    excludedOptOutCount: 0,
    excludedInvalidPhoneCount: 0,
    save: async function () {
      this.campaignVersion += 1;
      return this;
    }
  };
  const createdActions = [];
  try {
    PendingAgentAction.findOne = () => ({
      sort: async () => action
    });
    PendingAgentAction.updateMany = async () => ({ modifiedCount: 1 });
    PendingAgentAction.create = async (value) => {
      createdActions.push(value);
      return value;
    };
    CustomerCampaign.findOne = async (filter) => {
      assert.equal(String(filter.restaurantId), restaurantId);
      return campaign;
    };
    CustomerProfile.find = () => resolvedQuery([]);

    const result = await prepareUploadedCampaignImage({
      restaurantId,
      senderPhone,
      senderRole: "owner",
      image: {
        secureUrl:
          "https://res.cloudinary.com/demo/image/upload/v1/campaigns/new-month.jpg",
        publicId: "campaigns/new-month",
        uploadedAt: new Date("2026-10-01T10:00:00.000Z")
      }
    });

    assert.equal(result.handled, true);
    assert.equal(result.success, true);
    assert.equal(campaign.campaignVersion, 2);
    assert.equal(campaign.attachmentType, "upload");
    assert.equal(createdActions.length, 1);
    assert.equal(createdActions[0].toolName, "approve_campaign");
    assert.equal(createdActions[0].arguments.expectedCampaignVersion, 2);
    assert.match(result.message, /Attachment: Owner-uploaded campaign image/);
  } finally {
    restore(PendingAgentAction, "findOne", originals.actionFindOne);
    restore(PendingAgentAction, "updateMany", originals.actionUpdateMany);
    restore(PendingAgentAction, "create", originals.actionCreate);
    restore(CustomerCampaign, "findOne", originals.campaignFindOne);
    restore(CustomerProfile, "find", originals.profileFind);
    if (previousCloudName === undefined) {
      delete process.env.CLOUDINARY_CLOUD_NAME;
    } else {
      process.env.CLOUDINARY_CLOUD_NAME = previousCloudName;
    }
  }
});

test("campaign scheduler queues an approved image with the approved message as caption", async () => {
  const queued = [];
  const campaign = {
    _id: new Types.ObjectId(campaignId),
    restaurantId: new Types.ObjectId(restaurantId),
    status: "approved",
    campaignVersion: 3,
    message: "Place your order today.",
    attachmentType: "upload"
  };
  const recipient = {
    _id: new Types.ObjectId("64b000000000000000000031"),
    customerPhone: "+233555000001",
    campaignVersion: 3,
    consentSnapshotUpdatedAt: new Date("2026-10-01T00:00:00.000Z")
  };
  const result = await runCustomerCampaignSchedulerPass(
    new Date("2026-10-01T12:00:00.000Z"),
    {
      loadRestaurants: async () => [
        {
          _id: new Types.ObjectId(restaurantId),
          name: "OrderBridge Kitchen",
          status: "active",
          wasenderSessionId: "session-1",
          wasenderApiToken: "token"
        }
      ],
      loadCampaigns: async () => [campaign],
      loadRecipients: async () => [recipient],
      messageExists: async () => null,
      validateReferencedItem: async () => {},
      validateMedia: async () => ({
        type: "image",
        imageUrl:
          "https://res.cloudinary.com/demo/image/upload/v1/campaigns/new-month.jpg",
        label: "Owner-uploaded campaign image"
      }),
      enqueueMessage: async (input) => {
        queued.push(input);
        return { _id: new Types.ObjectId() };
      },
      attachOutboundMessage: async () => {},
      markCampaignSending: async () => {},
      updateAggregate: async () => ({})
    }
  );

  assert.equal(result.messagesQueued, 1);
  assert.equal(queued[0].type, "image");
  assert.match(queued[0].caption, /Place your order today/);
  assert.match(queued[0].caption, /Reply STOP/);
  assert.equal(queued[0].metadata.campaignVersion, 3);
});

test("changed or cross-tenant menu media is rejected as stale before campaign delivery", async () => {
  const originalFindOne = MenuItem.findOne;
  let filter;
  try {
    MenuItem.findOne = (input) => {
      filter = input;
      return {
        select: async () => null
      };
    };
    await assert.rejects(
      () =>
        validateCustomerCampaignMedia(restaurantId, {
          attachmentType: "menu_item",
          imageMenuItemId: new Types.ObjectId("64b000000000000000000041"),
          imageUrl:
            "https://res.cloudinary.com/demo/image/upload/v1/menu-items/rice.jpg",
          imageLabel: "Menu image: Rice"
        }),
      /removed or changed/i
    );
    assert.equal(String(filter.restaurantId), restaurantId);
    assert.equal(
      filter.imageUrl,
      "https://res.cloudinary.com/demo/image/upload/v1/menu-items/rice.jpg"
    );
  } finally {
    restore(MenuItem, "findOne", originalFindOne);
  }
});

test("trusted inbound campaign upload uses the campaign media path", async () => {
  const calls = [];
  await processInboundStaffMenuImage(
    {
      restaurantId,
      sessionId: "session-1",
      replyAddress: senderPhone,
      senderPhone,
      senderRole: "owner",
      rawMessage: {},
      eventId: "event-1",
      apiKey: "token"
    },
    {
      isUploadConfigured: () => true,
      validateMetadata: () => {},
      decryptMedia: async () => "https://provider.example/decrypted",
      hasPendingCampaignUpload: async () => true,
      uploadTrustedImage: async (_url, folder) => {
        calls.push(folder);
        return {
          secureUrl:
            "https://res.cloudinary.com/demo/image/upload/v1/campaigns/new-month.jpg",
          publicId: "campaigns/new-month",
          uploadedAt: new Date()
        };
      },
      prepareCampaignImage: async () => ({
        handled: true,
        success: true,
        message: "Campaign Preview"
      }),
      prepareImage: async () => {
        throw new Error("menu path must not run");
      },
      enqueueText: async (_sessionId, _to, message) => {
        calls.push(message);
      }
    }
  );

  assert.deepEqual(calls, ["campaigns", "Campaign Preview"]);
});

test("manager cannot start a campaign image upload", async () => {
  const result = await startCampaignImageUpload({
    restaurantId,
    senderPhone,
    senderRole: "manager",
    campaignId
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "CAMPAIGN_IMAGE_FORBIDDEN");
});
