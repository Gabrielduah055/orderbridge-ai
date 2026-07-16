const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveSenderIdentity } = require("../dist/services/senderIdentity.service");
const {
  isToolAllowedForRole,
  getAllowedToolNamesForRole
} = require("../dist/agent-tools/tool.permissions");
const {
  buildHermesSessionKey,
  sendHermesAgentMessage
} = require("../dist/services/hermesAgent.service");
const {
  handleMcpRequest,
  isMcpBearerTokenAuthorized,
  mcpTools
} = require("../dist/controllers/mcp.controller");

const restaurant = {
  ownerName: "Gabriel",
  ownerPhone: "+233507879374",
  managerPhones: ["0507879375"],
  managerContacts: [{ name: "Ama", phone: "233507879376" }]
};

test("owner number resolves to owner", () => {
  const sender = resolveSenderIdentity(restaurant, "0507879374");

  assert.equal(sender.role, "owner");
  assert.equal(sender.verified, true);
  assert.equal(sender.name, "Gabriel");
  assert.equal(sender.normalizedPhone, "+233507879374");
});

test("manager number resolves to manager from managerPhones", () => {
  const sender = resolveSenderIdentity(restaurant, "+233507879375");

  assert.equal(sender.role, "manager");
  assert.equal(sender.verified, true);
});

test("manager number resolves to manager from managerContacts", () => {
  const sender = resolveSenderIdentity(restaurant, "0507879376");

  assert.equal(sender.role, "manager");
  assert.equal(sender.verified, true);
  assert.equal(sender.name, "Ama");
});

test("unknown number resolves to customer", () => {
  const sender = resolveSenderIdentity(restaurant, "233557038547");

  assert.equal(sender.role, "customer");
  assert.equal(sender.verified, false);
  assert.equal(sender.normalizedPhone, "+233557038547");
});

test("customers and managers cannot update menu prices", () => {
  assert.equal(isToolAllowedForRole("update_menu_price", "customer"), false);
  assert.equal(isToolAllowedForRole("update_menu_price", "manager"), false);
});

test("owner can prepare a menu price update", () => {
  assert.equal(isToolAllowedForRole("update_menu_price", "owner"), true);
});

test("only owner can add menu items through tools", () => {
  assert.equal(isToolAllowedForRole("add_menu_items", "owner"), true);
  assert.equal(isToolAllowedForRole("add_menu_items", "manager"), false);
  assert.equal(isToolAllowedForRole("add_menu_items", "customer"), false);
});

test("customer ordering uses draft tools instead of raw create order", () => {
  assert.equal(isToolAllowedForRole("create_order", "customer"), false);
  assert.equal(isToolAllowedForRole("start_order", "customer"), true);
  assert.equal(isToolAllowedForRole("add_order_item_by_name", "customer"), true);
  assert.equal(isToolAllowedForRole("update_order_draft", "customer"), true);
  assert.equal(isToolAllowedForRole("confirm_order_draft", "customer"), true);
});

test("unsupported promotion tool is not exposed", () => {
  assert.equal(isToolAllowedForRole("create_promotion", "owner"), false);
  assert.equal(getAllowedToolNamesForRole("owner").includes("create_promotion"), false);
});

test("customer message reaches Hermes with stable session key", async () => {
  const originalFetch = global.fetch;
  const originalAgentUrl = process.env.HERMES_AGENT_URL;
  const originalApiKey = process.env.HERMES_API_KEY;
  const calls = [];

  process.env.HERMES_AGENT_URL = "https://hermes.example/v1/responses";
  process.env.HERMES_API_KEY = "hermes-api-secret";
  global.fetch = async (_url, options) => {
    calls.push(options);

    return {
      ok: true,
      json: async () => ({
        id: "resp_1",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Hello from Hermes" }]
          }
        ]
      })
    };
  };

  try {
    const sender = resolveSenderIdentity(restaurant, "233557038547");
    const result = await sendHermesAgentMessage(
      { _id: "64b000000000000000000001", name: "Test Kitchen" },
      sender,
      "Hi"
    );
    const body = JSON.parse(calls[0].body);

    assert.equal(result.message, "Hello from Hermes");
    assert.equal(calls[0].headers.Authorization, "Bearer hermes-api-secret");
    assert.equal(
      calls[0].headers["X-Hermes-Session-Key"],
      "64b000000000000000000001:+233557038547"
    );
    assert.equal(body.input, "Hi");
    assert.match(body.instructions, /"senderRole":"customer"/);
    assert.match(body.instructions, /"sessionKey":"64b000000000000000000001:\+233557038547"/);
  } finally {
    global.fetch = originalFetch;
    process.env.HERMES_AGENT_URL = originalAgentUrl;
    process.env.HERMES_API_KEY = originalApiKey;
  }
});

