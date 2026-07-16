import { Types } from "mongoose";
import { MenuItem, type IMenuItemDocument } from "../models/MenuItem";
import {
  PendingAgentAction,
  type IPendingAgentActionDocument,
  type OwnerAgentAction
} from "../models/pendingAgentAction.model";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import * as menuCategoryService from "./menuCategory.service";
import * as menuItemService from "./menuItem.service";
import { BadRequestError, ForbiddenError, NotFoundError } from "../utils/httpErrors";
import { normalizeGhanaPhone } from "../utils/phone.util";

interface OwnerAgentMessageInput {
  restaurantId: string;
  senderPhone: string;
  message: string;
}

interface OwnerAgentResponse {
  success: boolean;
  message: string;
  data?: unknown;
  requiresConfirmation?: boolean;
  pendingActionId?: string;
  source?: "rule_based";
}

interface ParsedPendingAction {
  action: OwnerAgentAction;
  data: Record<string, unknown>;
  confirmationMessage: string;
}

const defaultCategoryName = "Main Meals";
const unknownMessage =
  "I can help with menu items, prices, availability, orders, and delivery information. Could you rephrase what you want me to do?";

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const normalizeText = (value: string): string => {
  return value.trim().replace(/\s+/g, " ");
};

const normalizeComparableText = (value: string): string => {
  return normalizeText(value).toLowerCase();
};

const titleCase = (value: string): string => {
  return normalizeComparableText(value).replace(/\b\w/g, (char) => char.toUpperCase());
};

const ensureValidRestaurantId = (restaurantId: string): void => {
  if (!Types.ObjectId.isValid(restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }
};

const getRestaurantOrThrow = async (restaurantId: string): Promise<IRestaurantDocument> => {
  ensureValidRestaurantId(restaurantId);
  const restaurant = await Restaurant.findById(restaurantId);

  if (!restaurant) {
    throw new NotFoundError("Restaurant not found");
  }

  return restaurant;
};

const assertSenderCanManageRestaurant = (
  restaurant: IRestaurantDocument,
  senderPhone: string
): string => {
  const normalizedSenderPhone = normalizeGhanaPhone(senderPhone);
  const managerContactPhones = restaurant.managerContacts.map((manager) => manager.phone);
  const allowedPhones = [
    restaurant.ownerPhone,
    ...restaurant.managerPhones,
    ...managerContactPhones
  ].map(normalizeGhanaPhone);

  if (!allowedPhones.includes(normalizedSenderPhone)) {
    throw new ForbiddenError("Sender phone is not authorized for this restaurant");
  }

  return normalizedSenderPhone;
};

const isShowMenuMessage = (message: string): boolean => {
  return ["show menu", "show my menu", "list menu"].includes(normalizeComparableText(message));
};

const isConfirmationMessage = (message: string): boolean => {
  return ["yes", "confirm", "save it", "do it"].includes(normalizeComparableText(message));
};

const isCancellationMessage = (message: string): boolean => {
  return ["no", "cancel", "don't save", "dont save", "stop"].includes(
    normalizeComparableText(message)
  );
};

const parseAddMenuItem = (message: string): ParsedPendingAction | null => {
  const match = normalizeText(message).match(
    /^add\s+(.+?)\s+(\d+(?:\.\d+)?)(?:\s+under\s+(.+))?$/i
  );

  if (!match) {
    return null;
  }

  const name = titleCase(match[1]);
  const price = Number(match[2]);
  const categoryName = match[3] ? titleCase(match[3]) : defaultCategoryName;

  if (!Number.isFinite(price) || price <= 0) {
    throw new BadRequestError("Price must be positive");
  }

  return {
    action: "ADD_MENU_ITEM",
    data: {
      name,
      price,
      categoryName
    },
    confirmationMessage: `I'm about to add ${name} for GHS ${price} under ${categoryName}. Should I save it?`
  };
};

const parseUpdateMenuPrice = (message: string): ParsedPendingAction | null => {
  const normalized = normalizeText(message).replace(/^(boss|please|hi|hello),?\s+/i, "");
  const patterns = [
    /^change\s+(.+?)\s+price\s+to\s+(?:ghs\s*)?(\d+(?:\.\d+)?)(?:\s+cedis?)?$/i,
    /^update\s+(.+?)\s+to\s+(?:ghs\s*)?(\d+(?:\.\d+)?)(?:\s+cedis?)?$/i,
    /^set\s+(.+?)\s+price\s+to\s+(?:ghs\s*)?(\d+(?:\.\d+)?)(?:\s+cedis?)?$/i,
    /^increase\s+(.+?)\s+to\s+(?:ghs\s*)?(\d+(?:\.\d+)?)(?:\s+cedis?)?$/i,
    /^increase\s+(.+?)\s+price\s+to\s+(?:ghs\s*)?(\d+(?:\.\d+)?)(?:\s+cedis?)?$/i,
    /^increase\s+the\s+(.+?)\s+to\s+(?:ghs\s*)?(\d+(?:\.\d+)?)(?:\s+cedis?)?$/i,
    /^increase\s+the\s+(.+?)\s+price\s+to\s+(?:ghs\s*)?(\d+(?:\.\d+)?)(?:\s+cedis?)?$/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);

    if (match) {
      const itemName = titleCase(match[1]);
      const price = Number(match[2]);

      if (!Number.isFinite(price) || price <= 0) {
        throw new BadRequestError("Price must be positive");
      }

      return {
        action: "UPDATE_MENU_PRICE",
        data: {
          itemName,
          price
        },
        confirmationMessage: `I'm about to change ${itemName} price to GHS ${price}. Should I save it?`
      };
    }
  }

  return null;
};

