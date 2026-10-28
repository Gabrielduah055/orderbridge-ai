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
      return {
        text: "I found {{P1.name}} at {{P1.price}}. It is {{P1.availability}}: {{P1.url}}",
        toolCalls: []
      };
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
  assert.match(result.message, /available/i);
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
                text: "It costs USD 1, is unavailable, has 2 TB storage and titanium blades, and is at https://attacker.example/fake.",
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
  assert.match(result.message, /available/i);
  assert.match(result.message, /storage: 256 GB/i);
  assert.match(result.message, /https:\/\/shop\.example\.com\/products\/p1/);
  assert.doesNotMatch(result.message, /USD 1|unavailable|2 TB|titanium|attacker\.example/i);
});

test("commerce grounding rejects invented warranties, durability, discounts, specifications, and features", async () => {
  const unsupportedResponses = [
    "I recommend {{P1.name}} for its guaranteed ten-year lifespan.",
    "{{P1.name}} comes with a lifetime durability guarantee.",
    "{{P1.name}} is discounted by 25% today.",
    "I recommend {{P1.name}} because of its self-cleaning mode.",
    "{{P1.name}} includes titanium blades and twelve speed settings."
  ];

  for (const unsupportedResponse of unsupportedResponses) {
    const business = makeBusiness();
    let round = 0;
    const result = await runAgentOrchestrator(
      makeOrchestratorInput(business, "Recommend the catalog blender"),
      {
        provider: {
          name: "openrouter",
          model: "shared-orderbridge-model",
          complete: async () =>
            round++ === 0
              ? {
                  toolCalls: [
                    {
                      id: `unsupported-${round}`,
                      name: "search_products",
                      arguments: { query: "blender", limit: 1 }
                    }
                  ]
                }
              : { text: unsupportedResponse, toolCalls: [] }
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
                id: "plain-blend",
                name: "Plain Blend",
                price: 600,
                currency: "GHS",
                available: true,
                specifications: { capacity: "1.5 L" },
                canonicalUrl: "https://shop.example.com/products/plain-blend"
              }
            ],
            total: 1
          }
        })
      }
    );

    assert.match(result.message, /verified catalog|verified options/i);
    assert.doesNotMatch(
      result.message,
      /ten-year|lifetime|durability guarantee|25%|self-cleaning|titanium|twelve speed/i
    );
  }
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

test("shopping assistant recommends verified products naturally within the customer's budget", async () => {
  const business = makeBusiness();
  let round = 0;
  let capturedArguments;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(
      business,
      "Recommend a blender for smoothies under GHS 1,500"
    ),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () =>
          round++ === 0
            ? {
                toolCalls: [
                  {
                    id: "budget-search",
                    name: "search_products",
                    arguments: {
                      query: "blender",
                      category: "kitchen appliances",
                      maxPrice: 1500,
                      available: true,
                      preferences: ["smoothies"],
                      sort: "relevance",
                      limit: 5
                    }
                  }
                ]
              }
            : {
                text: "For smoothies, I'd recommend {{P2.name}}. Its verified power is {{P2.spec1}}, and it is {{P2.availability}} at {{P2.price}}. Product page: {{P2.url}}",
                toolCalls: []
              }
      },
      getHistory: async () => [],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async (_name, args) => {
        capturedArguments = args;
        return {
          success: true,
          message: "Products retrieved successfully.",
          data: {
            products: [
              {
                id: "blend-basic",
                name: "Blend Basic",
                price: 700,
                currency: "GHS",
                available: true,
                specifications: { power: "500 W" },
                canonicalUrl: "https://shop.example.com/products/blend-basic"
              },
              {
                id: "blend-pro",
                name: "Blend Pro",
                price: 1200,
                currency: "GHS",
                available: true,
                specifications: { power: "1000 W" },
                canonicalUrl: "https://shop.example.com/products/blend-pro"
              }
            ],
            total: 2
          }
        };
      }
    }
  );

  assert.deepEqual(capturedArguments, {
    query: "blender",
    category: "kitchen appliances",
    maxPrice: 1500,
    available: true,
    preferences: ["smoothies"],
    sort: "relevance",
    limit: 5
  });
  assert.match(result.message, /recommend Blend Pro/i);
  assert.match(result.message, /1000 W/);
  assert.match(result.message, /GHS 1,200/);
  assert.match(result.message, /https:\/\/shop\.example\.com\/products\/blend-pro/);
});

