const assert = require("node:assert/strict");
const test = require("node:test");
const { v2: cloudinary } = require("cloudinary");

const { executeAgentTool } = require("../dist/agent-tools/tool.executor");
const {
  getAgentToolDefinitionsForRole
} = require("../dist/services/ai/agentToolDefinitions.service");
const {
  runAgentOrchestrator
} = require("../dist/services/ai/agentOrchestrator.service");
const {
  prepareUploadedMenuItemImage
} = require("../dist/services/menuItemImageWorkflow.service");
const { MenuCategory } = require("../dist/models/MenuCategory");
const { MenuItem } = require("../dist/models/MenuItem");
const {
  PendingAgentAction
} = require("../dist/models/pendingAgentAction.model");
const menuItemService = require("../dist/services/menuItem.service");

const restaurantId = "64b000000000000000000001";
const otherRestaurantId = "64b000000000000000000002";
const chickenId = "64b000000000000000000301";
const riceId = "64b000000000000000000302";
const imageActionId = "64b000000000000000000901";
const senderPhone = "+233507879374";
const otherSenderPhone = "+233241234567";
const secureUrl =
  "https://res.cloudinary.com/demo/image/upload/v123/menu-items/pending-image.jpg";
const publicId = "menu-items/pending-image";
const previousUrl =
  "https://res.cloudinary.com/demo/image/upload/v122/menu-items/previous-image.jpg";
const previousPublicId = "menu-items/previous-image";

process.env.CLOUDINARY_CLOUD_NAME = "demo";

const restore = (target, name, value) => {
  target[name] = value;
};

const queryResult = (value) => ({
  sort() {
    return Promise.resolve(value);
  },
  select() {
    return Promise.resolve(value);
  },
  then(resolve, reject) {
    return Promise.resolve(value).then(resolve, reject);
  }
});

const context = (overrides = {}) => ({
  restaurantId,
  restaurant: { _id: restaurantId, name: "Golden Grill" },
  sender: {
    phone: senderPhone,
    normalizedPhone: senderPhone,
    role: "owner",
    verified: true
  },
  ...overrides
});

const menuItem = (id, name, overrides = {}) => ({
  _id: id,
  restaurantId,
  categoryId: "64b000000000000000000401",
  name,
  price: 65,
  isAvailable: true,
  imageUrl: undefined,
  ...overrides
});

const pendingImage = (overrides = {}) => ({
  _id: imageActionId,
  restaurantId,
  senderPhone,
  senderRole: "owner",
  action: "IMAGE_ASSIGNMENT",
  toolName: "confirm_pending_image_assignment",
  arguments: {},
  data: { stage: "awaiting_item" },
  imageSecureUrl: secureUrl,
  imagePublicId: publicId,
  uploadedAt: new Date(),
  selectedMenuItemId: undefined,
  status: "pending",
  actionVersion: 1,
  confirmationMessage: "Which menu item does this image belong to?",
  expiresAt: new Date(Date.now() + 60_000),
  save: async function () {
    this.actionVersion += 1;
    return this;
  },
  ...overrides
});

test("OpenRouter tool loop can map natural image language to the typed start tool", async () => {
  let round = 0;
  let requestedTool;
  const result = await runAgentOrchestrator(
    {
      restaurant: context().restaurant,
      sender: context().sender,
      message: "I want to add a picture to Chicken Salad",
      staffState: {
        pendingActions: [],
        imageWorkflow: null,
        orders: { freshPending: [], recentActive: [] },
        recentReferences: {},
        permissions: ["start_menu_item_image_upload"]
      }
    },
    {
      provider: {
        name: "openrouter",
        model: "test-model",
        complete: async ({ tools }) => {
          assert.equal(
            tools.some(
              (tool) =>
                tool.function.name === "start_menu_item_image_upload"
            ),
            true
          );
          round += 1;
          return round === 1
            ? {
                text: null,
                toolCalls: [
                  {
                    id: "image-tool-call-1",
                    name: "start_menu_item_image_upload",
                    arguments: { itemName: "Chicken Salad" }
                  }
                ]
              }
            : {
                text: "Send me the image you'd like to use for Chicken Salad.",
                toolCalls: []
              };
        }
      },
      executeTool: async (toolName, args) => {
        requestedTool = { toolName, args };
        return {
          success: true,
          pendingActionId: "64b000000000000000000801",
          message: "Send me the image you'd like to use for Chicken Salad."
        };
      },
      getHistory: async () => [
        {
          role: "user",
          content: "I want to add a picture to Chicken Salad"
        }
      ],
      saveMessage: async () => {},
      buildSystemPrompt: async () => "Use typed tools."
    }
  );

  assert.equal(result.success, true);
  assert.deepEqual(requestedTool, {
    toolName: "start_menu_item_image_upload",
    args: { itemName: "Chicken Salad" }
  });
  assert.equal(result.executedTools[0].name, "start_menu_item_image_upload");
});

