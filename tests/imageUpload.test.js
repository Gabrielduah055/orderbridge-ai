const assert = require("node:assert/strict");
const test = require("node:test");
const { v2: cloudinary } = require("cloudinary");

const {
  decryptWasenderMedia,
  normalizeIncomingWebhook
} = require("../dist/services/wasender.service");
const {
  isEncryptedWhatsappMediaUrl,
  uploadDecryptedImageFromUrl
} = require("../dist/services/cloudinary.service");
const {
  attachPendingImageToNamedMenuItem,
  parseMenuItemImageIntent,
  prepareUploadedMenuItemImage,
  rememberMenuItemImageRequest
} = require("../dist/services/menuItemImageWorkflow.service");
const {
  buildCustomerImageFallbackMessage,
  sendCustomerMenuItemImage
} = require("../dist/controllers/wasender.controller");
const {
  runAgentOrchestrator
} = require("../dist/services/ai/agentOrchestrator.service");
const { executeAgentTool } = require("../dist/agent-tools/tool.executor");
const { MenuItem } = require("../dist/models/MenuItem");
const { PendingAgentAction } = require("../dist/models/pendingAgentAction.model");
const menuItemService = require("../dist/services/menuItem.service");
const {
  parseSpecificMenuItemViewRequest
} = require("../dist/services/restaurantAgent.service");

const restaurantId = "64b000000000000000000001";
const menuItemId = "64b000000000000000000301";
const senderPhone = "+233557038547";
const encryptedUrl = "https://mmg.whatsapp.net/o1/v/t62.7118-24/encrypted?token=signed";
const decryptedUrl = "https://www.wasenderapi.com/api/decrypted-media/message-1";
const cloudinaryUrl = "https://res.cloudinary.com/demo/image/upload/menu-items/chicken-salad.jpg";

const rawMessage = {
  key: {
    id: "message-1",
    fromMe: false,
    cleanedSenderPn: senderPhone
  },
  messageBody: "",
  message: {
    imageMessage: {
      url: encryptedUrl,
      mimetype: "image/jpeg",
      mediaKey: "sensitive-media-key",
      fileSha256: "sensitive-file-hash",
      fileLength: "12345"
    }
  }
};

const restoreEnv = (name, value) => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

test("webhook normalization preserves the complete raw WhatsApp image message", () => {
  const payload = {
    event: "messages.received",
    sessionId: "session-1",
    data: { messages: rawMessage }
  };

  const normalized = normalizeIncomingWebhook(payload);

  assert.equal(normalized.messageType, "image");
  assert.equal(normalized.mediaUrl, encryptedUrl);
  assert.deepEqual(normalized.rawMessage, rawMessage);
  assert.deepEqual(normalized.rawPayload.data.messages, rawMessage);
});

test("WaSender media decryption posts the full raw message with the restaurant token", async () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.WASENDER_API_URL;
  const originalFallbackKey = process.env.WASENDER_API_KEY;
  let request;

  process.env.WASENDER_API_URL = "https://wasender.example";
  process.env.WASENDER_API_KEY = "fallback-token";
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ success: true, publicUrl: decryptedUrl }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const result = await decryptWasenderMedia(rawMessage, { apiKey: "restaurant-token" });

    assert.equal(result, decryptedUrl);
    assert.equal(request.url, "https://wasender.example/api/decrypt-media");
    assert.equal(request.options.headers.Authorization, "Bearer restaurant-token");
    assert.deepEqual(JSON.parse(request.options.body), {
      data: { messages: rawMessage }
    });
  } finally {
    global.fetch = originalFetch;
    restoreEnv("WASENDER_API_URL", originalApiUrl);
    restoreEnv("WASENDER_API_KEY", originalFallbackKey);
  }
});

test("WaSender media decryption falls back to WASENDER_API_KEY", async () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.WASENDER_API_URL;
  const originalFallbackKey = process.env.WASENDER_API_KEY;
  let authorization;

  process.env.WASENDER_API_URL = "https://wasender.example/api";
  process.env.WASENDER_API_KEY = "fallback-token";
  global.fetch = async (_url, options) => {
    authorization = options.headers.Authorization;
    return new Response(JSON.stringify({ success: true, publicUrl: decryptedUrl }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    await decryptWasenderMedia(rawMessage);
    assert.equal(authorization, "Bearer fallback-token");
  } finally {
    global.fetch = originalFetch;
    restoreEnv("WASENDER_API_URL", originalApiUrl);
    restoreEnv("WASENDER_API_KEY", originalFallbackKey);
  }
});

test("Cloudinary receives only the decrypted public URL and rejects WhatsApp encrypted URLs", async () => {
  const originalUpload = cloudinary.uploader.upload;
  const originalCloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const originalApiKey = process.env.CLOUDINARY_API_KEY;
  const originalApiSecret = process.env.CLOUDINARY_API_SECRET;
  const uploads = [];

  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
  process.env.CLOUDINARY_API_KEY = "test-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  cloudinary.uploader.upload = async (source, options) => {
    uploads.push({ source, options });
    return { secure_url: cloudinaryUrl };
  };

  try {
    assert.equal(isEncryptedWhatsappMediaUrl(encryptedUrl), true);
    await assert.rejects(
      uploadDecryptedImageFromUrl(encryptedUrl),
      /Refusing to upload an encrypted WhatsApp media URL/
    );
    assert.equal(uploads.length, 0);

    const result = await uploadDecryptedImageFromUrl(decryptedUrl);
    assert.equal(result, cloudinaryUrl);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].source, decryptedUrl);
    assert.equal(uploads[0].options.resource_type, "image");
  } finally {
    cloudinary.uploader.upload = originalUpload;
    restoreEnv("CLOUDINARY_CLOUD_NAME", originalCloudName);
    restoreEnv("CLOUDINARY_API_KEY", originalApiKey);
    restoreEnv("CLOUDINARY_API_SECRET", originalApiSecret);
  }
});