test("shopping assistant compares products accumulated from separate detail tool calls", async () => {
  const business = makeBusiness();
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(
      business,
      "Compare the first two blenders and recommend one for larger smoothies"
    ),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () =>
          round++ === 0
            ? {
                toolCalls: [
                  {
                    id: "detail-1",
                    name: "get_product_details",
                    arguments: { productId: "blend-one" }
                  },
                  {
                    id: "detail-2",
                    name: "get_product_details",
                    arguments: { productId: "blend-two" }
                  }
                ]
              }
            : {
                text: "Between {{P1.name}} and {{P2.name}}, I'd choose {{P2.name}} for larger batches. Its jar is {{P2.spec1}}, compared with {{P1.spec1}}. They cost {{P1.price}} and {{P2.price}}. Links: {{P1.url}} and {{P2.url}}.",
                toolCalls: []
              }
      },
      getHistory: async () => [],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async (_name, args) => ({
        success: true,
        message: "Product details retrieved successfully.",
        data: {
          product: args.productId === "blend-one"
            ? {
                id: "blend-one",
                name: "Compact Blend",
                price: 800,
                currency: "GHS",
                available: true,
                specifications: { capacity: "1.2 L" },
                canonicalUrl: "https://shop.example.com/products/blend-one"
              }
            : {
                id: "blend-two",
                name: "Family Blend",
                price: 1100,
                currency: "GHS",
                available: true,
                specifications: { capacity: "2 L" },
                canonicalUrl: "https://shop.example.com/products/blend-two"
              }
        }
      })
    }
  );

  assert.match(result.message, /Compact Blend/);
  assert.match(result.message, /Family Blend/);
  assert.match(result.message, /1\.2 L/);
  assert.match(result.message, /2 L/);
  assert.match(result.message, /choose Family Blend/i);
  assert.equal(result.data.products.length, 2);
});

test("multi-turn shopping follow-up resolves which verified product is cheaper", async () => {
  const business = makeBusiness();
  let firstRound = 0;
  const first = await runAgentOrchestrator(
    makeOrchestratorInput(business, "Show me two blenders"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () =>
          firstRound++ === 0
            ? {
                toolCalls: [
                  {
                    id: "follow-search",
                    name: "search_products",
                    arguments: { query: "blenders", limit: 2 }
                  }
                ]
              }
            : {
                text: "I found {{P1.name}} at {{P1.price}} and {{P2.name}} at {{P2.price}}.",
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
              id: "cheap",
              name: "Budget Blend",
              price: 650,
              currency: "GHS",
              available: true,
              canonicalUrl: "https://shop.example.com/products/cheap"
            },
            {
              id: "premium",
              name: "Premium Blend",
              price: 1250,
              currency: "GHS",
              available: true,
              canonicalUrl: "https://shop.example.com/products/premium"
            }
          ],
          total: 2
        }
      })
    }
  );

  let sawGroundingContract = false;
  const second = await runAgentOrchestrator(
    makeOrchestratorInput(business, "Which is cheaper?"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async (request) => {
          sawGroundingContract = request.messages.some(
            (message) =>
              message.role === "system" &&
              message.content?.includes("{{P1.price}}") &&
              message.content?.includes("{{P2.price}}")
          );
          return {
            text: "{{P1.name}} is the cheaper option at {{P1.price}}; {{P2.name}} is {{P2.price}}.",
            toolCalls: []
          };
        }
      },
      getHistory: async () => [
        {
          role: "assistant",
          content: first.message,
          metadata: { commerceGrounding: first.data.commerceGrounding }
        }
      ],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt"
    }
  );

  assert.equal(sawGroundingContract, true);
  assert.match(second.message, /previously verified catalog information/i);
  assert.match(second.message, /Budget Blend is the cheaper option at GHS 650/);
  assert.match(second.message, /Premium Blend is GHS 1,250/);
  assert.equal(second.executedTools.length, 0);
  assert.equal(second.data.commerceDataFreshness.price, "cached");
});