test("start image tool creates awaiting_image with an exact restaurant item", async () => {
  const originalFind = MenuItem.find;
  const originalUpdateMany = PendingAgentAction.updateMany;
  const originalCreate = PendingAgentAction.create;
  let created;
  let cancellationFilter;

  MenuItem.find = () => queryResult([menuItem(chickenId, "Chicken Salad")]);
  PendingAgentAction.updateMany = async (filter) => {
    cancellationFilter = filter;
    return { modifiedCount: 0 };
  };
  PendingAgentAction.create = async (input) => {
    created = { _id: "64b000000000000000000801", ...input };
    return created;
  };

  try {
    const result = await executeAgentTool(
      "start_menu_item_image_upload",
      { itemName: "Chicken Salad" },
      context()
    );

    assert.equal(result.success, true);
    assert.equal(result.data.stage, "awaiting_image");
    assert.equal(result.data.itemName, "Chicken Salad");
    assert.equal(created.action, "MENU_ITEM_IMAGE_CONTEXT");
    assert.equal(created.data.itemId, chickenId);
    assert.equal(created.imageSecureUrl, undefined);
    assert.deepEqual(cancellationFilter, {
      restaurantId,
      senderPhone,
      senderRole: "owner",
      action: "MENU_ITEM_IMAGE_CONTEXT",
      status: "pending"
    });
  } finally {
    restore(MenuItem, "find", originalFind);
    restore(PendingAgentAction, "updateMany", originalUpdateMany);
    restore(PendingAgentAction, "create", originalCreate);
  }
});

test("start image tool safely accepts a missing item without inventing one", async () => {
  const originalUpdateMany = PendingAgentAction.updateMany;
  const originalCreate = PendingAgentAction.create;
  let created;

  PendingAgentAction.updateMany = async () => ({ modifiedCount: 0 });
  PendingAgentAction.create = async (input) => {
    created = { _id: "64b000000000000000000802", ...input };
    return created;
  };

  try {
    const result = await executeAgentTool(
      "start_menu_item_image_upload",
      {},
      context()
    );

    assert.equal(result.success, true);
    assert.equal(result.data.stage, "awaiting_image");
    assert.equal(result.data.itemId, undefined);
    assert.equal(result.data.itemName, undefined);
    assert.deepEqual(created.data, { stage: "awaiting_image" });
    assert.match(result.message, /send me the image/i);
  } finally {
    restore(PendingAgentAction, "updateMany", originalUpdateMany);
    restore(PendingAgentAction, "create", originalCreate);
  }
});

test("deterministic upload with a known target becomes awaiting_confirmation", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  const originalFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const originalUpdateMany = PendingAgentAction.updateMany;
  const originalCreate = PendingAgentAction.create;
  let created;

  PendingAgentAction.findOne = () =>
    queryResult({
      data: {
        stage: "awaiting_image",
        itemId: chickenId,
        itemName: "Chicken Salad"
      }
    });
  PendingAgentAction.findOneAndUpdate = async () => null;
  PendingAgentAction.updateMany = async () => ({ modifiedCount: 0 });
  PendingAgentAction.create = async (input) => {
    created = { _id: imageActionId, ...input };
    return created;
  };

  try {
    const result = await prepareUploadedMenuItemImage({
      restaurantId,
      senderPhone,
      senderRole: "owner",
      image: { secureUrl, publicId, uploadedAt: new Date() }
    });

    assert.equal(result.success, true);
    assert.equal(created.data.stage, "awaiting_confirmation");
    assert.equal(String(created.selectedMenuItemId), chickenId);
    assert.equal(created.imageSecureUrl, secureUrl);
    assert.equal(created.imagePublicId, publicId);
    assert.deepEqual(created.arguments, { itemId: chickenId });
    assert.doesNotMatch(JSON.stringify(created.arguments), /url|public/i);
  } finally {
    restore(PendingAgentAction, "findOne", originalFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalFindOneAndUpdate);
    restore(PendingAgentAction, "updateMany", originalUpdateMany);
    restore(PendingAgentAction, "create", originalCreate);
  }
});

