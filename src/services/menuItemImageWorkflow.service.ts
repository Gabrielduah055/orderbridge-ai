import { MenuItem, type IMenuItemDocument } from "../models/MenuItem";
import { PendingAgentAction } from "../models/pendingAgentAction.model";
import type { SenderRole, ToolResult } from "../types/agent.types";

const imageContextTtlMs = 10 * 60 * 1000;

interface MenuItemImageWorkflowInput {
  restaurantId: string;
  senderPhone: string;
  senderRole: SenderRole;
}

interface ImageWorkflowResult {
  handled: boolean;
  success: boolean;
  message: string;
  itemName?: string;
}

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const cleanItemName = (value: string): string => {
  return value.trim().replace(/[.?!]+$/, "").replace(/\s+/g, " ");
};

export const parseMenuItemImageIntent = (message: string): string | null => {
  const normalized = message.trim().replace(/\s+/g, " ");
  const patterns = [
    /^(?:please\s+)?(?:add|set|use|put|attach|update|change|replace)\s+(?:an?\s+|the\s+)?(?:image|photo|picture)\s+(?:to|for|on|of)\s+(.+)$/i,
    /^(?:please\s+)?(?:add|set|use|put|attach|update|change|replace)\s+(.+?)(?:'s)?\s+(?:image|photo|picture)$/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const itemName = match?.[1] ? cleanItemName(match[1]) : "";

    if (itemName) {
      return itemName;
    }
  }

  return null;
};

const findMenuItem = async (
  restaurantId: string,
  itemName: string
): Promise<IMenuItemDocument | null> => {
  return MenuItem.findOne({
    restaurantId,
    name: {
      $regex: `^${escapeRegExp(cleanItemName(itemName))}$`,
      $options: "i"
    }
  });
};

const cancelPendingImageContexts = async (
  restaurantId: string,
  senderPhone: string,
  senderRole: SenderRole,
  resultMessage: string
): Promise<void> => {
  await PendingAgentAction.updateMany(
    {
      restaurantId,
      senderPhone,
      senderRole,
      action: "MENU_ITEM_IMAGE_CONTEXT",
      status: "pending"
    },
    {
      $set: {
        status: "cancelled",
        resultMessage
      }
    }
  );
};

const createImageConfirmation = async (
  input: MenuItemImageWorkflowInput & {
    itemId: string;
    itemName: string;
    imageUrl: string;
  }
): Promise<string> => {
  await Promise.all([
    cancelPendingImageContexts(
      input.restaurantId,
      input.senderPhone,
      input.senderRole,
      "Image context was converted to a confirmation."
    ),
    PendingAgentAction.updateMany(
      {
        restaurantId: input.restaurantId,
        senderPhone: input.senderPhone,
        senderRole: input.senderRole,
        action: "TOOL_CALL",
        toolName: "set_menu_item_image",
        status: "pending"
      },
      {
        $set: {
          status: "cancelled",
          resultMessage: "Superseded by a newer pending image confirmation."
        }
      }
    )
  ]);

  const confirmationMessage = `I received the image. Should I use it for ${input.itemName}?`;

  await PendingAgentAction.create({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    action: "TOOL_CALL",
    toolName: "set_menu_item_image",
    arguments: {
      itemId: input.itemId,
      imageUrl: input.imageUrl
    },
    data: {
      itemId: input.itemId,
      itemName: input.itemName,
      imageUrl: input.imageUrl
    },
    status: "pending",
    summary: `Set image for ${input.itemName}`,
    confirmationMessage,
    expiresAt: new Date(Date.now() + imageContextTtlMs)
  });

  return confirmationMessage;
};

export const rememberMenuItemImageRequest = async (
  input: MenuItemImageWorkflowInput & { message: string }
): Promise<ImageWorkflowResult> => {
  const requestedItemName = parseMenuItemImageIntent(input.message);

  if (!requestedItemName) {
    return {
      handled: false,
      success: false,
      message: ""
    };
  }

  const item = await findMenuItem(input.restaurantId, requestedItemName);

  if (!item) {
    return {
      handled: true,
      success: false,
      message: `I couldn't find a menu item named ${requestedItemName}. Please check the item name.`
    };
  }

  await cancelPendingImageContexts(
    input.restaurantId,
    input.senderPhone,
    input.senderRole,
    "Superseded by a newer menu item image request."
  );
  await PendingAgentAction.create({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    action: "MENU_ITEM_IMAGE_CONTEXT",
    data: {
      stage: "awaiting_image",
      itemId: String(item._id),
      itemName: item.name
    },
    status: "pending",
    summary: `Waiting for an image for ${item.name}`,
    confirmationMessage: `Please send the image you'd like to use for ${item.name}.`,
    expiresAt: new Date(Date.now() + imageContextTtlMs)
  });

  return {
    handled: true,
    success: true,
    itemName: item.name,
    message: `Please send the image you'd like to use for ${item.name}.`
  };
};

export const prepareUploadedMenuItemImage = async (
  input: MenuItemImageWorkflowInput & { imageUrl: string }
): Promise<ImageWorkflowResult> => {
  const context = await PendingAgentAction.findOne({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    action: "MENU_ITEM_IMAGE_CONTEXT",
    status: "pending",
    expiresAt: { $gt: new Date() },
    "data.stage": "awaiting_image"
  }).sort({ createdAt: -1 });
  const itemId = typeof context?.data?.itemId === "string" ? context.data.itemId : undefined;
  const itemName = typeof context?.data?.itemName === "string" ? context.data.itemName : undefined;

  if (itemId && itemName) {
    return {
      handled: true,
      success: true,
      itemName,
      message: await createImageConfirmation({
        ...input,
        itemId,
        itemName
      })
    };
  }

  await cancelPendingImageContexts(
    input.restaurantId,
    input.senderPhone,
    input.senderRole,
    "Superseded by a newly uploaded image."
  );
  await PendingAgentAction.create({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    action: "MENU_ITEM_IMAGE_CONTEXT",
    data: {
      stage: "awaiting_item",
      imageUrl: input.imageUrl
    },
    status: "pending",
    summary: "Waiting for the menu item name for an uploaded image",
    confirmationMessage: "Which menu item does this image belong to?",
    expiresAt: new Date(Date.now() + imageContextTtlMs)
  });

  return {
    handled: true,
    success: true,
    message: "I received the image. Which menu item does it belong to?"
  };
};

export const cancelPendingMenuItemImageConfirmation = async (
  input: MenuItemImageWorkflowInput & { pendingActionId: string }
): Promise<ToolResult> => {
  const pendingAction = await PendingAgentAction.findOne({
    _id: input.pendingActionId,
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    action: "TOOL_CALL",
    toolName: "set_menu_item_image",
    status: "pending",
    expiresAt: { $gt: new Date() }
  });

  if (!pendingAction) {
    return {
      success: false,
      code: "PENDING_ACTION_NOT_FOUND",
      message: "There is no pending image action to cancel."
    };
  }

  pendingAction.status = "cancelled";
  pendingAction.resultMessage = "Pending image action cancelled.";
  await pendingAction.save();

  return {
    success: true,
    message: "Okay, I cancelled that pending image action."
  };
};

export const attachPendingImageToNamedMenuItem = async (
  input: MenuItemImageWorkflowInput & { message: string }
): Promise<ImageWorkflowResult> => {
  const context = await PendingAgentAction.findOne({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    action: "MENU_ITEM_IMAGE_CONTEXT",
    status: "pending",
    expiresAt: { $gt: new Date() },
    "data.stage": "awaiting_item"
  }).sort({ createdAt: -1 });
  const imageUrl = typeof context?.data?.imageUrl === "string" ? context.data.imageUrl : undefined;

  if (!context || !imageUrl) {
    return {
      handled: false,
      success: false,
      message: ""
    };
  }

  const item = await findMenuItem(input.restaurantId, input.message);

  if (!item) {
    return {
      handled: true,
      success: false,
      message: `I couldn't find a menu item named ${cleanItemName(input.message)}. Which menu item does the image belong to?`
    };
  }

  return {
    handled: true,
    success: true,
    itemName: item.name,
    message: await createImageConfirmation({
      ...input,
      itemId: String(item._id),
      itemName: item.name,
      imageUrl
    })
  };
};
