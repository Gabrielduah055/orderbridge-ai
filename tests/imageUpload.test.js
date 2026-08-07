const assert = require("node:assert/strict");
const test = require("node:test");
const { v2: cloudinary } = require("cloudinary");

const {
  decryptWasenderMedia,
  normalizeIncomingWebhook
} = require("../dist/services/wasender.service");
const {
  extractCloudinaryPublicId,
  isEncryptedWhatsappMediaUrl,
  uploadDecryptedImageFromUrl,
  validateTrustedCloudinaryImage
} = require("../dist/services/cloudinary.service");
const {
  confirmPendingMenuItemImage,
  extractMenuItemNameFromImageReply,
  handlePendingMenuItemImageReply,
  isMenuItemImageConfirmationMessage,
  prepareUploadedMenuItemImage,
  shouldHandlePendingMenuItemImageReply
} = require("../dist/services/menuItemImageWorkflow.service");
const {
  getAgentToolDefinitionsForRole
} = require("../dist/services/ai/agentToolDefinitions.service");
const {
  isPendingActionConfirmationMessage
} = require("../dist/services/restaurantAgent.service");
const { executeAgentTool } = require("../dist/agent-tools/tool.executor");
const { MenuItem } = require("../dist/models/MenuItem");
const { PendingAgentAction } = require("../dist/models/pendingAgentAction.model");
const menuItemService = require("../dist/services/menuItem.service");
const {
  classifySuspiciousMenuItemImageUrl
} = require("../dist/scripts/auditMenuItemImages");

const restaurantId = "64b000000000000000000001";
const otherRestaurantId = "64b000000000000000000002";
const menuItemId = "64b000000000000000000301";
const senderPhone = "+233557038547";
const otherSenderPhone = "+233557038548";
const encryptedUrl = "https://mmg.whatsapp.net/o1/v/t62.7118-24/encrypted?token=signed";
const decryptedUrl = "https://www.wasenderapi.com/api/decrypted-media/message-1";
const cloudinaryUrl =
  "https://res.cloudinary.com/demo/image/upload/v123/menu-items/chicken-salad.jpg";
const publicId = "menu-items/chicken-salad";
const uploadedAt = new Date("2026-08-06T12:00:00.000Z");
const trustedImage = { secureUrl: cloudinaryUrl, publicId, uploadedAt };

process.env.CLOUDINARY_CLOUD_NAME = "demo";