test("a newer deterministic upload cancels and deletes the superseded trusted upload", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  const originalFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const originalUpdateMany = PendingAgentAction.updateMany;
  const originalCreate = PendingAgentAction.create;
  const originalDestroy = cloudinary.uploader.destroy;
  const originalApiKey = process.env.CLOUDINARY_API_KEY;
  const originalApiSecret = process.env.CLOUDINARY_API_SECRET;
  const oldUpload = pendingImage();
  let supersedeAttempts = 0;
  let deletes = 0;
  let created;

  process.env.CLOUDINARY_API_KEY = "test-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  PendingAgentAction.findOne = () => queryResult(null);
  PendingAgentAction.findOneAndUpdate = async (filter, update) => {
    supersedeAttempts += 1;
    assert.equal(filter.restaurantId, restaurantId);
    assert.equal(filter.senderPhone, senderPhone);
    assert.equal(filter.senderRole, "owner");
    assert.equal(filter.action, "IMAGE_ASSIGNMENT");
    assert.equal(filter.status, "pending");

    if (supersedeAttempts > 1) {
      return null;
    }

    Object.assign(oldUpload, update.$set);
    return oldUpload;
  };
  PendingAgentAction.updateMany = async () => ({ modifiedCount: 0 });
  PendingAgentAction.create = async (input) => {
    created = { _id: "64b000000000000000000902", ...input };
    return created;
  };
  cloudinary.uploader.destroy = async (deletedPublicId) => {
    assert.equal(deletedPublicId, publicId);
    deletes += 1;
    return { result: "ok" };
  };

  try {
    const result = await prepareUploadedMenuItemImage({
      restaurantId,
      senderPhone,
      senderRole: "owner",
      image: {
        secureUrl:
          "https://res.cloudinary.com/demo/image/upload/v124/menu-items/new-pending-image.jpg",
        publicId: "menu-items/new-pending-image",
        uploadedAt: new Date()
      }
    });

    assert.equal(result.success, true);
    assert.equal(oldUpload.status, "cancelled");
    assert.equal(oldUpload.resultMessage, "Superseded by a newer uploaded image.");
    assert.equal(deletes, 1);
    assert.equal(created.status, "pending");
    assert.equal(created.imagePublicId, "menu-items/new-pending-image");
  } finally {
    restore(PendingAgentAction, "findOne", originalFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalFindOneAndUpdate);
    restore(PendingAgentAction, "updateMany", originalUpdateMany);
    restore(PendingAgentAction, "create", originalCreate);
    restore(cloudinary.uploader, "destroy", originalDestroy);
    if (originalApiKey === undefined) delete process.env.CLOUDINARY_API_KEY;
    else process.env.CLOUDINARY_API_KEY = originalApiKey;
    if (originalApiSecret === undefined) delete process.env.CLOUDINARY_API_SECRET;
    else process.env.CLOUDINARY_API_SECRET = originalApiSecret;
  }
});