test("menu item image request preserves Chicken Salad context until the image arrives", async () => {
  const originalFindOne = MenuItem.findOne;
  const originalUpdateMany = PendingAgentAction.updateMany;
  const originalCreate = PendingAgentAction.create;
  const created = [];

  MenuItem.findOne = async () => ({ _id: menuItemId, name: "Chicken Salad" });
  PendingAgentAction.updateMany = async () => ({ modifiedCount: 0 });
  PendingAgentAction.create = async (input) => {
    created.push(input);
    return { _id: "context-1", ...input };
  };

  try {
    assert.equal(parseMenuItemImageIntent("Add an image to Chicken Salad"), "Chicken Salad");
    const result = await rememberMenuItemImageRequest({
      restaurantId,
      senderPhone,
      senderRole: "manager",
      message: "Add an image to Chicken Salad"
    });

    assert.equal(result.handled, true);
    assert.equal(result.itemName, "Chicken Salad");
    assert.equal(created[0].action, "MENU_ITEM_IMAGE_CONTEXT");
    assert.deepEqual(created[0].data, {
      stage: "awaiting_image",
      itemId: menuItemId,
      itemName: "Chicken Salad"
    });
  } finally {
    MenuItem.findOne = originalFindOne;
    PendingAgentAction.updateMany = originalUpdateMany;
    PendingAgentAction.create = originalCreate;
  }
});

test("uploaded image uses preserved item context and creates an exact confirmation prompt", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  const originalUpdateMany = PendingAgentAction.updateMany;
  const originalCreate = PendingAgentAction.create;
  let created;

  PendingAgentAction.findOne = () => ({
    sort: async () => ({
      data: {
        stage: "awaiting_image",
        itemId: menuItemId,
        itemName: "Chicken Salad"
      }
    })
  });
  PendingAgentAction.updateMany = async () => ({ modifiedCount: 1 });
  PendingAgentAction.create = async (input) => {
    created = input;
    return { _id: "confirmation-1", ...input };
  };

  try {
    const result = await prepareUploadedMenuItemImage({
      restaurantId,
      senderPhone,
      senderRole: "manager",
      imageUrl: cloudinaryUrl
    });

    assert.equal(
      result.message,
      "I received the image. Should I use it for Chicken Salad?"
    );
    assert.equal(created.toolName, "set_menu_item_image");
    assert.deepEqual(created.arguments, {
      itemId: menuItemId,
      imageUrl: cloudinaryUrl
    });
  } finally {
    PendingAgentAction.findOne = originalFindOne;
    PendingAgentAction.updateMany = originalUpdateMany;
    PendingAgentAction.create = originalCreate;
  }
});

test("image without prior context asks for an item, then confirmation is created from the reply", async () => {
  const originalPendingFindOne = PendingAgentAction.findOne;
  const originalUpdateMany = PendingAgentAction.updateMany;
  const originalCreate = PendingAgentAction.create;
  const originalMenuFindOne = MenuItem.findOne;
  const created = [];
  let pendingContext = null;

  PendingAgentAction.findOne = () => ({ sort: async () => pendingContext });
  PendingAgentAction.updateMany = async () => ({ modifiedCount: 1 });
  PendingAgentAction.create = async (input) => {
    created.push(input);
    return { _id: `pending-${created.length}`, ...input };
  };
  MenuItem.findOne = async () => ({ _id: menuItemId, name: "Chicken Salad" });

  try {
    const withoutContext = await prepareUploadedMenuItemImage({
      restaurantId,
      senderPhone,
      senderRole: "manager",
      imageUrl: cloudinaryUrl
    });
    assert.equal(
      withoutContext.message,
      "I received the image. Which menu item does it belong to?"
    );
    assert.equal(created[0].data.stage, "awaiting_item");

    pendingContext = { data: { stage: "awaiting_item", imageUrl: cloudinaryUrl } };
    const namedItem = await attachPendingImageToNamedMenuItem({
      restaurantId,
      senderPhone,
      senderRole: "manager",
      message: "Chicken Salad"
    });
    assert.equal(
      namedItem.message,
      "I received the image. Should I use it for Chicken Salad?"
    );
    assert.equal(created[1].toolName, "set_menu_item_image");
  } finally {
    PendingAgentAction.findOne = originalPendingFindOne;
    PendingAgentAction.updateMany = originalUpdateMany;
    PendingAgentAction.create = originalCreate;
    MenuItem.findOne = originalMenuFindOne;
  }
});