const rawMessage = {
  key: { id: "message-1", fromMe: false, cleanedSenderPn: senderPhone },
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

const restore = (target, name, value) => {
  target[name] = value;
};

const sortable = (value) => ({ sort: async () => value });

const makePendingImage = (overrides = {}) => ({
  _id: "64b000000000000000000901",
  restaurantId,
  senderPhone,
  senderRole: "manager",
  action: "IMAGE_ASSIGNMENT",
  toolName: "set_menu_item_image",
  arguments: { itemId: menuItemId },
  data: { stage: "awaiting_confirmation", itemName: "Chicken Salad" },
  imageSecureUrl: cloudinaryUrl,
  imagePublicId: publicId,
  uploadedAt,
  selectedMenuItemId: menuItemId,
  status: "pending",
  confirmationMessage: "I received the image. Should I use it for Chicken Salad?",
  expiresAt: new Date(Date.now() + 60_000),
  save: async function () {
    return this;
  },
  ...overrides
});

const withSuccessfulImageConfirmation = async (message) => {
  const originalPendingFindOne = PendingAgentAction.findOne;
  const originalFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const originalMenuFindOne = MenuItem.findOne;
  const originalTrustedUpdate = menuItemService.updateTrustedMenuItemImage;
  const pending = makePendingImage();
  let persistedUrl;

  PendingAgentAction.findOne = (filter) => {
    if (filter.status === "pending" && filter.expiresAt) {
      return sortable(pending);
    }
    return Promise.resolve(pending);
  };
  PendingAgentAction.findOneAndUpdate = async () => {
    pending.status = "processing";
    return pending;
  };
  MenuItem.findOne = async () => ({
    _id: menuItemId,
    restaurantId,
    name: "Chicken Salad",
    imageUrl: undefined
  });
  menuItemService.updateTrustedMenuItemImage = async (input) => {
    persistedUrl = input.secureUrl;
    return { _id: menuItemId, name: "Chicken Salad", imageUrl: input.secureUrl };
  };

  try {
    const result = await handlePendingMenuItemImageReply({
      restaurantId,
      senderPhone,
      senderRole: "manager",
      message
    });
    return { result, pending, persistedUrl };
  } finally {
    restore(PendingAgentAction, "findOne", originalPendingFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalFindOneAndUpdate);
    restore(MenuItem, "findOne", originalMenuFindOne);
    restore(menuItemService, "updateTrustedMenuItemImage", originalTrustedUpdate);
  }
};

test("webhook normalization preserves the complete raw WhatsApp image message", () => {
  const normalized = normalizeIncomingWebhook({
    event: "messages.received",
    sessionId: "session-1",
    data: { messages: rawMessage }
  });

  assert.equal(normalized.messageType, "image");
  assert.equal(normalized.mediaUrl, encryptedUrl);
  assert.deepEqual(normalized.rawMessage, rawMessage);
});

test("WaSender media decryption posts the complete message with the restaurant token", async () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.WASENDER_API_URL;
  let request;

  process.env.WASENDER_API_URL = "https://wasender.example";
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ success: true, publicUrl: decryptedUrl }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    assert.equal(
      await decryptWasenderMedia(rawMessage, { apiKey: "restaurant-token" }),
      decryptedUrl
    );
    assert.equal(request.options.headers.Authorization, "Bearer restaurant-token");
    assert.deepEqual(JSON.parse(request.options.body), { data: { messages: rawMessage } });
  } finally {
    global.fetch = originalFetch;
    process.env.WASENDER_API_URL = originalApiUrl;
  }
});

test("Cloudinary upload retains secure_url and public_id as trusted metadata", async () => {
  const originalUpload = cloudinary.uploader.upload;
  const originalApiKey = process.env.CLOUDINARY_API_KEY;
  const originalApiSecret = process.env.CLOUDINARY_API_SECRET;
  const uploads = [];

  process.env.CLOUDINARY_API_KEY = "test-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  cloudinary.uploader.upload = async (source, options) => {
    uploads.push({ source, options });
    return { secure_url: cloudinaryUrl, public_id: publicId };
  };

  try {
    assert.equal(isEncryptedWhatsappMediaUrl(encryptedUrl), true);
    await assert.rejects(uploadDecryptedImageFromUrl(encryptedUrl), /Refusing to upload/);
    assert.equal(await uploadDecryptedImageFromUrl(decryptedUrl), cloudinaryUrl);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].source, decryptedUrl);
  } finally {
    restore(cloudinary.uploader, "upload", originalUpload);
    process.env.CLOUDINARY_API_KEY = originalApiKey;
    process.env.CLOUDINARY_API_SECRET = originalApiSecret;
  }
});

test("trusted Cloudinary validation rejects fake, non-HTTPS, and mismatched assets", () => {
  assert.equal(extractCloudinaryPublicId(cloudinaryUrl), publicId);
  assert.equal(validateTrustedCloudinaryImage(trustedImage), true);
  assert.equal(
    validateTrustedCloudinaryImage({
      secureUrl: "https://restaurant-assets.example.com/images/chicken.jpg",
      publicId
    }),
    false
  );
  assert.equal(
    validateTrustedCloudinaryImage({
      secureUrl: cloudinaryUrl.replace("https:", "http:"),
      publicId
    }),
    false
  );
  assert.equal(validateTrustedCloudinaryImage({ secureUrl: cloudinaryUrl, publicId: "other" }), false);
});

