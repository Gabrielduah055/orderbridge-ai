import { Types } from "mongoose";
import { MenuItem, type IMenuItemDocument } from "../models/MenuItem";
import {
  PendingAgentAction,
  type IPendingAgentActionDocument
} from "../models/pendingAgentAction.model";
import type { SenderRole, ToolResult } from "../types/agent.types";
import {
  deleteImageByUrl,
  validateTrustedCloudinaryImage,
  type TrustedCloudinaryImage
} from "./cloudinary.service";
import * as menuItemService from "./menuItem.service";

const imageContextTtlMs = 10 * 60 * 1000;
const missingImageMessage = "I can’t find the uploaded image anymore. Please send it again.";

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
  pendingActionId?: string;
}

export type MenuItemImageStage = "awaiting_item" | "awaiting_confirmation";

interface MenuItemMatchResult {
  kind: "one" | "multiple" | "none";
  item?: IMenuItemDocument;
  items: IMenuItemDocument[];
}

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const cleanItemName = (value: string): string => {
  return value
    .trim()
    .replace(/^(?:the)\s+/i, "")
    .replace(/[.?!]+$/, "")
    .replace(/\s+/g, " ");
};

const normalizeDecisionText = (message: string): string => {
  return message
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

export const isMenuItemImageConfirmationMessage = (message: string): boolean => {
  const normalized = normalizeDecisionText(message);

  return (
    /^(?:yes|yea|yeah|yep|yup|yh|sure|correct|confirm|confirmed|okay|ok)\b/.test(
      normalized
    ) ||
    /^(?:do it|add it|use it)\b/.test(normalized)
  );
};

export const isMenuItemImageCancellationMessage = (message: string): boolean => {
  const normalized = normalizeDecisionText(message);

  return (
    /^(?:no|nope|nah|cancel|stop|abort)\b/.test(normalized) ||
    /^(?:don't|dont)\s+(?:use|add|save|update|change|do it|proceed)\b/.test(normalized) ||
    /^(?:never mind|nevermind|not now|leave it|ignore it)\b/.test(normalized)
  );
};

const isLikelyMenuItemNameReply = (message: string): boolean => {
  const normalized = message.trim().replace(/\s+/g, " ");
  const decisionText = normalizeDecisionText(message);

  if (
    !normalized ||
    normalized.length > 100 ||
    normalized.includes("?") ||
    normalized.split(" ").length > 8
  ) {
    return false;
  }

  if (
    /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|you\s+there|are\s+you\s+there|wait|hold\s+on|what|why|how|when|where|who|thanks|thank\s+you|help)\b/.test(
      decisionText
    )
  ) {
    return false;
  }

  return /^[\p{L}\p{N}][\p{L}\p{N}\s&'\u2019().-]*[.!]?$/u.test(normalized);
};

export const shouldHandlePendingMenuItemImageReply = (
  stage: MenuItemImageStage,
  message: string
): boolean => {
  if (isMenuItemImageCancellationMessage(message)) {
    return true;
  }

  if (stage === "awaiting_confirmation") {
    return isMenuItemImageConfirmationMessage(message);
  }

  const requestedItemName = extractMenuItemNameFromImageReply(message);
  return Boolean(
    requestedItemName && isLikelyMenuItemNameReply(requestedItemName)
  );
};

export const extractMenuItemNameFromImageReply = (message: string): string | null => {
  const normalized = message.trim().replace(/\s+/g, " ");
  const withoutConfirmation = normalized.replace(
    /^(?:yes|yea|yeah|yep|yup|yh|sure|correct|confirm|confirmed|okay|ok)\b[\s,;:-]*/i,
    ""
  );
  const actionPatterns = [
    /^(?:please\s+)?(?:add|set|use|put|attach|assign)\s+(?:(?:the|this|that|uploaded)\s+)?(?:image|photo|picture|it)\s+(?:to|for|on)\s+(.+)$/i,
    /^(?:do it|add it|use it)\s+(?:to|for|on)\s+(.+)$/i,
    /^(?:(?:it|this|that)|(?:the|this|that)\s+(?:image|photo|picture))\s+(?:belongs\s+to|is\s+for)\s+(.+)$/i
  ];

  for (const pattern of actionPatterns) {
    const candidate = withoutConfirmation.match(pattern)?.[1];

    if (candidate) {
      return cleanItemName(candidate);
    }
  }

  if (isMenuItemImageConfirmationMessage(message)) {
    return null;
  }

  const candidate = cleanItemName(normalized);
  return candidate || null;
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

const findMenuItemMatches = async (
  restaurantId: string,
  itemName: string
): Promise<MenuItemMatchResult> => {
  const escapedName = escapeRegExp(cleanItemName(itemName));
  const exactItems = await MenuItem.find({
    restaurantId,
    name: {
      $regex: `^${escapedName}$`,
      $options: "i"
    }
  }).sort({ createdAt: -1 });
  const items =
    exactItems.length > 0
      ? exactItems
      : await MenuItem.find({
          restaurantId,
          name: { $regex: escapedName, $options: "i" }
        }).sort({ createdAt: -1 });

  if (items.length === 0) {
    return { kind: "none", items };
  }

  if (items.length > 1) {
    return { kind: "multiple", items };
  }

  return { kind: "one", item: items[0], items };
};

const formatMatchFailure = (itemName: string, match: MenuItemMatchResult): string => {
  if (match.kind === "multiple") {
    return `I found multiple menu items matching ${cleanItemName(itemName)}. Please clarify which one should use the image.`;
  }

  return `I couldn't find a menu item named ${cleanItemName(itemName)}. Which menu item does the image belong to?`;
};

const cancelPendingImageRequestContexts = async (
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

const cancelOlderPendingImageUploads = async (
  restaurantId: string,
  senderPhone: string,
  senderRole: SenderRole
): Promise<void> => {
  await PendingAgentAction.updateMany(
    {
      restaurantId,
      senderPhone,
      senderRole,
      action: "IMAGE_ASSIGNMENT",
      status: "pending"
    },
    {
      $set: {
        status: "cancelled",
        resultMessage: "Superseded by a newer uploaded image."
      }
    }
  );
};

const findActivePendingImage = async (
  input: MenuItemImageWorkflowInput
): Promise<IPendingAgentActionDocument | null> => {
  return PendingAgentAction.findOne({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    action: "IMAGE_ASSIGNMENT",
    status: "pending",
    expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 });
};

export const getActivePendingMenuItemImageStage = async (
  input: MenuItemImageWorkflowInput
): Promise<MenuItemImageStage | null> => {
  const pendingImage = await findActivePendingImage(input);
  const stage = pendingImage?.data?.stage;

  return stage === "awaiting_item" || stage === "awaiting_confirmation"
    ? stage
    : null;
};

const setPendingImageTarget = async (
  pendingImage: IPendingAgentActionDocument,
  item: { itemId: string; itemName: string }
): Promise<void> => {
  pendingImage.selectedMenuItemId = new Types.ObjectId(item.itemId);
  pendingImage.arguments = { itemId: item.itemId };
  pendingImage.data = {
    ...pendingImage.data,
    stage: "awaiting_confirmation",
    itemName: item.itemName
  };
  pendingImage.summary = `Set the uploaded image for ${item.itemName}`;
  pendingImage.confirmationMessage = `I received the image. Should I use it for ${item.itemName}?`;
  await pendingImage.save();
};

export const rememberMenuItemImageRequest = async (
  input: MenuItemImageWorkflowInput & { message: string }
): Promise<ImageWorkflowResult> => {
  const requestedItemName = parseMenuItemImageIntent(input.message);

  if (!requestedItemName) {
    return { handled: false, success: false, message: "" };
  }

  const match = await findMenuItemMatches(input.restaurantId, requestedItemName);

  if (match.kind !== "one" || !match.item) {
    return {
      handled: true,
      success: false,
      message: formatMatchFailure(requestedItemName, match)
    };
  }

  await cancelPendingImageRequestContexts(
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
      itemId: String(match.item._id),
      itemName: match.item.name
    },
    status: "pending",
    summary: `Waiting for an image for ${match.item.name}`,
    confirmationMessage: `Please send the image you'd like to use for ${match.item.name}.`,
    expiresAt: new Date(Date.now() + imageContextTtlMs)
  });

  return {
    handled: true,
    success: true,
    itemName: match.item.name,
    message: `Please send the image you'd like to use for ${match.item.name}.`
  };
};

export const prepareUploadedMenuItemImage = async (
  input: MenuItemImageWorkflowInput & { image: TrustedCloudinaryImage }
): Promise<ImageWorkflowResult> => {
  if (!validateTrustedCloudinaryImage(input.image)) {
    throw new Error("The uploaded image failed trusted Cloudinary validation.");
  }

  const requestContext = await PendingAgentAction.findOne({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    action: "MENU_ITEM_IMAGE_CONTEXT",
    status: "pending",
    expiresAt: { $gt: new Date() },
    "data.stage": "awaiting_image"
  }).sort({ createdAt: -1 });
  const itemId =
    typeof requestContext?.data?.itemId === "string" ? requestContext.data.itemId : undefined;
  const itemName =
    typeof requestContext?.data?.itemName === "string" ? requestContext.data.itemName : undefined;

  await cancelOlderPendingImageUploads(
    input.restaurantId,
    input.senderPhone,
    input.senderRole
  );
  await cancelPendingImageRequestContexts(
    input.restaurantId,
    input.senderPhone,
    input.senderRole,
    "Image received."
  );

  const confirmationMessage =
    itemId && itemName
      ? `I received the image. Should I use it for ${itemName}?`
      : "Which menu item does this image belong to?";
  const pendingImage = await PendingAgentAction.create({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    action: "IMAGE_ASSIGNMENT",
    toolName: "set_menu_item_image",
    arguments: itemId ? { itemId } : {},
    data: {
      stage: itemId && itemName ? "awaiting_confirmation" : "awaiting_item",
      ...(itemName ? { itemName } : {})
    },
    imageSecureUrl: input.image.secureUrl,
    imagePublicId: input.image.publicId,
    uploadedAt: input.image.uploadedAt,
    ...(itemId ? { selectedMenuItemId: itemId } : {}),
    status: "pending",
    summary: itemName
      ? `Set the uploaded image for ${itemName}`
      : "Waiting for the menu item name for an uploaded image",
    confirmationMessage,
    expiresAt: new Date(Date.now() + imageContextTtlMs)
  });

  console.info("Trusted pending image upload created", {
    restaurantId: input.restaurantId,
    senderRole: input.senderRole,
    pendingActionId: String(pendingImage._id),
    hasProposedItem: Boolean(itemId)
  });

  return {
    handled: true,
    success: true,
    itemName,
    pendingActionId: String(pendingImage._id),
    message: itemName
      ? confirmationMessage
      : "I received the image. Which menu item does it belong to?"
  };
};

export const selectPendingMenuItemImage = async (
  input: MenuItemImageWorkflowInput & {
    itemId: string;
    itemName: string;
    confirmImmediately?: boolean;
  }
): Promise<ToolResult> => {
  const pendingImage = await findActivePendingImage(input);

  if (!pendingImage) {
    return {
      success: false,
      code: "PENDING_IMAGE_NOT_FOUND",
      message: missingImageMessage
    };
  }

  await setPendingImageTarget(pendingImage, input);

  if (input.confirmImmediately) {
    return confirmPendingMenuItemImage({
      ...input,
      pendingActionId: String(pendingImage._id)
    });
  }

  return {
    success: true,
    requiresConfirmation: true,
    pendingActionId: String(pendingImage._id),
    message: pendingImage.confirmationMessage
  };
};

export const confirmPendingMenuItemImage = async (
  input: MenuItemImageWorkflowInput & { pendingActionId: string }
): Promise<ToolResult> => {
  const scopedFilter = {
    _id: input.pendingActionId,
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    action: "IMAGE_ASSIGNMENT"
  };
  const existing = await PendingAgentAction.findOne(scopedFilter);

  if (!existing) {
    return { success: false, code: "PENDING_IMAGE_NOT_FOUND", message: missingImageMessage };
  }

  if (existing.status === "completed") {
    return {
      success: true,
      message: existing.resultMessage ?? "The uploaded image was already assigned.",
      data: {
        itemId: existing.selectedMenuItemId ? String(existing.selectedMenuItemId) : undefined,
        idempotent: true
      }
    };
  }

  if (existing.status !== "pending" || existing.expiresAt.getTime() <= Date.now()) {
    if (existing.status === "pending") {
      existing.status = "expired";
      existing.resultMessage = missingImageMessage;
      await existing.save();
    }

    return { success: false, code: "PENDING_IMAGE_NOT_FOUND", message: missingImageMessage };
  }

  if (
    !existing.selectedMenuItemId ||
    !existing.imageSecureUrl ||
    !existing.imagePublicId ||
    !validateTrustedCloudinaryImage({
      secureUrl: existing.imageSecureUrl,
      publicId: existing.imagePublicId
    })
  ) {
    existing.status = "failed";
    existing.errorMessage = "Trusted Cloudinary upload metadata is missing or invalid.";
    await existing.save();
    return { success: false, code: "PENDING_IMAGE_INVALID", message: missingImageMessage };
  }

  const claimed = await PendingAgentAction.findOneAndUpdate(
    { ...scopedFilter, status: "pending" },
    { $set: { status: "processing" } },
    { new: true }
  );

  if (!claimed) {
    const completed = await PendingAgentAction.findOne(scopedFilter);
    return completed?.status === "completed"
      ? {
          success: true,
          message: completed.resultMessage ?? "The uploaded image was already assigned.",
          data: { itemId: String(completed.selectedMenuItemId), idempotent: true }
        }
      : {
          success: false,
          code: "IMAGE_ASSIGNMENT_IN_PROGRESS",
          message: "That image assignment is already being processed."
      };
  }

  if (!claimed.imageSecureUrl || !claimed.imagePublicId) {
    claimed.status = "failed";
    claimed.errorMessage = "Trusted Cloudinary upload metadata disappeared before assignment.";
    await claimed.save();
    return { success: false, code: "PENDING_IMAGE_INVALID", message: missingImageMessage };
  }

  const trustedSecureUrl = claimed.imageSecureUrl;
  const trustedPublicId = claimed.imagePublicId;

  const item = await MenuItem.findOne({
    _id: claimed.selectedMenuItemId,
    restaurantId: input.restaurantId
  });

  if (!item) {
    claimed.status = "failed";
    claimed.errorMessage = "The selected menu item was not found in this restaurant.";
    claimed.resultMessage = "I couldn't find that menu item, so I did not assign the image.";
    await claimed.save();
    return {
      success: false,
      code: "MENU_ITEM_NOT_FOUND",
      message: claimed.resultMessage
    };
  }

  try {
    const previousImageUrl = item.imageUrl;
    const updated = await menuItemService.updateTrustedMenuItemImage({
      restaurantId: input.restaurantId,
      itemId: String(item._id),
      secureUrl: trustedSecureUrl,
      publicId: trustedPublicId
    });

    if (previousImageUrl && previousImageUrl !== updated.imageUrl) {
      await deleteImageByUrl(previousImageUrl);
    }

    claimed.status = "completed";
    claimed.completedAt = new Date();
    claimed.resultMessage = `Done — I added the uploaded image to ${updated.name}.`;
    await claimed.save();

    console.info("Trusted pending image assigned", {
      restaurantId: input.restaurantId,
      senderRole: input.senderRole,
      pendingActionId: String(claimed._id),
      menuItemId: String(updated._id)
    });

    return {
      success: true,
      message: claimed.resultMessage,
      data: { itemId: String(updated._id), itemName: updated.name, idempotent: false }
    };
  } catch (error) {
    claimed.status = "failed";
    claimed.errorMessage = error instanceof Error ? error.message : "Image assignment failed.";
    claimed.resultMessage = "I couldn't assign that image. Please send it again.";
    await claimed.save();
    throw error;
  }
};

export const cancelPendingMenuItemImageConfirmation = async (
  input: MenuItemImageWorkflowInput & { pendingActionId: string }
): Promise<ToolResult> => {
  const pendingAction = await PendingAgentAction.findOne({
    _id: input.pendingActionId,
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    action: "IMAGE_ASSIGNMENT",
    status: "pending",
    expiresAt: { $gt: new Date() }
  });

  if (!pendingAction) {
    return { success: false, code: "PENDING_IMAGE_NOT_FOUND", message: missingImageMessage };
  }

  pendingAction.status = "cancelled";
  pendingAction.resultMessage = "Pending image action cancelled.";
  await pendingAction.save();

  return { success: true, message: "Okay, I cancelled that pending image action." };
};

export const attachPendingImageToNamedMenuItem = async (
  input: MenuItemImageWorkflowInput & { message: string }
): Promise<ImageWorkflowResult> => {
  const pendingImage = await findActivePendingImage(input);

  if (!pendingImage || pendingImage.data?.stage !== "awaiting_item") {
    return { handled: false, success: false, message: "" };
  }

  const requestedItemName = extractMenuItemNameFromImageReply(input.message);

  if (!requestedItemName) {
    return {
      handled: true,
      success: false,
      message: "Which menu item should use the uploaded image?"
    };
  }

  const match = await findMenuItemMatches(input.restaurantId, requestedItemName);

  if (match.kind !== "one" || !match.item) {
    return {
      handled: true,
      success: false,
      message: formatMatchFailure(requestedItemName, match)
    };
  }

  await setPendingImageTarget(pendingImage, {
    itemId: String(match.item._id),
    itemName: match.item.name
  });

  if (isMenuItemImageConfirmationMessage(input.message)) {
    const result = await confirmPendingMenuItemImage({
      ...input,
      pendingActionId: String(pendingImage._id)
    });
    return {
      handled: true,
      success: result.success,
      itemName: match.item.name,
      pendingActionId: String(pendingImage._id),
      message: result.message
    };
  }

  return {
    handled: true,
    success: true,
    itemName: match.item.name,
    pendingActionId: String(pendingImage._id),
    message: pendingImage.confirmationMessage
  };
};

export const handlePendingMenuItemImageReply = async (
  input: MenuItemImageWorkflowInput & { message: string }
): Promise<ImageWorkflowResult> => {
  const pendingImage = await findActivePendingImage(input);

  if (!pendingImage) {
    if (isMenuItemImageConfirmationMessage(input.message)) {
      const expiredImage = await PendingAgentAction.findOne({
        restaurantId: input.restaurantId,
        senderPhone: input.senderPhone,
        senderRole: input.senderRole,
        action: "IMAGE_ASSIGNMENT",
        status: "pending",
        expiresAt: { $lte: new Date() }
      }).sort({ createdAt: -1 });

      if (expiredImage) {
        const result = await confirmPendingMenuItemImage({
          ...input,
          pendingActionId: String(expiredImage._id)
        });
        return { handled: true, success: result.success, message: result.message };
      }
    }

    return { handled: false, success: false, message: "" };
  }

  if (isMenuItemImageCancellationMessage(input.message)) {
    const result = await cancelPendingMenuItemImageConfirmation({
      ...input,
      pendingActionId: String(pendingImage._id)
    });
    return { handled: true, success: result.success, message: result.message };
  }

  if (pendingImage.data?.stage === "awaiting_item") {
    if (!shouldHandlePendingMenuItemImageReply("awaiting_item", input.message)) {
      return { handled: false, success: false, message: "" };
    }

    return attachPendingImageToNamedMenuItem(input);
  }

  if (!isMenuItemImageConfirmationMessage(input.message)) {
    return { handled: false, success: false, message: "" };
  }

  const requestedItemName = extractMenuItemNameFromImageReply(input.message);

  if (requestedItemName) {
    const match = await findMenuItemMatches(input.restaurantId, requestedItemName);

    if (match.kind !== "one" || !match.item) {
      return {
        handled: true,
        success: false,
        message: formatMatchFailure(requestedItemName, match)
      };
    }

    await setPendingImageTarget(pendingImage, {
      itemId: String(match.item._id),
      itemName: match.item.name
    });
  }

  const result = await confirmPendingMenuItemImage({
    ...input,
    pendingActionId: String(pendingImage._id)
  });

  return {
    handled: true,
    success: result.success,
    pendingActionId: String(pendingImage._id),
    message: result.message
  };
};