test("menu item image is not updated until the confirmation-gated tool is confirmed", async () => {
  const originalMenuFindOne = MenuItem.findOne;
  const originalUpdateMany = PendingAgentAction.updateMany;
  const originalCreate = PendingAgentAction.create;
  const originalUpdateImage = menuItemService.updateMenuItemImage;
  let updateCount = 0;

  MenuItem.findOne = async () => ({
    _id: menuItemId,
    name: "Chicken Salad",
    imageUrl: undefined
  });
  PendingAgentAction.updateMany = async () => ({ modifiedCount: 0 });
  PendingAgentAction.create = async (input) => ({ _id: "confirmation-1", ...input });
  menuItemService.updateMenuItemImage = async (_itemId, imageUrl) => {
    updateCount += 1;
    return { name: "Chicken Salad", imageUrl };
  };
  const context = {
    restaurantId,
    restaurant: { _id: restaurantId },
    sender: {
      phone: senderPhone,
      normalizedPhone: senderPhone,
      role: "manager",
      verified: true
    }
  };

  try {
    const proposed = await executeAgentTool(
      "set_menu_item_image",
      { itemId: menuItemId, imageUrl: cloudinaryUrl },
      context
    );
    assert.equal(proposed.requiresConfirmation, true);
    assert.equal(updateCount, 0);

    const confirmed = await executeAgentTool(
      "set_menu_item_image",
      { itemId: menuItemId, imageUrl: cloudinaryUrl },
      { ...context, confirmed: true }
    );
    assert.equal(confirmed.success, true);
    assert.equal(updateCount, 1);
  } finally {
    MenuItem.findOne = originalMenuFindOne;
    PendingAgentAction.updateMany = originalUpdateMany;
    PendingAgentAction.create = originalCreate;
    menuItemService.updateMenuItemImage = originalUpdateImage;
  }
});

test("specific customer meal lookup carries its saved image into WaSender delivery data", async () => {
  assert.equal(
    parseSpecificMenuItemViewRequest("Show me Chicken Salad"),
    "Chicken Salad"
  );
  assert.equal(parseSpecificMenuItemViewRequest("show menu"), null);

  let providerCalls = 0;
  const provider = {
    name: "openrouter",
    model: "test-model",
    complete: async () => {
      providerCalls += 1;

      if (providerCalls === 1) {
        return {
          text: null,
          toolCalls: [
            {
              id: "search-1",
              name: "search_menu_items",
              arguments: { query: "Chicken Salad", availableOnly: true }
            }
          ]
        };
      }

      return { text: "Here is Chicken Salad.", toolCalls: [] };
    }
  };
  const result = await runAgentOrchestrator(
    {
      restaurant: { _id: restaurantId, name: "Test Restaurant" },
      sender: {
        phone: senderPhone,
        normalizedPhone: senderPhone,
        role: "customer",
        verified: false
      },
      message: "Show me Chicken Salad"
    },
    {
      provider,
      getHistory: async () => [],
      saveMessage: async () => undefined,
      buildSystemPrompt: async () => "Test prompt",
      executeTool: async () => ({
        success: true,
        message: "Menu search completed.",
        data: [{ name: "Chicken Salad", imageUrl: cloudinaryUrl }]
      })
    }
  );

  assert.equal(result.data.imageUrl, cloudinaryUrl);
  assert.equal(result.data.imageItemName, "Chicken Salad");
});

test("customer image sending checks WaSender success and provides a text fallback", async () => {
  let capturedOptions;
  const sent = await sendCustomerMenuItemImage(
    "session-1",
    senderPhone,
    cloudinaryUrl,
    "restaurant-token",
    async (_sessionId, _to, _imageUrl, _caption, options) => {
      capturedOptions = options;
      return { success: true, status: 200 };
    }
  );
  assert.equal(sent, true);
  assert.deepEqual(capturedOptions, { apiKey: "restaurant-token" });

  const failed = await sendCustomerMenuItemImage(
    "session-1",
    senderPhone,
    cloudinaryUrl,
    "restaurant-token",
    async () => ({ success: false, status: 500, error: "provider rejected image" })
  );
  assert.equal(failed, false);
  assert.equal(
    buildCustomerImageFallbackMessage("Here is Chicken Salad.", cloudinaryUrl),
    `Here is Chicken Salad.\n\nI couldn't send the image directly. You can view it here: ${cloudinaryUrl}`
  );
});