test("example.com URLs cannot reach the trusted MenuItem database write", async () => {
  const originalFindOne = MenuItem.findOne;
  let databaseLookups = 0;
  MenuItem.findOne = async () => {
    databaseLookups += 1;
    return null;
  };

  try {
    await assert.rejects(
      menuItemService.updateTrustedMenuItemImage({
        restaurantId,
        itemId: menuItemId,
        secureUrl: "https://restaurant-assets.example.com/images/chicken_salad.jpg",
        publicId
      }),
      /Invalid trusted Cloudinary image metadata/
    );
    assert.equal(databaseLookups, 0);
  } finally {
    restore(MenuItem, "findOne", originalFindOne);
  }
});

test("natural image confirmations include yes, yea, yeah, and action phrases", () => {
  for (const message of [
    "yes",
    "yea add it to the chicken salad",
    "yeah use it",
    "yep",
    "yup",
    "yh",
    "sure, use it",
    "correct",
    "confirm",
    "confirmed",
    "okay add the image",
    "ok",
    "do it",
    "add it",
    "use it"
  ]) {
    assert.equal(isMenuItemImageConfirmationMessage(message), true, message);
    assert.equal(isPendingActionConfirmationMessage(message), true, message);
  }
  assert.equal(
    extractMenuItemNameFromImageReply("yea add it to the chicken salad"),
    "chicken salad"
  );
  assert.equal(
    extractMenuItemNameFromImageReply("yes use it for chicken salad"),
    "chicken salad"
  );
  assert.equal(
    extractMenuItemNameFromImageReply("it belongs to Chicken Salad"),
    "Chicken Salad"
  );
  assert.equal(
    extractMenuItemNameFromImageReply("this is for Check Check Fried Rice"),
    "Check Check Fried Rice"
  );
});

test("pending image routing distinguishes conversation from image workflow replies", () => {
  for (const message of ["you there?", "hello", "wait", "what do you mean?"]) {
    assert.equal(
      shouldHandlePendingMenuItemImageReply("awaiting_item", message),
      false,
      message
    );
  }

  assert.equal(
    shouldHandlePendingMenuItemImageReply("awaiting_item", "Chicken Salad"),
    true
  );
  assert.equal(
    shouldHandlePendingMenuItemImageReply("awaiting_confirmation", "yes use it"),
    true
  );
  assert.equal(
    shouldHandlePendingMenuItemImageReply(
      "awaiting_confirmation",
      "no, cancel it"
    ),
    true
  );
  assert.equal(
    shouldHandlePendingMenuItemImageReply("awaiting_confirmation", "Done"),
    false
  );
});

test("yes confirms the pending upload and saves the trusted Cloudinary URL", async () => {
  const { result, pending, persistedUrl } = await withSuccessfulImageConfirmation("yes");

  assert.equal(result.success, true);
  assert.equal(persistedUrl, cloudinaryUrl);
  assert.equal(pending.status, "completed");
  assert.ok(pending.completedAt instanceof Date);
  assert.equal(result.message, "Done — I added the uploaded image to Chicken Salad.");
});

test("yeah use it confirms an already selected pending upload", async () => {
  const { result } = await withSuccessfulImageConfirmation("yeah use it");
  assert.equal(result.success, true);
});