test("full item-less upload, assignment, and confirmation uses typed tools only", async () => {
  const originalPendingFindOne = PendingAgentAction.findOne;
  const originalPendingFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const originalPendingUpdateMany = PendingAgentAction.updateMany;
  const originalPendingCreate = PendingAgentAction.create;
  const originalMenuFind = MenuItem.find;
  const originalMenuFindOne = MenuItem.findOne;
  const originalTrustedUpdate = menuItemService.updateTrustedMenuItemImage;
  const actions = [];
  let nextId = 800;
  let updatedItemId;

  PendingAgentAction.updateMany = async (filter, update) => {
    for (const action of actions) {
      if (
        action.restaurantId === filter.restaurantId &&
        action.senderPhone === filter.senderPhone &&
        action.senderRole === filter.senderRole &&
        action.action === filter.action &&
        action.status === filter.status
      ) {
        Object.assign(action, update.$set);
      }
    }
    return { modifiedCount: 0 };
  };
  PendingAgentAction.create = async (input) => {
    nextId += 1;
    const action = {
      _id: `64b000000000000000000${nextId}`,
      actionVersion: 1,
      save: async function () {
        this.actionVersion += 1;
        return this;
      },
      ...input
    };
    actions.push(action);
    return action;
  };
  PendingAgentAction.findOne = (filter) => {
    const action = [...actions].reverse().find((candidate) => {
      if (filter._id && String(candidate._id) !== String(filter._id)) return false;
      if (filter.restaurantId && candidate.restaurantId !== filter.restaurantId) return false;
      if (filter.senderPhone && candidate.senderPhone !== filter.senderPhone) return false;
      if (filter.senderRole && candidate.senderRole !== filter.senderRole) return false;
      if (filter.action && candidate.action !== filter.action) return false;
      if (filter.status && candidate.status !== filter.status) return false;
      if (filter["data.stage"] && candidate.data?.stage !== filter["data.stage"]) return false;
      return true;
    });
    return queryResult(action ?? null);
  };
  PendingAgentAction.findOneAndUpdate = async (filter, update) => {
    const action = actions.find(
      (candidate) =>
        String(candidate._id) === String(filter._id) &&
        candidate.restaurantId === filter.restaurantId &&
        candidate.senderPhone === filter.senderPhone &&
        candidate.senderRole === filter.senderRole &&
        candidate.action === filter.action &&
        candidate.status === filter.status &&
        candidate.data?.stage === filter["data.stage"] &&
        candidate.actionVersion === filter.actionVersion
    );
    if (!action) return null;
    Object.assign(action, update.$set);
    return action;
  };
  MenuItem.find = () => queryResult([menuItem(chickenId, "Chicken Salad")]);
  MenuItem.findOne = async (filter) =>
    String(filter._id) === chickenId && filter.restaurantId === restaurantId
      ? menuItem(chickenId, "Chicken Salad")
      : null;
  menuItemService.updateTrustedMenuItemImage = async (input) => {
    updatedItemId = input.itemId;
    return menuItem(chickenId, "Chicken Salad", { imageUrl: input.secureUrl });
  };

  try {
    const started = await executeAgentTool(
      "start_menu_item_image_upload",
      {},
      context({ originalMessage: "I want to add an image" })
    );
    assert.equal(started.data.stage, "awaiting_image");

    const uploaded = await prepareUploadedMenuItemImage({
      restaurantId,
      senderPhone,
      senderRole: "owner",
      image: { secureUrl, publicId, uploadedAt: new Date() }
    });
    const uploadedAction = actions.find(
      (action) => action.action === "IMAGE_ASSIGNMENT" && action.status === "pending"
    );
    assert.equal(uploadedAction.data.stage, "awaiting_item");
    assert.match(uploaded.message, /which menu item/i);

    const assigned = await executeAgentTool(
      "assign_pending_image_to_menu_item",
      {
        pendingActionId: String(uploadedAction._id),
        itemName: "Chicken Salad"
      },
      context({ originalMessage: "it belongs to Chicken Salad" })
    );
    assert.equal(assigned.success, true);
    assert.equal(uploadedAction.data.stage, "awaiting_confirmation");
    assert.equal(uploadedAction.data.itemName, "Chicken Salad");
    assert.match(assigned.message, /Chicken Salad/);

    const confirmed = await executeAgentTool(
      "confirm_pending_image_assignment",
      { pendingActionId: String(uploadedAction._id) },
      context({ originalMessage: "yeah use it" })
    );
    assert.equal(confirmed.success, true);
    assert.equal(uploadedAction.status, "completed");
    assert.equal(updatedItemId, chickenId);
    assert.equal(confirmed.data.itemName, "Chicken Salad");
  } finally {
    restore(PendingAgentAction, "findOne", originalPendingFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalPendingFindOneAndUpdate);
    restore(PendingAgentAction, "updateMany", originalPendingUpdateMany);
    restore(PendingAgentAction, "create", originalPendingCreate);
    restore(MenuItem, "find", originalMenuFind);
    restore(MenuItem, "findOne", originalMenuFindOne);
    restore(menuItemService, "updateTrustedMenuItemImage", originalTrustedUpdate);
  }
});

test("assignment tool handles Check Check Fried Rice without a text parser", async () => {
  const originalPendingFindOne = PendingAgentAction.findOne;
  const originalMenuFind = MenuItem.find;
  const pending = pendingImage();

  PendingAgentAction.findOne = async () => pending;
  MenuItem.find = () =>
    queryResult([menuItem(riceId, "Check Check Fried Rice")]);

  try {
    const result = await executeAgentTool(
      "assign_pending_image_to_menu_item",
      {
        pendingActionId: imageActionId,
        itemName: "Check Check Fried Rice"
      },
      context({ originalMessage: "that's for Check Check Fried Rice" })
    );

    assert.equal(result.success, true);
    assert.equal(pending.data.stage, "awaiting_confirmation");
    assert.equal(pending.data.itemName, "Check Check Fried Rice");
    assert.equal(String(pending.selectedMenuItemId), riceId);
  } finally {
    restore(PendingAgentAction, "findOne", originalPendingFindOne);
    restore(MenuItem, "find", originalMenuFind);
  }
});