const parseMarkUnavailable = (message: string): ParsedPendingAction | null => {
  const normalized = normalizeText(message);
  const patterns = [
    /^mark\s+(.+?)\s+unavailable$/i,
    /^we are out of\s+(.+)$/i,
    /^(.+?)\s+is not available$/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);

    if (match) {
      const itemName = titleCase(match[1]);

      return {
        action: "MARK_ITEM_UNAVAILABLE",
        data: {
          itemName
        },
        confirmationMessage: `I'm about to mark ${itemName} as unavailable. Should I save it?`
      };
    }
  }

  return null;
};

const parseMarkAvailable = (message: string): ParsedPendingAction | null => {
  const normalized = normalizeText(message);
  const patterns = [
    /^mark\s+(.+?)\s+available$/i,
    /^bring\s+(.+?)\s+back$/i,
    /^(.+?)\s+is available now$/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);

    if (match) {
      const itemName = titleCase(match[1]);

      return {
        action: "MARK_ITEM_AVAILABLE",
        data: {
          itemName
        },
        confirmationMessage: `I'm about to mark ${itemName} as available. Should I save it?`
      };
    }
  }

  return null;
};

const parsePendingAction = (message: string): ParsedPendingAction | null => {
  return (
    parseAddMenuItem(message) ??
    parseUpdateMenuPrice(message) ??
    parseMarkUnavailable(message) ??
    parseMarkAvailable(message)
  );
};

const expireOldPendingActions = async (): Promise<void> => {
  await PendingAgentAction.updateMany(
    {
      status: "pending",
      expiresAt: {
        $lte: new Date()
      }
    },
    {
      $set: {
        status: "expired",
        resultMessage: "Pending action expired."
      }
    }
  );
};

const createPendingAction = async (
  restaurantId: string,
  senderPhone: string,
  parsed: ParsedPendingAction
): Promise<IPendingAgentActionDocument> => {
  return PendingAgentAction.create({
    restaurantId,
    senderPhone,
    action: parsed.action,
    data: parsed.data,
    status: "pending",
    confirmationMessage: parsed.confirmationMessage,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  });
};

const findLatestPendingAction = async (
  restaurantId: string,
  senderPhone: string
): Promise<IPendingAgentActionDocument | null> => {
  await expireOldPendingActions();

  return PendingAgentAction.findOne({
    restaurantId,
    senderPhone,
    status: "pending",
    expiresAt: {
      $gt: new Date()
    }
  }).sort({ createdAt: -1 });
};

const findMenuItemByName = async (
  restaurantId: string,
  itemName: string
): Promise<IMenuItemDocument | OwnerAgentResponse> => {
  const items = await MenuItem.find({
    restaurantId,
    name: {
      $regex: escapeRegExp(normalizeText(itemName)),
      $options: "i"
    }
  }).sort({ createdAt: -1 });

  if (items.length === 0) {
    return {
      success: false,
      message: `I couldn't find a menu item matching "${itemName}".`
    };
  }

  if (items.length > 1) {
    return {
      success: false,
      message: `I found multiple menu items matching "${itemName}". Please be more specific.`,
      data: items.map((item) => ({
        id: item._id,
        name: item.name,
        price: item.price,
        isAvailable: item.isAvailable
      }))
    };
  }

  return items[0];
};

const ensureSingleItemMatchForPendingAction = async (
  restaurantId: string,
  parsed: ParsedPendingAction
): Promise<OwnerAgentResponse | null> => {
  if (parsed.action === "ADD_MENU_ITEM") {
    return null;
  }

  const itemName = String(parsed.data.itemName);
  const match = await findMenuItemByName(restaurantId, itemName);

  if ("success" in match) {
    return match;
  }

  return null;
};

const getOrCreateCategory = async (restaurantId: string, categoryName: string) => {
  const categories = await menuCategoryService.getCategoriesByRestaurant(restaurantId);
  const existingCategory = categories.find(
    (category) => normalizeComparableText(category.name) === normalizeComparableText(categoryName)
  );

  if (existingCategory) {
    return existingCategory;
  }

  return menuCategoryService.createCategory(restaurantId, {
    name: titleCase(categoryName),
    isActive: true
  });
};

