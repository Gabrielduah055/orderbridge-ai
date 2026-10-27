const test = require("node:test");
const assert = require("node:assert/strict");
const { Types } = require("mongoose");

const { Business } = require("../dist/models/business.model");
const { Restaurant } = require("../dist/models/Restaurant");
const {
  getAgentToolDefinitionsForContext
} = require("../dist/services/ai/agentToolDefinitions.service");
const {
  isToolAllowedForContext,
  getAllowedToolNamesForRole
} = require("../dist/agent-tools/tool.permissions");
const { executeAgentTool } = require("../dist/agent-tools/tool.executor");
const {
  runAgentOrchestrator
} = require("../dist/services/ai/agentOrchestrator.service");
const {
  getRecentBusinessConversationHistory
} = require("../dist/services/agentConversationHistory.service");
const {
  AgentConversationMessage
} = require("../dist/models/agentConversation.model");
const {
  CommerceIntegrationError,
  searchCommerceProducts
} = require("../dist/services/commerceIntegration.service");
const {
  hashWebsiteIntegrationKey,
  verifyWebsiteIntegrationKey,
  createWebsiteConversationIdentity,
  verifyWebsiteConversationIdentity
} = require("../dist/services/websiteIntegrationAuth.service");
const {
  handleWebsiteChatMessage
} = require("../dist/services/websiteChat.service");
const {
  handleWebsiteChat
} = require("../dist/controllers/websiteChat.controller");
const {
  enforceWebsiteChatRateLimit,
  resetWebsiteChatRateLimitsForTests
} = require("../dist/middleware/websiteChatRateLimit.middleware");
const {
  normalizeIncomingWebhook
} = require("../dist/services/wasender.service");
const {
  findRestaurantForWebhook,
  isWebhookVerified
} = require("../dist/controllers/wasender.controller");
const {
  websiteChatMessageSchema
} = require("../dist/middleware/validateRequest");

const makeBusiness = (overrides = {}) =>
  new Business({
    _id: new Types.ObjectId(),
    name: "Example Commerce",
    slug: "example-commerce",
    type: "ecommerce",
    status: "active",
    timezone: "Africa/Accra",
    enabledChannels: ["website"],
    capabilities: ["website_chat", "commerce_catalog_read"],
    websiteIntegration: {
      enabled: true,
      integrationKeyHash: hashWebsiteIntegrationKey("a-secure-integration-key-value"),
      allowedOrigins: [],
      requestsPerMinute: 60
    },
    commerceIntegration: {
      baseUrl: "https://catalog.example.com",
      apiKey: "trusted-api-key",
      authType: "bearer",
      timeoutMs: 1000,
      paths: {
        search: "/v1/products/search",
        product: "/v1/products/{productId}",
        availability: "/v1/products/{productId}/availability",
        policies: "/v1/policies"
      },
      canonicalProductHosts: ["shop.example.com"]
    },
    ...overrides
  });

const permissionContext = {
  senderRole: "customer",
  businessType: "ecommerce",
  channel: "website",
  capabilities: ["website_chat", "commerce_catalog_read"]
};

const makeOrchestratorInput = (business, message = "Find a laptop") => ({
  business,
  businessContext: {
    businessId: String(business._id),
    businessName: business.name,
    businessType: "ecommerce",
    channel: "website",
    capabilities: [...business.capabilities],
    conversationId: "session-12345678",
    timezone: business.timezone
  },
  sender: {
    identityKey: "website:session-12345678",
    phone: "",
    normalizedAddress: "",
    normalizedPhone: "",
    role: "customer",
    verified: false
  },
  message
});

test("website commerce permissions expose only read-only catalog tools", () => {
  const names = getAgentToolDefinitionsForContext(permissionContext).map(
    (tool) => tool.function.name
  );

  assert.deepEqual(
    names.sort(),
    [
      "check_product_availability",
      "get_business_policies",
      "get_product_details",
      "search_products"
    ]
  );
  assert.equal(isToolAllowedForContext("search_products", permissionContext), true);
  assert.equal(isToolAllowedForContext("confirm_order", permissionContext), false);
  assert.equal(isToolAllowedForContext("update_menu_price", permissionContext), false);
  assert.equal(getAllowedToolNamesForRole("customer").includes("search_products"), false);
});