test("a current price enquiry refreshes cached product data and uses the changed price", async () => {
  const business = makeBusiness();
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(business, "What is the current price of the blender?"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () =>
          round++ === 0
            ? {
                toolCalls: [
                  {
                    id: "price-refresh",
                    name: "get_product_details",
                    arguments: { productId: "changing-price" }
                  }
                ]
              }
            : {
                text: "The current price of {{P1.name}} is {{P1.price}}.",
                toolCalls: []
              }
      },
      getHistory: async () => [
        {
          role: "assistant",
          content: "Earlier product details",
          metadata: {
            commerceGrounding: {
              capturedAt: new Date().toISOString(),
              products: [
                {
                  id: "changing-price",
                  name: "Changing Price Blend",
                  price: 500,
                  currency: "GHS",
                  available: true,
                  canonicalUrl: "https://shop.example.com/products/changing-price"
                }
              ],
              availability: [],
              policies: []
            }
          }
        }
      ],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async () => ({
        success: true,
        message: "Product details retrieved successfully.",
        data: {
          product: {
            id: "changing-price",
            name: "Changing Price Blend",
            price: 650,
            currency: "GHS",
            available: true,
            canonicalUrl: "https://shop.example.com/products/changing-price"
          }
        }
      })
    }
  );

  assert.match(result.message, /GHS 650/);
  assert.doesNotMatch(result.message, /GHS 500/);
  assert.equal(result.data.product.price, 650);
  assert.equal(result.data.commerceDataFreshness.price, "live");
});

test("an inventory enquiry refreshes cached availability and uses the changed stock state", async () => {
  const business = makeBusiness();
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(business, "Is the blender still available?"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () =>
          round++ === 0
            ? {
                toolCalls: [
                  {
                    id: "inventory-refresh",
                    name: "check_product_availability",
                    arguments: { productId: "changing-stock" }
                  }
                ]
              }
            : {
                text: "{{P1.name}} is now {{P1.availability}}.",
                toolCalls: []
              }
      },
      getHistory: async () => [
        {
          role: "assistant",
          content: "Earlier product details",
          metadata: {
            commerceGrounding: {
              capturedAt: new Date().toISOString(),
              products: [
                {
                  id: "changing-stock",
                  name: "Changing Stock Blend",
                  price: 800,
                  currency: "GHS",
                  available: true,
                  stockQuantity: 5,
                  canonicalUrl: "https://shop.example.com/products/changing-stock"
                }
              ],
              availability: [],
              policies: []
            }
          }
        }
      ],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async () => ({
        success: true,
        message: "Availability retrieved successfully.",
        data: {
          productId: "changing-stock",
          available: false,
          stockQuantity: 0
        }
      })
    }
  );

  assert.match(result.message, /Changing Stock Blend is now unavailable/);
  assert.equal(result.data.products[0].available, false);
  assert.equal(result.data.products[0].stockQuantity, 0);
  assert.equal(result.data.productAvailability.available, false);
  assert.equal(result.data.commerceDataFreshness.availability, "live");
});