test("yea add it to the chicken salad resolves the item and completes assignment", async () => {
  const originalPendingFindOne = PendingAgentAction.findOne;
  const originalFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const originalMenuFind = MenuItem.find;
  const originalMenuFindOne = MenuItem.findOne;
  const originalTrustedUpdate = menuItemService.updateTrustedMenuItemImage;
  const pending = makePendingImage({
    arguments: {},
    data: { stage: "awaiting_item" },
    selectedMenuItemId: undefined,
    confirmationMessage: "Which menu item does this image belong to?"
  });
  let savedUrl;

  PendingAgentAction.findOne = (filter) =>
    filter.status === "pending" && filter.expiresAt ? sortable(pending) : Promise.resolve(pending);
  PendingAgentAction.findOneAndUpdate = async () => {
    pending.status = "processing";
    return pending;
  };
  MenuItem.find = () =>
    sortable([{ _id: menuItemId, restaurantId, name: "Chicken Salad" }]);
  MenuItem.findOne = async () => ({ _id: menuItemId, restaurantId, name: "Chicken Salad" });
  menuItemService.updateTrustedMenuItemImage = async (input) => {
    savedUrl = input.secureUrl;
    return { _id: menuItemId, name: "Chicken Salad", imageUrl: input.secureUrl };
  };

  try {
    const result = await handlePendingMenuItemImageReply({
      restaurantId,
      senderPhone,
      senderRole: "manager",
      message: "yea add it to the chicken salad"
    });
    assert.equal(result.success, true);
    assert.equal(savedUrl, cloudinaryUrl);
    assert.equal(String(pending.selectedMenuItemId), menuItemId);
    assert.equal(result.message, "Done — I added the uploaded image to Chicken Salad.");
  } finally {
    restore(PendingAgentAction, "findOne", originalPendingFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalFindOneAndUpdate);
    restore(MenuItem, "find", originalMenuFind);
    restore(MenuItem, "findOne", originalMenuFindOne);
    restore(menuItemService, "updateTrustedMenuItemImage", originalTrustedUpdate);
  }
});

test("an awaiting-item image resolves a relational item reply without using the full sentence", async () => {
  const originalPendingFindOne = PendingAgentAction.findOne;
  const originalMenuFind = MenuItem.find;
  const pending = makePendingImage({
    arguments: {},
    data: { stage: "awaiting_item" },
    selectedMenuItemId: undefined,
    confirmationMessage: "Which menu item does this image belong to?"
  });
  const menuQueries = [];

  PendingAgentAction.findOne = () => sortable(pending);
  MenuItem.find = (query) => {
    menuQueries.push(query);
    return sortable([{ _id: menuItemId, name: "Chicken Salad" }]);
  };

  try {
    const result = await handlePendingMenuItemImageReply({
      restaurantId,
      senderPhone,
      senderRole: "manager",
      message: "it belongs to Chicken Salad"
    });

    assert.equal(result.handled, true);
    assert.equal(result.success, true);
    assert.equal(result.itemName, "Chicken Salad");
    assert.equal(menuQueries.length, 1);
    assert.equal(menuQueries[0].name.$regex, "^Chicken Salad$");
    assert.equal(pending.data.stage, "awaiting_confirmation");
    assert.equal(String(pending.selectedMenuItemId), menuItemId);
  } finally {
    restore(PendingAgentAction, "findOne", originalPendingFindOne);
    restore(MenuItem, "find", originalMenuFind);
  }
});

test("uploaded Cloudinary metadata is stored outside AI tool arguments", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  const originalUpdateMany = PendingAgentAction.updateMany;
  const originalCreate = PendingAgentAction.create;
  const updateFilters = [];
  let created;

  PendingAgentAction.findOne = () => sortable(null);
  PendingAgentAction.updateMany = async (filter) => {
    updateFilters.push(filter);
    return { modifiedCount: 0 };
  };
  PendingAgentAction.create = async (input) => {
    created = { _id: "pending-image-1", ...input };
    return created;
  };

  try {
    await prepareUploadedMenuItemImage({
      restaurantId,
      senderPhone,
      senderRole: "manager",
      image: trustedImage
    });
    assert.equal(created.action, "IMAGE_ASSIGNMENT");
    assert.equal(created.imageSecureUrl, cloudinaryUrl);
    assert.equal(created.imagePublicId, publicId);
    assert.deepEqual(created.arguments, {});
    assert.doesNotMatch(JSON.stringify(created.arguments), /imageUrl|cloudinary/i);
    assert.ok(updateFilters.every((filter) => filter.action !== "TOOL_CALL"));
    const replacementFilter = updateFilters.find(
      (filter) => filter.action === "IMAGE_ASSIGNMENT"
    );
    assert.deepEqual(replacementFilter, {
      restaurantId,
      senderPhone,
      senderRole: "manager",
      action: "IMAGE_ASSIGNMENT",
      status: "pending"
    });
  } finally {
    restore(PendingAgentAction, "findOne", originalFindOne);
    restore(PendingAgentAction, "updateMany", originalUpdateMany);
    restore(PendingAgentAction, "create", originalCreate);
  }
});