const executePendingAction = async (
  action: IPendingAgentActionDocument
): Promise<OwnerAgentResponse> => {
  if (action.action === "ADD_MENU_ITEM") {
    const name = String(action.data.name);
    const price = Number(action.data.price);
    const categoryName = String(action.data.categoryName ?? defaultCategoryName);
    const description =
      typeof action.data.description === "string" ? action.data.description : undefined;
    const category = await getOrCreateCategory(String(action.restaurantId), categoryName);
    const item = await menuItemService.addMenuItem(String(action.restaurantId), {
      categoryId: String(category._id),
      name,
      price,
      description
    });
    const resultMessage = `${item.name} has been added to the menu for GHS ${item.price}.`;

    action.status = "completed";
    action.resultMessage = resultMessage;
    await action.save();

    return {
      success: true,
      message: resultMessage,
      data: item
    };
  }

  const itemName = String(action.data.itemName);
  const itemMatch = await findMenuItemByName(String(action.restaurantId), itemName);

  if ("success" in itemMatch) {
    action.status = "failed";
    action.errorMessage = itemMatch.message;
    await action.save();
    return itemMatch;
  }

  if (action.action === "UPDATE_MENU_PRICE") {
    const price = Number(action.data.price);
    const item = await menuItemService.updateMenuItem(String(itemMatch._id), { price });
    const resultMessage = `${item.name} price has been updated to GHS ${item.price}.`;

    action.status = "completed";
    action.resultMessage = resultMessage;
    await action.save();

    return {
      success: true,
      message: resultMessage,
      data: item
    };
  }

  const isAvailable = action.action === "MARK_ITEM_AVAILABLE";
  const item = await menuItemService.updateMenuItemAvailability(
    String(itemMatch._id),
    isAvailable
  );
  const resultMessage = `${item.name} has been marked ${
    item.isAvailable ? "available" : "unavailable"
  }.`;

  action.status = "completed";
  action.resultMessage = resultMessage;
  await action.save();

  return {
    success: true,
    message: resultMessage,
    data: item
  };
};

const showMenu = async (restaurantId: string): Promise<OwnerAgentResponse> => {
  const categories = await menuCategoryService.getCategoriesByRestaurant(restaurantId);
  const items = await menuItemService.getMenuItemsByRestaurant(restaurantId);
  const activeItems = items.filter((item) => item.isAvailable);
  const data = categories.map((category) => ({
    id: category._id,
    name: category.name,
    description: category.description,
    sortOrder: category.sortOrder,
    items: activeItems
      .filter((item) => String(item.categoryId) === String(category._id))
      .map((item) => ({
        id: item._id,
        name: item.name,
        description: item.description,
        price: item.price,
        imageUrl: item.imageUrl,
        tags: item.tags,
        allergens: item.allergens,
        portionSize: item.portionSize,
        isPopular: item.isPopular,
        isPromoItem: item.isPromoItem
      }))
  }));

  return {
    success: true,
    message: "Menu fetched successfully",
    data
  };
};

export const handleOwnerMessage = async (
  input: OwnerAgentMessageInput
): Promise<OwnerAgentResponse> => {
  const restaurant = await getRestaurantOrThrow(input.restaurantId);
  const senderPhone = assertSenderCanManageRestaurant(restaurant, input.senderPhone);
  const message = normalizeText(input.message);

  if (isConfirmationMessage(message)) {
    const pendingAction = await findLatestPendingAction(input.restaurantId, senderPhone);

    if (!pendingAction) {
      return {
        success: false,
        message: "There is no pending action to confirm."
      };
    }

    return executePendingAction(pendingAction);
  }

  if (isCancellationMessage(message)) {
    const pendingAction = await findLatestPendingAction(input.restaurantId, senderPhone);

    if (!pendingAction) {
      return {
        success: false,
        message: "There is no pending action to cancel."
      };
    }

    pendingAction.status = "cancelled";
    pendingAction.resultMessage = "Pending action cancelled.";
    await pendingAction.save();

    return {
      success: true,
      message: "Okay, I cancelled that pending action.",
      data: pendingAction
    };
  }

  let parsedAction: ParsedPendingAction | null = null;

  if (isShowMenuMessage(message)) {
    return {
      ...(await showMenu(input.restaurantId)),
      source: "rule_based"
    };
  }

  parsedAction = parsePendingAction(message);

  if (!parsedAction) {
    return {
      success: false,
      source: "rule_based",
      message: unknownMessage
    };
  }

  const matchError = await ensureSingleItemMatchForPendingAction(input.restaurantId, parsedAction);

  if (matchError) {
    return {
      ...matchError,
      source: "rule_based"
    };
  }

  const pendingAction = await createPendingAction(
    input.restaurantId,
    senderPhone,
    parsedAction
  );

  return {
    success: true,
    source: "rule_based",
    requiresConfirmation: true,
    message: parsedAction.confirmationMessage,
    pendingActionId: String(pendingAction._id),
    data: pendingAction
  };
};