test("retarget keeps the image pending and confirmation applies only the new item", async () => {
  const originalPendingFindOne = PendingAgentAction.findOne;
  const originalPendingFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const originalMenuFind = MenuItem.find;
  const originalMenuFindOne = MenuItem.findOne;
  const originalTrustedUpdate = menuItemService.updateTrustedMenuItemImage;
  const pending = pendingImage({
    arguments: { itemId: chickenId },
    data: { stage: "awaiting_confirmation", itemName: "Chicken Salad" },
    selectedMenuItemId: chickenId
  });
  let updatedItemId;

  PendingAgentAction.findOne = async () => pending;
  PendingAgentAction.findOneAndUpdate = async (filter, update) => {
    assert.equal(filter.actionVersion, 2);
    Object.assign(pending, update.$set);
    return pending;
  };
  MenuItem.find = () => queryResult([menuItem(riceId, "Jollof")]);
  MenuItem.findOne = async (filter) =>
    String(filter._id) === riceId ? menuItem(riceId, "Jollof") : null;
  menuItemService.updateTrustedMenuItemImage = async (input) => {
    updatedItemId = input.itemId;
    return menuItem(riceId, "Jollof", { imageUrl: input.secureUrl });
  };

  try {
    const retargeted = await executeAgentTool(
      "assign_pending_image_to_menu_item",
      { pendingActionId: imageActionId, itemName: "Jollof" },
      context({ originalMessage: "actually use it for Jollof instead" })
    );

    assert.equal(retargeted.success, true);
    assert.equal(pending.status, "pending");
    assert.equal(pending.data.stage, "awaiting_confirmation");
    assert.equal(pending.data.itemName, "Jollof");
    assert.equal(String(pending.selectedMenuItemId), riceId);
    assert.match(retargeted.message, /Jollof instead/);
    assert.equal(updatedItemId, undefined);

    const confirmed = await executeAgentTool(
      "confirm_pending_image_assignment",
      { pendingActionId: imageActionId },
      context({ originalMessage: "yes" })
    );
    assert.equal(confirmed.success, true);
    assert.equal(updatedItemId, riceId);
    assert.equal(pending.status, "completed");
  } finally {
    restore(PendingAgentAction, "findOne", originalPendingFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalPendingFindOneAndUpdate);
    restore(MenuItem, "find", originalMenuFind);
    restore(MenuItem, "findOne", originalMenuFindOne);
    restore(menuItemService, "updateTrustedMenuItemImage", originalTrustedUpdate);
  }
});

test("cancel tool binds to the exact action and cancelled work cannot execute", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  const originalFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const pending = pendingImage({
    data: { stage: "awaiting_confirmation", itemName: "Chicken Salad" },
    selectedMenuItemId: chickenId
  });
  let cancelFilter;
  let claims = 0;

  PendingAgentAction.findOne = async () => pending;
  PendingAgentAction.findOneAndUpdate = async (filter, update) => {
    cancelFilter = filter;
    if (update.$set.status === "cancelled") {
      Object.assign(pending, update.$set);
      return pending;
    }
    claims += 1;
    return null;
  };

  try {
    const cancelled = await executeAgentTool(
      "cancel_pending_image_assignment",
      { pendingActionId: imageActionId },
      context({ originalMessage: "no cancel it" })
    );
    assert.equal(cancelled.success, true);
    assert.equal(pending.status, "cancelled");
    assert.equal(cancelFilter._id, imageActionId);
    assert.equal(cancelFilter.restaurantId, restaurantId);
    assert.equal(cancelFilter.senderPhone, senderPhone);
    assert.equal(cancelFilter.senderRole, "owner");

    const confirmed = await executeAgentTool(
      "confirm_pending_image_assignment",
      { pendingActionId: imageActionId },
      context()
    );
    assert.equal(confirmed.success, false);
    assert.equal(confirmed.code, "PENDING_IMAGE_NOT_FOUND");
    assert.equal(claims, 0);
  } finally {
    restore(PendingAgentAction, "findOne", originalFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalFindOneAndUpdate);
  }
});

test("cancel tool safely cancels an exact awaiting-image context", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  const originalFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const awaitingImage = pendingImage({
    action: "MENU_ITEM_IMAGE_CONTEXT",
    toolName: undefined,
    arguments: undefined,
    data: {
      stage: "awaiting_image",
      itemId: chickenId,
      itemName: "Chicken Salad"
    },
    imageSecureUrl: undefined,
    imagePublicId: undefined,
    uploadedAt: undefined,
    selectedMenuItemId: chickenId
  });
  let cancellationWrites = 0;
  let initialFilter;

  PendingAgentAction.findOne = async (filter) => {
    initialFilter = filter;
    return awaitingImage;
  };
  PendingAgentAction.findOneAndUpdate = async (filter, update) => {
    cancellationWrites += 1;
    assert.equal(filter._id, imageActionId);
    assert.equal(filter.restaurantId, restaurantId);
    assert.equal(filter.senderPhone, senderPhone);
    assert.equal(filter.senderRole, "owner");
    assert.equal(filter.action, "MENU_ITEM_IMAGE_CONTEXT");
    Object.assign(awaitingImage, update.$set);
    return awaitingImage;
  };

  try {
    const first = await executeAgentTool(
      "cancel_pending_image_assignment",
      { pendingActionId: imageActionId },
      context({ originalMessage: "never mind, cancel it" })
    );
    const repeated = await executeAgentTool(
      "cancel_pending_image_assignment",
      { pendingActionId: imageActionId },
      context({ originalMessage: "cancel it" })
    );

    assert.deepEqual(initialFilter.action.$in, [
      "MENU_ITEM_IMAGE_CONTEXT",
      "IMAGE_ASSIGNMENT"
    ]);
    assert.equal(first.success, true);
    assert.equal(repeated.success, true);
    assert.equal(repeated.data.idempotent, true);
    assert.equal(awaitingImage.status, "cancelled");
    assert.equal(cancellationWrites, 1);
  } finally {
    restore(PendingAgentAction, "findOne", originalFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalFindOneAndUpdate);
  }
});