test("website orchestrator uses the shared provider model and strips trusted context arguments", async () => {
  const business = makeBusiness();
  const executions = [];
  let round = 0;
  const provider = {
    name: "openrouter",
    model: "shared-orderbridge-model",
    complete: async (request) => {
      if (round++ === 0) {
        assert.deepEqual(
          request.tools.map((tool) => tool.function.name).sort(),
          [
            "check_product_availability",
            "get_business_policies",
            "get_product_details",
            "search_products"
          ]
        );
        return {
          toolCalls: [
            {
              id: "tool-1",
              name: "search_products",
              arguments: {
                query: "laptop",
                limit: 3,
                businessId: "attacker-business",
                channel: "whatsapp",
                capabilities: ["restaurant_operations"]
              }
            }
          ]
        };
      }
      return { text: "I found one verified option.", toolCalls: [] };
    }
  };

  const result = await runAgentOrchestrator(makeOrchestratorInput(business), {
    provider,
    getHistory: async () => [],
    saveMessage: async () => undefined,
    buildSystemPrompt: async () => "trusted website prompt",
    executeTool: async (name, args, context) => {
      executions.push({ name, args, context });
      return {
        success: true,
        message: "Products retrieved successfully.",
        data: {
          products: [
            {
              id: "p1",
              name: "Laptop",
              price: 4000,
              currency: "GHS",
              available: true,
              canonicalUrl: "https://shop.example.com/products/p1"
            }
          ],
          total: 1
        }
      };
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.model, "shared-orderbridge-model");
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0].args, { query: "laptop", limit: 3 });
  assert.equal(executions[0].context.businessId, String(business._id));
  assert.equal(executions[0].context.channel, "website");
  assert.equal(result.data.products[0].canonicalUrl, "https://shop.example.com/products/p1");
  assert.match(result.message, /GHS 4,000/);
  assert.match(result.message, /Available/);
  assert.match(result.message, /https:\/\/shop\.example\.com\/products\/p1/);
});

test("website commerce answers replace incorrect model product claims with verified tool data", async () => {
  const business = makeBusiness();
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(business, "Tell me the price, availability, link, and storage"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () =>
          round++ === 0
            ? {
                toolCalls: [
                  {
                    id: "grounding-1",
                    name: "search_products",
                    arguments: { query: "laptop", limit: 1 }
                  }
                ]
              }
            : {
                text: "It costs USD 1, is unavailable, has 2 TB storage, and is at https://attacker.example/fake.",
                toolCalls: []
              }
      },
      getHistory: async () => [],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async () => ({
        success: true,
        message: "Products retrieved successfully.",
        data: {
          products: [
            {
              id: "p1",
              name: "Verified Laptop",
              price: 4000,
              currency: "GHS",
              available: true,
              specifications: { storage: "256 GB" },
              canonicalUrl: "https://shop.example.com/products/p1"
            }
          ],
          total: 1
        }
      })
    }
  );

  assert.match(result.message, /GHS 4,000/);
  assert.match(result.message, /Available/);
  assert.match(result.message, /storage: 256 GB/i);
  assert.match(result.message, /https:\/\/shop\.example\.com\/products\/p1/);
  assert.doesNotMatch(result.message, /USD 1|unavailable|2 TB|attacker\.example/i);
});

test("website commerce blocks unsupported product claims when no catalog tool succeeded", async () => {
  const business = makeBusiness();
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(business, "What does the laptop cost?"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () => ({
          text: "It costs GHS 999 and is available at https://attacker.example/item.",
          toolCalls: []
        })
      },
      getHistory: async () => [],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt"
    }
  );

  assert.match(result.message, /check the verified catalog/i);
  assert.doesNotMatch(result.message, /999|attacker\.example/i);
});