test("conversation continuity reuses Hermes session key", async () => {
  const originalFetch = global.fetch;
  const originalAgentUrl = process.env.HERMES_AGENT_URL;
  const originalApiKey = process.env.HERMES_API_KEY;
  const sessionKeys = [];

  process.env.HERMES_AGENT_URL = "https://hermes.example/v1/responses";
  process.env.HERMES_API_KEY = "hermes-api-secret";
  global.fetch = async (_url, options) => {
    sessionKeys.push(options.headers["X-Hermes-Session-Key"]);

    return {
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "ok" }]
          }
        ]
      })
    };
  };

  try {
    const sender = resolveSenderIdentity(restaurant, "233557038547");
    const testRestaurant = { _id: "64b000000000000000000001", name: "Test Kitchen" };

    await sendHermesAgentMessage(testRestaurant, sender, "What food do you have?");
    await sendHermesAgentMessage(testRestaurant, sender, "Which one would you recommend?");

    assert.equal(sessionKeys.length, 2);
    assert.equal(sessionKeys[0], sessionKeys[1]);
  } finally {
    global.fetch = originalFetch;
    process.env.HERMES_AGENT_URL = originalAgentUrl;
    process.env.HERMES_API_KEY = originalApiKey;
  }
});

test("same phone uses different Hermes session keys per restaurant", () => {
  const sender = resolveSenderIdentity(restaurant, "233557038547");

  assert.notEqual(
    buildHermesSessionKey("64b000000000000000000001", sender),
    buildHermesSessionKey("64b000000000000000000002", sender)
  );
});

test("customer cannot update price even if Hermes requests the tool", () => {
  assert.equal(isToolAllowedForRole("update_menu_price", "customer"), false);
});

test("MCP tools require sessionKey instead of the old signed context field", () => {
  const updatePriceTool = mcpTools.find((tool) => tool.name === "update_price");
  const oldContextField = ["context", "Token"].join("");

  assert.ok(updatePriceTool);
  assert.deepEqual(updatePriceTool.inputSchema.required, ["sessionKey"]);
  assert.equal(updatePriceTool.inputSchema.properties[oldContextField], undefined);
  assert.equal(updatePriceTool.inputSchema.properties.sessionKey.type, "string");
});

test("MCP authentication uses only MCP_SHARED_SECRET", async () => {
  const originalSecret = process.env.MCP_SHARED_SECRET;
  const oldHermesServerKeyName = ["HERMES_API", "SERVER_KEY"].join("_");
  const originalServerKey = process.env[oldHermesServerKeyName];

  process.env.MCP_SHARED_SECRET = "mcp-secret";
  process.env[oldHermesServerKeyName] = "old-shared-secret";

  try {
    assert.equal(isMcpBearerTokenAuthorized("old-shared-secret"), false);
    assert.equal(isMcpBearerTokenAuthorized("mcp-secret"), true);

    let statusCode;
    let body;
    const req = {
      header: (name) => (name.toLowerCase() === "authorization" ? "Bearer wrong" : undefined),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
    };
    const res = {
      status: (code) => {
        statusCode = code;
        return res;
      },
      json: (value) => {
        body = value;
        return res;
      }
    };

    await handleMcpRequest(req, res);

    assert.equal(statusCode, 401);
    assert.deepEqual(body, { error: "Unauthorized" });
  } finally {
    process.env.MCP_SHARED_SECRET = originalSecret;
    process.env[oldHermesServerKeyName] = originalServerKey;
  }
});

test("Hermes API failure returns null for safe upstream handling", async () => {
  const originalFetch = global.fetch;
  const originalAgentUrl = process.env.HERMES_AGENT_URL;
  const originalApiKey = process.env.HERMES_API_KEY;

  process.env.HERMES_AGENT_URL = "https://hermes.example/v1/responses";
  process.env.HERMES_API_KEY = "hermes-api-secret";
  global.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({})
  });

  try {
    const sender = resolveSenderIdentity(restaurant, "233557038547");
    const result = await sendHermesAgentMessage(
      { _id: "64b000000000000000000001", name: "Test Kitchen" },
      sender,
      "Hi"
    );

    assert.equal(result, null);
  } finally {
    global.fetch = originalFetch;
    process.env.HERMES_AGENT_URL = originalAgentUrl;
    process.env.HERMES_API_KEY = originalApiKey;
  }
});