test("explicit uploaded-image cancellation cleanup is non-fatal and idempotent", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  const originalFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const originalDestroy = cloudinary.uploader.destroy;
  const originalApiKey = process.env.CLOUDINARY_API_KEY;
  const originalApiSecret = process.env.CLOUDINARY_API_SECRET;
  const pending = pendingImage({
    data: { stage: "awaiting_confirmation", itemName: "Chicken Salad" },
    selectedMenuItemId: chickenId
  });
  let cancellationWrites = 0;
  let deleteAttempts = 0;

  process.env.CLOUDINARY_API_KEY = "test-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  PendingAgentAction.findOne = async () => pending;
  PendingAgentAction.findOneAndUpdate = async (_filter, update) => {
    cancellationWrites += 1;
    Object.assign(pending, update.$set);
    return pending;
  };
  cloudinary.uploader.destroy = async () => {
    deleteAttempts += 1;
    throw new Error("simulated cleanup outage");
  };

  try {
    const first = await executeAgentTool(
      "cancel_pending_image_assignment",
      { pendingActionId: imageActionId },
      context({ originalMessage: "no, cancel it" })
    );
    const repeated = await executeAgentTool(
      "cancel_pending_image_assignment",
      { pendingActionId: imageActionId },
      context({ originalMessage: "cancel it" })
    );

    assert.equal(first.success, true);
    assert.equal(repeated.success, true);
    assert.equal(repeated.data.idempotent, true);
    assert.equal(pending.status, "cancelled");
    assert.equal(cancellationWrites, 1);
    assert.equal(deleteAttempts, 1);
  } finally {
    restore(PendingAgentAction, "findOne", originalFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalFindOneAndUpdate);
    restore(cloudinary.uploader, "destroy", originalDestroy);
    if (originalApiKey === undefined) delete process.env.CLOUDINARY_API_KEY;
    else process.env.CLOUDINARY_API_KEY = originalApiKey;
    if (originalApiSecret === undefined) delete process.env.CLOUDINARY_API_SECRET;
    else process.env.CLOUDINARY_API_SECRET = originalApiSecret;
  }
});

test("a completed image assignment cannot be cancelled or deleted", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  const originalFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const originalDestroy = cloudinary.uploader.destroy;
  const completed = pendingImage({ status: "completed", completedAt: new Date() });
  let cancellationWrites = 0;
  let deletes = 0;

  PendingAgentAction.findOne = async () => completed;
  PendingAgentAction.findOneAndUpdate = async () => {
    cancellationWrites += 1;
    return null;
  };
  cloudinary.uploader.destroy = async () => {
    deletes += 1;
  };

  try {
    const result = await executeAgentTool(
      "cancel_pending_image_assignment",
      { pendingActionId: imageActionId },
      context()
    );

    assert.equal(result.success, false);
    assert.equal(result.code, "PENDING_IMAGE_NOT_FOUND");
    assert.equal(cancellationWrites, 0);
    assert.equal(deletes, 0);
    assert.equal(completed.status, "completed");
  } finally {
    restore(PendingAgentAction, "findOne", originalFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalFindOneAndUpdate);
    restore(cloudinary.uploader, "destroy", originalDestroy);
  }
});

test("invalid, cross-restaurant, cross-sender, and customer image operations are rejected", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  let databaseLookups = 0;
  let capturedFilter;

  PendingAgentAction.findOne = async (filter) => {
    databaseLookups += 1;
    capturedFilter = filter;
    return null;
  };

  try {
    const invalid = await executeAgentTool(
      "confirm_pending_image_assignment",
      { pendingActionId: "invented-action" },
      context()
    );
    assert.equal(invalid.code, "TOOL_INVALID_ARGUMENTS");
    assert.equal(databaseLookups, 0);

    const invalidItem = await executeAgentTool(
      "start_menu_item_image_upload",
      { itemId: "invented-item" },
      context()
    );
    assert.equal(invalidItem.code, "TOOL_INVALID_ARGUMENTS");
    assert.equal(databaseLookups, 0);

    const crossRestaurant = await executeAgentTool(
      "confirm_pending_image_assignment",
      { pendingActionId: imageActionId },
      context({
        restaurantId: otherRestaurantId,
        restaurant: { _id: otherRestaurantId, name: "Other Restaurant" }
      })
    );
    assert.equal(crossRestaurant.code, "PENDING_IMAGE_NOT_FOUND");
    assert.equal(capturedFilter.restaurantId, otherRestaurantId);
    assert.equal(crossRestaurant.message.includes("Chicken Salad"), false);

    const crossSender = await executeAgentTool(
      "confirm_pending_image_assignment",
      { pendingActionId: imageActionId },
      context({
        sender: {
          phone: otherSenderPhone,
          normalizedPhone: otherSenderPhone,
          role: "manager",
          verified: true
        }
      })
    );
    assert.equal(crossSender.code, "PENDING_IMAGE_NOT_FOUND");
    assert.equal(capturedFilter.senderPhone, otherSenderPhone);
    assert.equal(capturedFilter.senderRole, "manager");

    const customer = await executeAgentTool(
      "start_menu_item_image_upload",
      {},
      context({
        sender: {
          phone: "+233557038547",
          normalizedPhone: "+233557038547",
          role: "customer",
          verified: false
        }
      })
    );
    assert.equal(customer.code, "TOOL_FORBIDDEN");
  } finally {
    restore(PendingAgentAction, "findOne", originalFindOne);
  }
});