test("AI-facing set_menu_item_image schema cannot accept imageUrl", async () => {
  const definitions = getAgentToolDefinitionsForRole("manager");
  const imageTool = definitions.find((tool) => tool.function.name === "set_menu_item_image");
  assert.deepEqual(Object.keys(imageTool.function.parameters.properties).sort(), ["itemId", "itemName"]);

  const result = await executeAgentTool(
    "set_menu_item_image",
    { itemName: "Chicken Salad", imageUrl: cloudinaryUrl },
    {
      restaurantId,
      restaurant: { _id: restaurantId },
      sender: {
        phone: senderPhone,
        normalizedPhone: senderPhone,
        role: "manager",
        verified: true
      }
    }
  );
  assert.equal(result.code, "TOOL_INVALID_ARGUMENTS");
});

test("an unrelated pending AI tool call does not cancel a pending image upload", async () => {
  const originalMenuFindOne = MenuItem.findOne;
  const originalUpdateMany = PendingAgentAction.updateMany;
  const originalCreate = PendingAgentAction.create;
  const pendingImage = { action: "IMAGE_ASSIGNMENT", status: "pending" };
  const cancellationFilters = [];

  MenuItem.findOne = async () => ({ _id: menuItemId, name: "Chicken Salad" });
  PendingAgentAction.updateMany = async (filter) => {
    cancellationFilters.push(filter);
    if (filter.action === pendingImage.action) pendingImage.status = "cancelled";
    return { modifiedCount: 0 };
  };
  PendingAgentAction.create = async (input) => ({ _id: "tool-action", ...input });

  try {
    const result = await executeAgentTool(
      "set_item_availability",
      { itemId: menuItemId, available: false },
      {
        restaurantId,
        restaurant: { _id: restaurantId },
        sender: {
          phone: senderPhone,
          normalizedPhone: senderPhone,
          role: "manager",
          verified: true
        }
      }
    );
    assert.equal(result.requiresConfirmation, true);
    assert.equal(pendingImage.status, "pending");
    assert.ok(cancellationFilters.every((filter) => filter.action === "TOOL_CALL"));
  } finally {
    restore(MenuItem, "findOne", originalMenuFindOne);
    restore(PendingAgentAction, "updateMany", originalUpdateMany);
    restore(PendingAgentAction, "create", originalCreate);
  }
});

test("multiple matching menu items require clarification without modifying state", async () => {
  const originalPendingFindOne = PendingAgentAction.findOne;
  const originalMenuFind = MenuItem.find;
  const originalMenuFindOne = MenuItem.findOne;
  const pending = makePendingImage({ data: { stage: "awaiting_item" }, selectedMenuItemId: undefined });
  let writes = 0;

  PendingAgentAction.findOne = () => sortable(pending);
  MenuItem.find = () =>
    sortable([
      { _id: menuItemId, name: "Chicken Salad" },
      { _id: "64b000000000000000000302", name: "Chicken Salad" }
    ]);
  MenuItem.findOne = async () => {
    writes += 1;
    return null;
  };

  try {
    const result = await handlePendingMenuItemImageReply({
      restaurantId,
      senderPhone,
      senderRole: "manager",
      message: "yea add it to the chicken salad"
    });
    assert.equal(result.success, false);
    assert.match(result.message, /multiple menu items/i);
    assert.equal(writes, 0);
    assert.equal(pending.selectedMenuItemId, undefined);
  } finally {
    restore(PendingAgentAction, "findOne", originalPendingFindOne);
    restore(MenuItem, "find", originalMenuFind);
    restore(MenuItem, "findOne", originalMenuFindOne);
  }
});