test("a failed current-product refresh never substitutes cached price or inventory", async () => {
  const business = makeBusiness();
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(
      business,
      "What is the current price and availability of the blender?"
    ),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () =>
          round++ === 0
            ? {
                toolCalls: [
                  {
                    id: "failed-current-refresh",
                    name: "get_product_details",
                    arguments: { productId: "failed-refresh" }
                  }
                ]
              }
            : {
                text: "{{P1.name}} is {{P1.availability}} at {{P1.price}}.",
                toolCalls: []
              }
      },
      getHistory: async () => [
        {
          role: "assistant",
          content: "Earlier product details",
          metadata: {
            commerceGrounding: {
              capturedAt: new Date().toISOString(),
              products: [
                {
                  id: "failed-refresh",
                  name: "Failed Refresh Blend",
                  price: 500,
                  currency: "GHS",
                  available: true,
                  stockQuantity: 3,
                  canonicalUrl: "https://shop.example.com/products/failed-refresh"
                }
              ],
              availability: [],
              policies: []
            }
          }
        }
      ],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async () => ({
        success: false,
        code: "COMMERCE_PROVIDER_UNAVAILABLE",
        message: "Current product information could not be verified."
      })
    }
  );

  assert.equal(result.message, "Current product information could not be verified.");
  assert.equal("products" in result.data, false);
  assert.equal("product" in result.data, false);
  assert.equal("productAvailability" in result.data, false);
  assert.deepEqual(result.data.commerceGrounding.products, []);
  assert.doesNotMatch(result.message, /GHS 500|available/i);
});

test("backend unavailability is rendered from the latest authoritative result", async () => {
  const business = makeBusiness();
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(business, "Is the blender available?"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () =>
          round++ === 0
            ? {
                toolCalls: [
                  {
                    id: "unavailable-search",
                    name: "search_products",
                    arguments: { query: "blender", limit: 1 }
                  }
                ]
              }
            : {
                text: "{{P1.name}} is currently {{P1.availability}}. Product page: {{P1.url}}",
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
              id: "sold-out",
              name: "Sold Out Blend",
              price: 900,
              currency: "GHS",
              available: false,
              canonicalUrl: "https://shop.example.com/products/sold-out"
            }
          ],
          total: 1
        }
      })
    }
  );

  assert.match(result.message, /Sold Out Blend is currently unavailable/);
  assert.doesNotMatch(result.message, /currently available\b/i);
});

test("a failed availability check suppresses older search availability", async () => {
  const business = makeBusiness();
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(business, "Is Fresh Blend still available?"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () => {
          if (round++ === 0) {
            return {
              toolCalls: [
                {
                  id: "availability-search",
                  name: "search_products",
                  arguments: { query: "Fresh Blend", limit: 1 }
                }
              ]
            };
          }
          if (round === 2) {
            return {
              toolCalls: [
                {
                  id: "availability-failed",
                  name: "check_product_availability",
                  arguments: { productId: "fresh-blend" }
                }
              ]
            };
          }
          return {
            text: "{{P1.name}} is {{P1.availability}}.",
            toolCalls: []
          };
        }
      },
      getHistory: async () => [],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async (name) =>
        name === "search_products"
          ? {
              success: true,
              message: "Products retrieved successfully.",
              data: {
                products: [
                  {
                    id: "fresh-blend",
                    name: "Fresh Blend",
                    price: 1000,
                    currency: "GHS",
                    available: true,
                    canonicalUrl: "https://shop.example.com/products/fresh-blend"
                  }
                ],
                total: 1
              }
            }
          : {
              success: false,
              code: "COMMERCE_PROVIDER_UNAVAILABLE",
              message: "Current availability could not be verified."
            }
    }
  );

  assert.equal(result.message, "Current availability could not be verified.");
  assert.doesNotMatch(result.message, /is available/i);
  assert.equal("available" in result.data.products[0], false);
});

test("a newer availability result overrides earlier search availability", async () => {
  const business = makeBusiness();
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(business, "Check Current Blend availability"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () => {
          if (round++ === 0) {
            return {
              toolCalls: [
                {
                  id: "override-search",
                  name: "search_products",
                  arguments: { query: "Current Blend", limit: 1 }
                },
                {
                  id: "override-availability",
                  name: "check_product_availability",
                  arguments: { productId: "current-blend" }
                }
              ]
            };
          }
          return {
            text: "{{P1.name}} is now {{P1.availability}}.",
            toolCalls: []
          };
        }
      },
      getHistory: async () => [],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async (name) =>
        name === "search_products"
          ? {
              success: true,
              message: "Products retrieved successfully.",
              data: {
                products: [
                  {
                    id: "current-blend",
                    name: "Current Blend",
                    price: 1000,
                    currency: "GHS",
                    available: true,
                    canonicalUrl: "https://shop.example.com/products/current-blend"
                  }
                ],
                total: 1
              }
            }
          : {
              success: true,
              message: "Product availability retrieved successfully.",
              data: {
                productId: "current-blend",
                available: false,
                stockQuantity: 0
              }
            }
    }
  );

  assert.match(result.message, /Current Blend is now unavailable/);
  assert.equal(result.data.products[0].available, false);
  assert.equal(result.data.products[0].stockQuantity, 0);
});