test("assignment rejects a menu item ID that is not in the current restaurant", async () => {
  const originalMenuFindOne = MenuItem.findOne;
  const originalPendingFindOne = PendingAgentAction.findOne;
  let menuFilter;
  let pendingLookups = 0;

  MenuItem.findOne = async (filter) => {
    menuFilter = filter;
    return null;
  };
  PendingAgentAction.findOne = async () => {
    pendingLookups += 1;
    return pendingImage();
  };

  try {
    const result = await executeAgentTool(
      "assign_pending_image_to_menu_item",
      { pendingActionId: imageActionId, itemId: riceId },
      context()
    );

    assert.equal(result.code, "MENU_ITEM_NOT_FOUND");
    assert.deepEqual(menuFilter, { _id: riceId, restaurantId });
    assert.equal(pendingLookups, 0);
  } finally {
    restore(MenuItem, "findOne", originalMenuFindOne);
    restore(PendingAgentAction, "findOne", originalPendingFindOne);
  }
});

test("expired exact image assignment is rejected before any menu mutation", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  const originalFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const originalTrustedUpdate = menuItemService.updateTrustedMenuItemImage;
  const pending = pendingImage({ expiresAt: new Date(Date.now() - 1) });
  let claims = 0;
  let updates = 0;

  PendingAgentAction.findOne = async () => pending;
  PendingAgentAction.findOneAndUpdate = async () => {
    claims += 1;
    return null;
  };
  menuItemService.updateTrustedMenuItemImage = async () => {
    updates += 1;
  };

  try {
    const result = await executeAgentTool(
      "confirm_pending_image_assignment",
      { pendingActionId: imageActionId },
      context()
    );
    assert.equal(result.code, "PENDING_IMAGE_NOT_FOUND");
    assert.equal(pending.status, "expired");
    assert.equal(claims, 0);
    assert.equal(updates, 0);
  } finally {
    restore(PendingAgentAction, "findOne", originalFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalFindOneAndUpdate);
    restore(menuItemService, "updateTrustedMenuItemImage", originalTrustedUpdate);
  }
});

test("confirmation rejects an exact pending image that is still awaiting an item", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  const originalFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const pending = pendingImage({ data: { stage: "awaiting_item" } });
  let claims = 0;

  PendingAgentAction.findOne = async () => pending;
  PendingAgentAction.findOneAndUpdate = async () => {
    claims += 1;
    return null;
  };

  try {
    const result = await executeAgentTool(
      "confirm_pending_image_assignment",
      { pendingActionId: imageActionId },
      context()
    );
    assert.equal(result.code, "PENDING_IMAGE_WRONG_STAGE");
    assert.equal(pending.status, "pending");
    assert.equal(claims, 0);
  } finally {
    restore(PendingAgentAction, "findOne", originalFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalFindOneAndUpdate);
  }
});