test("missing menu item does not modify the pending image or database", async () => {
  const originalPendingFindOne = PendingAgentAction.findOne;
  const originalMenuFind = MenuItem.find;
  const pending = makePendingImage({ data: { stage: "awaiting_item" }, selectedMenuItemId: undefined });
  let saves = 0;
  pending.save = async () => {
    saves += 1;
  };

  PendingAgentAction.findOne = () => sortable(pending);
  MenuItem.find = () => sortable([]);

  try {
    const result = await handlePendingMenuItemImageReply({
      restaurantId,
      senderPhone,
      senderRole: "manager",
      message: "yea add it to the missing meal"
    });
    assert.equal(result.success, false);
    assert.match(result.message, /couldn't find/i);
    assert.equal(saves, 0);
  } finally {
    restore(PendingAgentAction, "findOne", originalPendingFindOne);
    restore(MenuItem, "find", originalMenuFind);
  }
});

test("expired pending upload is rejected and marked expired", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  const pending = makePendingImage({ expiresAt: new Date(Date.now() - 1) });
  PendingAgentAction.findOne = async () => pending;

  try {
    const result = await confirmPendingMenuItemImage({
      pendingActionId: String(pending._id),
      restaurantId,
      senderPhone,
      senderRole: "manager"
    });
    assert.equal(result.success, false);
    assert.equal(result.code, "PENDING_IMAGE_NOT_FOUND");
    assert.equal(pending.status, "expired");
  } finally {
    restore(PendingAgentAction, "findOne", originalFindOne);
  }
});

test("repeated confirmation is idempotent", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  const originalFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const pending = makePendingImage({
    status: "completed",
    completedAt: new Date(),
    resultMessage: "Done — I added the uploaded image to Chicken Salad."
  });
  let claims = 0;

  PendingAgentAction.findOne = async () => pending;
  PendingAgentAction.findOneAndUpdate = async () => {
    claims += 1;
    return null;
  };

  try {
    const result = await confirmPendingMenuItemImage({
      pendingActionId: String(pending._id),
      restaurantId,
      senderPhone,
      senderRole: "manager"
    });
    assert.equal(result.success, true);
    assert.equal(result.data.idempotent, true);
    assert.equal(claims, 0);
  } finally {
    restore(PendingAgentAction, "findOne", originalFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalFindOneAndUpdate);
  }
});

for (const isolationCase of [
  {
    name: "one restaurant cannot use another restaurant's pending image",
    attemptedRestaurantId: otherRestaurantId,
    attemptedSenderPhone: senderPhone
  },
  {
    name: "one sender cannot confirm another sender's pending image",
    attemptedRestaurantId: restaurantId,
    attemptedSenderPhone: otherSenderPhone
  }
]) {
  test(isolationCase.name, async () => {
    const originalFindOne = PendingAgentAction.findOne;
    let capturedFilter;
    PendingAgentAction.findOne = async (filter) => {
      capturedFilter = filter;
      return null;
    };

    try {
      const result = await confirmPendingMenuItemImage({
        pendingActionId: "64b000000000000000000901",
        restaurantId: isolationCase.attemptedRestaurantId,
        senderPhone: isolationCase.attemptedSenderPhone,
        senderRole: "manager"
      });
      assert.equal(result.success, false);
      assert.equal(capturedFilter.restaurantId, isolationCase.attemptedRestaurantId);
      assert.equal(capturedFilter.senderPhone, isolationCase.attemptedSenderPhone);
      assert.equal(capturedFilter.action, "IMAGE_ASSIGNMENT");
    } finally {
      restore(PendingAgentAction, "findOne", originalFindOne);
    }
  });
}

test("suspicious image audit classifies bad data and leaves valid HTTPS URLs alone", () => {
  assert.equal(
    classifySuspiciousMenuItemImageUrl(
      "https://restaurant-assets.example.com/images/chicken_salad.jpg"
    ),
    "example_domain"
  );
  assert.equal(classifySuspiciousMenuItemImageUrl("http://cdn.example.net/image.jpg"), "non_https_url");
  assert.equal(classifySuspiciousMenuItemImageUrl("not a url"), "malformed_url");
  assert.equal(classifySuspiciousMenuItemImageUrl(cloudinaryUrl), null);
});