test("website customer cannot execute restaurant operational tools through orchestrator", async () => {
  const business = makeBusiness();
  let executeCount = 0;
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(business, "Confirm order ORD-123"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () =>
          round++ === 0
            ? {
                toolCalls: [
                  {
                    id: "forbidden-1",
                    name: "confirm_order",
                    arguments: { orderId: "ORD-123" }
                  }
                ]
              }
            : { text: "I can't perform restaurant operations here.", toolCalls: [] }
      },
      getHistory: async () => [],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async () => {
        executeCount += 1;
        return { success: true, message: "should not execute" };
      }
    }
  );

  assert.equal(executeCount, 0);
  assert.equal(result.executedTools[0].code, "TOOL_FORBIDDEN");
});

test("business conversation history is isolated by business, channel, and conversation", async () => {
  const originalFind = AgentConversationMessage.find;
  let capturedFilter;

  AgentConversationMessage.find = (filter) => {
    capturedFilter = filter;
    return {
      sort() {
        return this;
      },
      async limit() {
        return [];
      }
    };
  };

  try {
    await getRecentBusinessConversationHistory(
      new Types.ObjectId().toString(),
      "website",
      "session-a",
      10
    );
    assert.equal(capturedFilter.channel, "website");
    assert.equal(capturedFilter.conversationId, "session-a");
    assert.ok(capturedFilter.businessId);
    assert.equal("restaurantId" in capturedFilter, false);
  } finally {
    AgentConversationMessage.find = originalFind;
  }
});