test("duplicate confirmation is idempotent and previous image deletion runs once", async () => {
  const originalFindOne = PendingAgentAction.findOne;
  const originalFindOneAndUpdate = PendingAgentAction.findOneAndUpdate;
  const originalMenuFindOne = MenuItem.findOne;
  const originalTrustedUpdate = menuItemService.updateTrustedMenuItemImage;
  const originalDestroy = cloudinary.uploader.destroy;
  const originalApiKey = process.env.CLOUDINARY_API_KEY;
  const originalApiSecret = process.env.CLOUDINARY_API_SECRET;
  const pending = pendingImage({
    data: { stage: "awaiting_confirmation", itemName: "Chicken Salad" },
    selectedMenuItemId: chickenId
  });
  let writes = 0;
  let deletes = 0;

  process.env.CLOUDINARY_API_KEY = "test-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  PendingAgentAction.findOne = async () => pending;
  PendingAgentAction.findOneAndUpdate = async (_filter, update) => {
    Object.assign(pending, update.$set);
    return pending;
  };
  MenuItem.findOne = async () =>
    menuItem(chickenId, "Chicken Salad", { imageUrl: previousUrl });
  menuItemService.updateTrustedMenuItemImage = async (input) => {
    writes += 1;
    return menuItem(chickenId, "Chicken Salad", { imageUrl: input.secureUrl });
  };
  cloudinary.uploader.destroy = async (deletedPublicId) => {
    assert.equal(deletedPublicId, previousPublicId);
    deletes += 1;
    return { result: "ok" };
  };

  try {
    const first = await executeAgentTool(
      "confirm_pending_image_assignment",
      { pendingActionId: imageActionId },
      context()
    );
    const repeated = await executeAgentTool(
      "confirm_pending_image_assignment",
      { pendingActionId: imageActionId },
      context()
    );

    assert.equal(first.success, true);
    assert.equal(first.data.idempotent, false);
    assert.equal(repeated.success, true);
    assert.equal(repeated.data.idempotent, true);
    assert.equal(writes, 1);
    assert.equal(deletes, 1);
  } finally {
    restore(PendingAgentAction, "findOne", originalFindOne);
    restore(PendingAgentAction, "findOneAndUpdate", originalFindOneAndUpdate);
    restore(MenuItem, "findOne", originalMenuFindOne);
    restore(menuItemService, "updateTrustedMenuItemImage", originalTrustedUpdate);
    restore(cloudinary.uploader, "destroy", originalDestroy);
    process.env.CLOUDINARY_API_KEY = originalApiKey;
    process.env.CLOUDINARY_API_SECRET = originalApiSecret;
  }
});

test("image tool definitions expose no media arguments and customer capabilities stay unchanged", async () => {
  const toolNames = [
    "start_menu_item_image_upload",
    "assign_pending_image_to_menu_item",
    "confirm_pending_image_assignment",
    "cancel_pending_image_assignment"
  ];
  const managerDefinitions = getAgentToolDefinitionsForRole("manager");
  const customerDefinitions = getAgentToolDefinitionsForRole("customer");

  for (const name of toolNames) {
    const definition = managerDefinitions.find(
      (candidate) => candidate.function.name === name
    );
    assert.ok(definition, name);
    assert.doesNotMatch(
      JSON.stringify(definition),
      /imageUrl|secureUrl|imageSecureUrl|publicId|imagePublicId/i
    );
    assert.equal(
      customerDefinitions.some((candidate) => candidate.function.name === name),
      false
    );

    const rejected = await executeAgentTool(
      name,
      {
        pendingActionId: imageActionId,
        itemName: "Chicken Salad",
        imageUrl: secureUrl,
        secureUrl,
        publicId
      },
      context()
    );
    assert.equal(rejected.code, "TOOL_INVALID_ARGUMENTS", name);
  }

  assert.equal(
    customerDefinitions.some(
      (candidate) => candidate.function.name === "search_menu_items"
    ),
    true
  );
});

test("existing image display and confirmation-safe removal tools remain available", async () => {
  const originalCategoryFind = MenuCategory.find;
  const originalMenuFind = MenuItem.find;
  const originalPendingUpdateMany = PendingAgentAction.updateMany;
  const originalPendingCreate = PendingAgentAction.create;
  const categoryId = "64b000000000000000000401";
  let removalPending;

  MenuCategory.find = () =>
    queryResult([{ _id: categoryId, name: "Salads" }]);
  MenuItem.find = (filter) => {
    if (filter.name) {
      return queryResult([
        menuItem(chickenId, "Chicken Salad", {
          categoryId,
          imageUrl: secureUrl
        })
      ]);
    }
    return queryResult([]);
  };
  PendingAgentAction.updateMany = async () => ({ modifiedCount: 0 });
  PendingAgentAction.create = async (input) => {
    removalPending = { _id: "64b000000000000000000803", ...input };
    return removalPending;
  };

  try {
    const shown = await executeAgentTool(
      "search_menu_items",
      { query: "Chicken Salad" },
      context()
    );
    assert.equal(shown.success, true);
    assert.equal(shown.data[0].imageUrl, secureUrl);

    const removal = await executeAgentTool(
      "remove_menu_item_image",
      { itemName: "Chicken Salad" },
      context()
    );
    assert.equal(removal.success, true);
    assert.equal(removal.requiresConfirmation, true);
    assert.equal(removalPending.toolName, "remove_menu_item_image");
    assert.equal(removalPending.status, "pending");
  } finally {
    restore(MenuCategory, "find", originalCategoryFind);
    restore(MenuItem, "find", originalMenuFind);
    restore(PendingAgentAction, "updateMany", originalPendingUpdateMany);
    restore(PendingAgentAction, "create", originalPendingCreate);
  }
});