test("business policy answers remain conversational after a product search", async () => {
  const business = makeBusiness();
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(business, "Can I return the blender if it does not suit me?"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () => {
          if (round++ === 0) {
            return {
              toolCalls: [
                {
                  id: "policy-product",
                  name: "search_products",
                  arguments: { query: "blender", limit: 1 }
                }
              ]
            };
          }
          if (round === 2) {
            return {
              toolCalls: [
                {
                  id: "returns-policy",
                  name: "get_business_policies",
                  arguments: { topic: "returns" }
                }
              ]
            };
          }
          return {
            text: "For {{P1.name}}, the approved {{POLICY1.name}} says: {{POLICY1.content}} Full policy: {{POLICY1.url}}",
            toolCalls: []
          };
        }
      },
      getHistory: async () => [],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async (name) =>
        name === "search_products"
          ? {
              success: true,
              message: "Products retrieved successfully.",
              data: {
                products: [
                  {
                    id: "policy-blend",
                    name: "Policy Blend",
                    price: 950,
                    currency: "GHS",
                    available: true,
                    canonicalUrl: "https://shop.example.com/products/policy-blend"
                  }
                ],
                total: 1
              }
            }
          : {
              success: true,
              message: "Business policies retrieved successfully.",
              data: {
                policies: [
                  {
                    name: "Returns",
                    content: "Unused products may be returned within 14 days.",
                    url: "https://shop.example.com/policies/returns"
                  }
                ]
              }
            }
    }
  );

  assert.match(result.message, /Policy Blend/);
  assert.match(result.message, /Unused products may be returned within 14 days/);
  assert.match(result.message, /https:\/\/shop\.example\.com\/policies\/returns/);
  assert.equal(result.data.products.length, 1);
  assert.equal(result.data.policies.length, 1);
});

test("failed authoritative lookups remove stale structured fields while preserving unrelated verified results", async () => {
  const business = makeBusiness();
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(business, "Show the current return policy"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () => {
          if (round++ === 0) {
            return {
              toolCalls: [
                {
                  id: "structured-search",
                  name: "search_products",
                  arguments: { query: "blender", limit: 2 }
                },
                {
                  id: "structured-detail-success",
                  name: "get_product_details",
                  arguments: { productId: "stale-detail" }
                },
                {
                  id: "structured-availability",
                  name: "check_product_availability",
                  arguments: { productId: "stale-detail" }
                },
                {
                  id: "structured-policy",
                  name: "get_business_policies",
                  arguments: { topic: "returns" }
                }
              ]
            };
          }
          if (round === 2) {
            return {
              toolCalls: [
                {
                  id: "structured-detail-failure",
                  name: "get_product_details",
                  arguments: { productId: "stale-detail" }
                }
              ]
            };
          }
          return {
            text: "The verified {{POLICY1.name}} policy says: {{POLICY1.content}}",
            toolCalls: []
          };
        }
      },
      getHistory: async () => [],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async (name, args) => {
        if (name === "search_products") {
          return {
            success: true,
            message: "Products retrieved successfully.",
            data: {
              products: [
                {
                  id: "stale-detail",
                  name: "Stale Detail Blend",
                  price: 900,
                  currency: "GHS",
                  available: true,
                  canonicalUrl: "https://shop.example.com/products/stale-detail"
                },
                {
                  id: "unrelated",
                  name: "Unrelated Verified Blend",
                  price: 700,
                  currency: "GHS",
                  available: true,
                  canonicalUrl: "https://shop.example.com/products/unrelated"
                }
              ],
              total: 2
            }
          };
        }
        if (name === "get_product_details") {
          if (args.productId === "stale-detail" && round >= 2) {
            return {
              success: false,
              code: "COMMERCE_PROVIDER_UNAVAILABLE",
              message: "Product details could not be refreshed."
            };
          }
          return {
            success: true,
            message: "Product details retrieved successfully.",
            data: {
              product: {
                id: "stale-detail",
                name: "Stale Detail Blend",
                price: 900,
                currency: "GHS",
                available: true,
                canonicalUrl: "https://shop.example.com/products/stale-detail"
              }
            }
          };
        }
        if (name === "check_product_availability") {
          return {
            success: true,
            message: "Availability retrieved successfully.",
            data: {
              productId: "stale-detail",
              available: true,
              stockQuantity: 4
            }
          };
        }
        return {
          success: true,
          message: "Policies retrieved successfully.",
          data: {
            policies: [
              {
                name: "Returns",
                content: "Unused products may be returned within 14 days."
              }
            ]
          }
        };
      }
    }
  );

  assert.deepEqual(
    result.data.products.map((product) => product.id),
    ["unrelated"]
  );
  assert.equal("product" in result.data, false);
  assert.equal("productAvailability" in result.data, false);
  assert.equal(result.data.policies.length, 1);
  assert.match(result.message, /Unused products may be returned within 14 days/);
});