test("external commerce client uses trusted endpoint credentials and grounded product URLs", async () => {
  const business = makeBusiness();
  const requests = [];
  const result = await searchCommerceProducts(business, "phone", 2, {
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(
        JSON.stringify({
          products: [
            {
              id: "phone-1",
              name: "Phone One",
              price: 1250,
              currency: "GHS",
              available: true,
              stockQuantity: 4,
              canonicalUrl: "https://shop.example.com/products/phone-1"
            }
          ],
          total: 1
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://catalog.example.com/v1/products/search?query=phone&limit=2"
  );
  assert.equal(requests[0].options.headers.Authorization, "Bearer trusted-api-key");
  assert.equal(result.products[0].canonicalUrl, "https://shop.example.com/products/phone-1");
});

test("external catalog rejects unapproved product URL hosts", async () => {
  const business = makeBusiness();

  await assert.rejects(
    searchCommerceProducts(business, "phone", 2, {
      fetch: async () =>
        new Response(
          JSON.stringify({
            products: [
              {
                id: "phone-1",
                name: "Phone One",
                price: 1250,
                currency: "GHS",
                available: true,
                canonicalUrl: "https://attacker.example/products/phone-1"
              }
            ]
          }),
          { status: 200 }
        )
    }),
    (error) =>
      error instanceof CommerceIntegrationError &&
      error.code === "COMMERCE_RESPONSE_INVALID"
  );
});

test("missing commerce credentials fail safely without making a request", async () => {
  const business = makeBusiness();
  business.commerceIntegration.apiKey = undefined;
  let requested = false;
  const result = await executeAgentTool(
    "search_products",
    { query: "phone", limit: 2 },
    {
      businessId: String(business._id),
      businessType: "ecommerce",
      business,
      channel: "website",
      capabilities: ["website_chat", "commerce_catalog_read"],
      conversationId: "session-12345678",
      sender: makeOrchestratorInput(business).sender,
      originalMessage: "Find a phone"
    }
  );

  assert.equal(requested, false);
  assert.equal(result.success, false);
  assert.equal(result.code, "COMMERCE_INTEGRATION_NOT_CONFIGURED");
  assert.equal(JSON.stringify(result).includes("apiKey"), false);
});

test("website integration secrets are hashed and compared without storing plaintext", () => {
  const secret = "a-secure-integration-key-value";
  const hash = hashWebsiteIntegrationKey(secret);
  assert.notEqual(hash, secret);
  assert.equal(verifyWebsiteIntegrationKey(secret, hash), true);
  assert.equal(verifyWebsiteIntegrationKey("wrong-secret-value-000000", hash), false);

  const serialized = makeBusiness().toJSON();
  assert.equal(serialized.websiteIntegration.integrationKeyHash, undefined);
  assert.equal(serialized.commerceIntegration.apiKey, undefined);
});

test("website conversations use unpredictable signed continuation credentials", () => {
  const business = makeBusiness();
  const businessId = String(business._id);
  const hash = business.websiteIntegration.integrationKeyHash;
  const identity = createWebsiteConversationIdentity(businessId, hash);

  assert.match(identity.conversationId, /^[A-Za-z0-9_-]{43}$/);
  assert.match(identity.conversationToken, /^v1\.[A-Za-z0-9_-]{43}$/);
  assert.equal(
    verifyWebsiteConversationIdentity(
      businessId,
      identity.conversationId,
      identity.conversationToken,
      hash
    ),
    true
  );
  assert.equal(
    verifyWebsiteConversationIdentity(
      new Types.ObjectId().toString(),
      identity.conversationId,
      identity.conversationToken,
      hash
    ),
    false
  );
  assert.equal(
    verifyWebsiteConversationIdentity(
      businessId,
      "A".repeat(43),
      identity.conversationToken,
      hash
    ),
    false
  );
});

test("guessed website conversation credentials cannot continue another visitor history", async () => {
  const business = makeBusiness();
  const response = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  let nextError;

  await handleWebsiteChat(
    {
      trustedBusiness: business,
      body: {
        conversationId: "A".repeat(43),
        conversationToken: `v1.${"B".repeat(43)}`,
        message: "Show my previous search"
      },
      header: () => undefined
    },
    response,
    (error) => {
      nextError = error;
    }
  );

  assert.equal(nextError, undefined);
  assert.equal(response.statusCode, 401);
  assert.match(response.body.message, /conversation authorization/i);
});

test("anonymous website visitors are never marked identity verified", async () => {
  const business = makeBusiness();
  const identity = createWebsiteConversationIdentity(
    String(business._id),
    business.websiteIntegration.integrationKeyHash
  );
  let capturedInput;

  await handleWebsiteChatMessage(
    {
      business,
      conversationId: identity.conversationId,
      message: "Find a phone"
    },
    {
      runOrchestrator: async (input) => {
        capturedInput = input;
        return {
          success: true,
          message: "Okay",
          provider: "openrouter",
          model: "test-model",
          executedTools: []
        };
      },
      saveMessage: async () => undefined
    }
  );

  assert.equal(capturedInput.sender.verified, false);
  assert.equal(
    capturedInput.sender.identityKey,
    `website:anonymous:${identity.conversationId}`
  );
});

test("business-wide website rate limits cannot be reset with new conversation IDs", () => {
  resetWebsiteChatRateLimitsForTests();
  const business = makeBusiness({
    websiteIntegration: {
      enabled: true,
      integrationKeyHash: hashWebsiteIntegrationKey("a-secure-integration-key-value"),
      allowedOrigins: [],
      requestsPerMinute: 2
    }
  });

  const invoke = (conversationId) => {
    let nextCalled = false;
    const response = {
      statusCode: 200,
      headers: {},
      body: undefined,
      setHeader(name, value) {
        this.headers[name] = value;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      }
    };
    enforceWebsiteChatRateLimit(
      { trustedBusiness: business, body: { conversationId } },
      response,
      () => {
        nextCalled = true;
      }
    );
    return { nextCalled, response };
  };

  assert.equal(invoke("A".repeat(43)).nextCalled, true);
  assert.equal(invoke("B".repeat(43)).nextCalled, true);
  const blocked = invoke("C".repeat(43));
  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.response.statusCode, 429);
  assert.equal(blocked.response.headers["X-RateLimit-Scope"], "business");
  assert.ok(Number(blocked.response.headers["Retry-After"]) >= 1);
  resetWebsiteChatRateLimitsForTests();
});

test("website rate limiting retains a per-conversation burst cap", () => {
  resetWebsiteChatRateLimitsForTests();
  const business = makeBusiness({
    websiteIntegration: {
      enabled: true,
      integrationKeyHash: hashWebsiteIntegrationKey("a-secure-integration-key-value"),
      allowedOrigins: [],
      requestsPerMinute: 100
    }
  });
  const conversationId = "A".repeat(43);
  let lastResponse;

  for (let index = 0; index < 31; index += 1) {
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json() {
        return this;
      }
    };
    enforceWebsiteChatRateLimit(
      { trustedBusiness: business, body: { conversationId } },
      response,
      () => undefined
    );
    lastResponse = response;
  }

  assert.equal(lastResponse.statusCode, 429);
  assert.equal(lastResponse.headers["X-RateLimit-Scope"], "conversation");
  resetWebsiteChatRateLimitsForTests();
});

test("website chat rejects client-supplied trusted business context", () => {
  const parsed = websiteChatMessageSchema.safeParse({
    conversationId: "session-12345678",
    message: "Find a laptop",
    businessId: "attacker-business",
    businessType: "restaurant",
    channel: "whatsapp",
    capabilities: ["restaurant_operations"]
  });

  assert.equal(parsed.success, false);
});

test("mismatched Wasender receiver and session fail closed", async () => {
  const originalFindOne = Restaurant.findOne;
  const first = { _id: new Types.ObjectId() };
  const second = { _id: new Types.ObjectId() };

  Restaurant.findOne = (filter) => ({
    select: async () => (filter.$or ? first : second)
  });

  try {
    const result = await findRestaurantForWebhook({
      receiver: "+233200000001",
      sessionId: "different-session"
    });
    assert.equal(result, null);
  } finally {
    Restaurant.findOne = originalFindOne;
  }
});

test("Wasender routing accepts one trusted tenant identifier when the other is absent or unconfigured", async () => {
  const originalFindOne = Restaurant.findOne;
  const restaurant = { _id: new Types.ObjectId() };

  try {
    Restaurant.findOne = (filter) => ({
      select: async () => filter.$or ? null : restaurant
    });
    assert.equal(
      await findRestaurantForWebhook({
        receiver: "+233200000099",
        sessionId: "trusted-session"
      }),
      restaurant
    );

    Restaurant.findOne = () => ({ select: async () => restaurant });
    assert.equal(
      await findRestaurantForWebhook({
        receiver: "+233200000001",
        sessionId: ""
      }),
      restaurant
    );
  } finally {
    Restaurant.findOne = originalFindOne;
  }
});

test("representative Wasender payload shapes preserve session, receiver, sender, and message", () => {
  const webhook = normalizeIncomingWebhook({
    event: "messages.received",
    sessionId: "restaurant-session-redacted",
    receiver: "+233200000001",
    data: {
      messages: {
        key: {
          id: "message-redacted-1",
          fromMe: false,
          cleanedSenderPn: "+233500000001",
          remoteJid: "233500000001@s.whatsapp.net"
        },
        message: {
          conversation: "Hello, I want to order"
        }
      }
    }
  });

  assert.equal(webhook.event, "messages.received");
  assert.equal(webhook.sessionId, "restaurant-session-redacted");
  assert.equal(webhook.receiver, "+233200000001");
  assert.equal(webhook.senderPhone, "+233500000001");
  assert.equal(webhook.message, "Hello, I want to order");
  assert.equal(webhook.fromMe, false);
});

test("production Wasender webhooks fail closed when no secret is configured", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecret = process.env.WASENDER_WEBHOOK_SECRET;
  process.env.NODE_ENV = "production";
  delete process.env.WASENDER_WEBHOOK_SECRET;

  try {
    const request = {
      header: () => undefined,
      query: {}
    };
    assert.equal(isWebhookVerified(request), false);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalSecret === undefined) delete process.env.WASENDER_WEBHOOK_SECRET;
    else process.env.WASENDER_WEBHOOK_SECRET = originalSecret;
  }
});