test("a failed policy refresh removes an older policy from structured data", async () => {
  const business = makeBusiness();
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(business, "Refresh the return policy"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () => {
          if (round++ === 0) {
            return {
              toolCalls: [
                {
                  id: "policy-success",
                  name: "get_business_policies",
                  arguments: { topic: "returns" }
                }
              ]
            };
          }
          if (round === 2) {
            return {
              toolCalls: [
                {
                  id: "policy-failure",
                  name: "get_business_policies",
                  arguments: { topic: "returns" }
                }
              ]
            };
          }
          return {
            text: "I could not verify the current return policy.",
            toolCalls: []
          };
        }
      },
      getHistory: async () => [],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async () =>
        round < 2
          ? {
              success: true,
              message: "Policies retrieved successfully.",
              data: {
                policies: [
                  {
                    name: "Returns",
                    content: "Unused products may be returned within 14 days."
                  }
                ]
              }
            }
          : {
              success: false,
              code: "COMMERCE_PROVIDER_UNAVAILABLE",
              message: "The current return policy could not be verified."
            }
    }
  );

  assert.equal("policies" in result.data, false);
  assert.deepEqual(result.data.commerceGrounding.policies, []);
  assert.doesNotMatch(result.message, /14 days/);
});

test("failed catalog requests cannot reuse stale facts and return a safe response", async () => {
  const business = makeBusiness();
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(business, "Find a current blender price"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () =>
          round++ === 0
            ? {
                toolCalls: [
                  {
                    id: "failed-search",
                    name: "search_products",
                    arguments: { query: "blender", limit: 2 }
                  }
                ]
              }
            : {
                text: "The blender costs GHS 1 and is available.",
                toolCalls: []
              }
      },
      getHistory: async () => [
        {
          role: "assistant",
          content: "Earlier options",
          metadata: {
            commerceGrounding: {
              capturedAt: new Date().toISOString(),
              products: [
                {
                  id: "stale",
                  name: "Stale Blend",
                  price: 500,
                  currency: "GHS",
                  available: true,
                  canonicalUrl: "https://shop.example.com/products/stale"
                }
              ],
              availability: [],
              policies: []
            }
          }
        }
      ],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async () => ({
        success: false,
        code: "COMMERCE_PROVIDER_UNAVAILABLE",
        message: "Product information is temporarily unavailable."
      })
    }
  );

  assert.equal(result.message, "Product information is temporarily unavailable.");
  assert.doesNotMatch(result.message, /Stale Blend|GHS 1/);
});

test("products with missing specifications still receive a natural grounded answer", async () => {
  const business = makeBusiness();
  let round = 0;
  const result = await runAgentOrchestrator(
    makeOrchestratorInput(business, "Tell me about the simple blender"),
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () =>
          round++ === 0
            ? {
                toolCalls: [
                  {
                    id: "missing-specs",
                    name: "get_product_details",
                    arguments: { productId: "simple" }
                  }
                ]
              }
            : {
                text: "{{P1.name}} is listed at {{P1.price}}. The catalog did not provide extra technical details, so I won't guess them. Product page: {{P1.url}}",
                toolCalls: []
              }
      },
      getHistory: async () => [],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted website prompt",
      executeTool: async () => ({
        success: true,
        message: "Product details retrieved successfully.",
        data: {
          product: {
            id: "simple",
            name: "Simple Blend",
            price: 450,
            currency: "GHS",
            available: true,
            canonicalUrl: "https://shop.example.com/products/simple"
          }
        }
      })
    }
  );

  assert.match(result.message, /Simple Blend is listed at GHS 450/);
  assert.match(result.message, /won't guess/i);
  assert.doesNotMatch(result.message, /undefined|null/i);
});

test("restaurant orchestrator responses remain unchanged by commerce grounding", async () => {
  const restaurantId = new Types.ObjectId();
  const result = await runAgentOrchestrator(
    {
      restaurant: { _id: restaurantId },
      sender: {
        identityKey: "whatsapp:+233500000001",
        phone: "+233500000001",
        normalizedAddress: "+233500000001",
        normalizedPhone: "+233500000001",
        role: "customer",
        verified: true
      },
      message: "Hello"
    },
    {
      provider: {
        name: "openrouter",
        model: "shared-orderbridge-model",
        complete: async () => ({
          text: "Welcome back to the restaurant assistant.",
          toolCalls: []
        })
      },
      getHistory: async () => [],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "trusted restaurant prompt"
    }
  );

  assert.equal(result.message, "Welcome back to the restaurant assistant.");
  assert.equal(result.executedTools.length, 0);
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

test("external commerce search forwards authoritative shopping filters to the business API", async () => {
  const business = makeBusiness();
  let requestedUrl;
  const result = await searchCommerceProducts(
    business,
    "blender",
    5,
    {
      minPrice: 300,
      maxPrice: 1500,
      category: "kitchen appliances",
      available: true,
      preferences: ["smoothies", "quiet"],
      sort: "price_asc"
    },
    {
      fetch: async (url) => {
        requestedUrl = new URL(String(url));
        return new Response(JSON.stringify({ products: [], total: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    }
  );

  assert.equal(result.total, 0);
  assert.equal(requestedUrl.searchParams.get("query"), "blender");
  assert.equal(requestedUrl.searchParams.get("minPrice"), "300");
  assert.equal(requestedUrl.searchParams.get("maxPrice"), "1500");
  assert.equal(requestedUrl.searchParams.get("category"), "kitchen appliances");
  assert.equal(requestedUrl.searchParams.get("available"), "true");
  assert.deepEqual(requestedUrl.searchParams.getAll("preference"), [
    "smoothies",
    "quiet"
  ]);
  assert.equal(requestedUrl.searchParams.get("sort"), "price_asc");
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

test("commerce search rejects invalid price ranges before calling the business API", async () => {
  const business = makeBusiness();
  const result = await executeAgentTool(
    "search_products",
    {
      category: "kitchen appliances",
      minPrice: 1500,
      maxPrice: 500,
      limit: 5
    },
    {
      businessId: String(business._id),
      businessType: "ecommerce",
      business,
      channel: "website",
      capabilities: ["website_chat", "commerce_catalog_read"],
      conversationId: "session-12345678",
      sender: makeOrchestratorInput(business).sender,
      originalMessage: "Find kitchen appliances"
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "TOOL_INVALID_ARGUMENTS");
  assert.match(result.message, /minPrice cannot exceed maxPrice/);
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
