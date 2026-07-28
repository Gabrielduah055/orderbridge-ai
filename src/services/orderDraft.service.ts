import {
  CustomerSession,
  type ICustomerSessionCartItem,
  type ICustomerSessionDocument
} from "../models/customerSession.model";
import { Order, type IOrderDocument } from "../models/order.model";
import { MenuCategory } from "../models/MenuCategory";
import { MenuItem, type IMenuItemDocument } from "../models/MenuItem";
import type { IRestaurantDocument } from "../models/Restaurant";
import * as orderService from "./order.service";
import { cancelPendingOrderItemClarifications } from "./agentClarification.service";
import { BadRequestError } from "../utils/httpErrors";

const sessionTtlMs = 2 * 60 * 60 * 1000;
const quantityCorrectionWindowMs = 5 * 60 * 1000;

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");
const normalizeComparableText = (value: string): string => normalizeText(value).toLowerCase();
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const numberWords = new Map<string, number>([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10]
]);

const ambiguousQuantityPhrases = [
  /\b(that|this|the)\s+one\b/,
  /\b(another one|one more)\b/,
  /\b(the|that|this)\s+(?:ghs\s*)?\d+(?:\.\d+)?\s+(package|pack|option|one)\b/,
  /^(ok|okay|yes|yeah|yh|sure|alright)$/
];

const quantityCorrectionPatterns = [
  /\bmake\s+it\b/,
  /\bchange\s+it\s+to\b/,
  /\bactually\b/,
  /\boh\s+no\b/,
  /\bno,?\s+i\s+want\b/,
  /\bincrease\s+it\s+to\b/,
  /\breduce\s+it\s+to\b/,
  /\bi\s+said\b/
];

const onlyThatCompletionPatterns = [
  /\bonly\s+that\b/,
  /\bi\s+want\s+only\s+that\b/,
  /\bjust\s+that\b/,
  /\bthat's\s+all\b/,
  /\bthats\s+all\b/,
  /\bthat\s+is\s+all\b/,
  /\bproceed\s+with\s+that\b/,
  /\bi\s+don'?t\s+want\s+anything\s+else\b/
];

export type MenuItemMatchResult =
  | {
      status: "matched";
      item: IMenuItemDocument;
    }
  | {
      status: "none";
      message: string;
    }
  | {
      status: "multiple";
      message: string;
      matches: IMenuItemDocument[];
      category?: {
        id: string;
        name: string;
      };
    };

export const getDraftExpiry = (): Date => new Date(Date.now() + sessionTtlMs);

export const resetDraftState = (session: ICustomerSessionDocument): void => {
  session.cartItems = [];
  session.pendingMenuItemId = undefined;
  session.pendingMenuItemName = undefined;
  session.pendingCategoryId = undefined;
  session.pendingCategoryName = undefined;
  session.lastModifiedMenuItemId = undefined;
  session.lastModifiedMenuItemName = undefined;
  session.lastModifiedCategoryName = undefined;
  session.lastModifiedDisplayName = undefined;
  session.lastModifiedAt = undefined;
  session.lastModifiedPreviousQuantity = undefined;
  session.lastModifiedCurrentQuantity = undefined;
  session.currentStep = "idle";
  session.orderType = null;
  session.deliveryAddress = undefined;
  session.deliveryFee = undefined;
  session.deliveryFeeSource = undefined;
  session.deliveryFeeResolved = false;
  session.lastFollowUpKey = undefined;
  session.lastFollowUpAt = undefined;
};

export const clearConvertedDraftState = (session: ICustomerSessionDocument): void => {
  session.convertedOrderId = undefined;
  session.convertedAt = undefined;
};

export const clearPendingMenuItem = (session: ICustomerSessionDocument): void => {
  session.pendingMenuItemId = undefined;
  session.pendingMenuItemName = undefined;
};

export const clearPendingCategory = (session: ICustomerSessionDocument): void => {
  session.pendingCategoryId = undefined;
  session.pendingCategoryName = undefined;
};

export const getMenuItemCategoryName = (item: IMenuItemDocument): string | undefined => {
  return (item as IMenuItemDocument & { categoryName?: string }).categoryName;
};

export const getMenuItemDisplayName = (
  item: Pick<IMenuItemDocument, "name">,
  categoryName?: string
): string => {
  const itemName = normalizeText(item.name);
  const normalizedItemName = normalizeComparableText(itemName);
  const normalizedCategoryName = categoryName ? normalizeComparableText(categoryName) : "";

  if (!normalizedCategoryName || normalizedItemName.includes(normalizedCategoryName)) {
    return itemName;
  }

  return `${itemName} ${normalizeText(categoryName!)}`;
};

export const getCartItemDisplayName = (
  item: Pick<ICustomerSessionCartItem, "name" | "categoryName" | "displayName">
): string => item.displayName?.trim() || getMenuItemDisplayName({ name: item.name }, item.categoryName);

const rememberLastModifiedCartItem = (
  session: ICustomerSessionDocument,
  item: ICustomerSessionCartItem,
  previousQuantity: number
): void => {
  session.lastModifiedMenuItemId = item.menuItemId;
  session.lastModifiedMenuItemName = item.name;
  session.lastModifiedCategoryName = item.categoryName;
  session.lastModifiedDisplayName = getCartItemDisplayName(item);
  session.lastModifiedAt = new Date();
  session.lastModifiedPreviousQuantity = previousQuantity;
  session.lastModifiedCurrentQuantity = item.quantity;
};

export const parseExplicitQuantity = (message: string): number | null => {
  const normalized = normalizeComparableText(message);

  if (ambiguousQuantityPhrases.some((pattern) => pattern.test(normalized))) {
    return null;
  }

  const digitMatches = Array.from(normalized.matchAll(/\b(\d+)\b/g));

  for (const digitMatch of digitMatches) {
    const index = digitMatch.index ?? 0;
    const before = normalized.slice(Math.max(0, index - 12), index);
    const after = normalized.slice(index + digitMatch[0].length, index + digitMatch[0].length + 18);

    if (/\b(ghs|cedis?|gh₵)\s*$/i.test(before) || /^\s*(cedis?|package|option)\b/i.test(after)) {
      continue;
    }

    const quantity = Number(digitMatch[1]);

    return Number.isInteger(quantity) && quantity > 0 ? quantity : null;
  }

  for (const [word, quantity] of numberWords.entries()) {
    if (new RegExp(`\\b${word}\\b`).test(normalized)) {
      return quantity;
    }
  }

  if (/\b(a|an)\s+(plate|pack|portion|bowl|serving|box)\b/.test(normalized)) {
    return 1;
  }

  return null;
};

export const parseQuantityCorrection = (message: string): number | null => {
  const normalized = normalizeComparableText(message);

  if (!quantityCorrectionPatterns.some((pattern) => pattern.test(normalized))) {
    return null;
  }

  return parseExplicitQuantity(message);
};

export const isOnlyThatCompletionMessage = (message: string): boolean => {
  const normalized = normalizeComparableText(message);

  return onlyThatCompletionPatterns.some((pattern) => pattern.test(normalized));
};

export const resolveTrustedQuantity = (
  modelQuantity: number | undefined,
  customerMessage?: string,
  pendingQuantity?: number | null
): number | null => {
  if (pendingQuantity && Number.isInteger(pendingQuantity) && pendingQuantity > 0) {
    return pendingQuantity;
  }

  const explicitQuantity = customerMessage ? parseExplicitQuantity(customerMessage) : null;

  if (!explicitQuantity) {
    return null;
  }

  if (modelQuantity !== undefined && modelQuantity !== explicitQuantity) {
    return null;
  }

  return explicitQuantity;
};

export const recordInboundCustomerTurn = async (
  restaurantId: string,
  customerPhone: string,
  inboundEventId?: string,
  customerName?: string
): Promise<ICustomerSessionDocument> => {
  const session = await getOrCreateDraft(restaurantId, customerPhone, customerName);

  if (inboundEventId && session.lastInboundEventId === inboundEventId) {
    return session;
  }

  session.conversationVersion = (session.conversationVersion ?? 0) + 1;
  session.lastInboundEventId = inboundEventId;
  session.expiresAt = getDraftExpiry();
  return session.save();
};

export const getOrCreateDraft = async (
  restaurantId: string,
  customerPhone: string,
  customerName?: string
): Promise<ICustomerSessionDocument> => {
  let session = await CustomerSession.findOne({
    restaurantId,
    customerPhone
  });

  if (!session) {
    return CustomerSession.create({
      restaurantId,
      customerPhone,
      customerName,
      cartItems: [],
      currentStep: "idle",
      orderType: null,
      deliveryFeeResolved: false,
      conversationVersion: 0,
      expiresAt: getDraftExpiry()
    });
  }

  if (session.expiresAt <= new Date()) {
    resetDraftState(session);
  }

  if (customerName) {
    session.customerName = customerName;
  }

  session.expiresAt = getDraftExpiry();
  return session.save();
};

export const findActiveDraft = async (
  restaurantId: string,
  customerPhone: string
): Promise<ICustomerSessionDocument | null> => {
  return CustomerSession.findOne({
    restaurantId,
    customerPhone,
    expiresAt: {
      $gt: new Date()
    }
  });
};

export const findMenuItemMatch = async (
  restaurantId: string,
  requestedName: string
): Promise<MenuItemMatchResult> => {
  const normalizedRequestedName = normalizeComparableText(requestedName);
  const activeCategories = await MenuCategory.find({
    restaurantId,
    isActive: true
  });
  const categoryNameById = new Map(
    activeCategories.map((category) => [String(category._id), category.name])
  );
  const matchingCategory = activeCategories.find((category) => {
    const normalizedCategoryName = normalizeComparableText(category.name);

    return (
      normalizedCategoryName.includes(normalizedRequestedName) ||
      normalizedRequestedName.includes(normalizedCategoryName)
    );
  });
  const items = await MenuItem.find({
    restaurantId,
    categoryId: {
      $in: activeCategories.map((category) => category._id)
    }
  });
  const matches = items.filter((item) => {
    const normalizedItemName = normalizeComparableText(item.name);

    return (
      normalizedItemName.includes(normalizedRequestedName) ||
      normalizedRequestedName.includes(normalizedItemName)
    );
  });
  const categoryScopedMatches = matchingCategory
    ? items.filter((item) => String(item.categoryId) === String(matchingCategory._id))
    : [];
  const effectiveMatches = matches.length > 0 ? matches : categoryScopedMatches;

  if (effectiveMatches.length === 0) {
    return {
      status: "none",
      message: `I couldn't find "${requestedName}" on the menu. Try calling get_menu to see available items.`
    };
  }

  for (const item of effectiveMatches) {
    (item as IMenuItemDocument & { categoryName?: string }).categoryName =
      categoryNameById.get(String(item.categoryId));
  }

  if (effectiveMatches.length > 1) {
    const sharedCategoryId = effectiveMatches.every(
      (item) => String(item.categoryId) === String(effectiveMatches[0].categoryId)
    )
      ? String(effectiveMatches[0].categoryId)
      : undefined;
    return {
      status: "multiple",
      message: `Multiple items matched "${requestedName}". Ask the customer to be more specific: ${effectiveMatches
        .map((item) => item.name)
        .join(", ")}.`,
      matches: effectiveMatches,
      category:
        sharedCategoryId && categoryNameById.get(sharedCategoryId)
          ? {
              id: sharedCategoryId,
              name: categoryNameById.get(sharedCategoryId)!
            }
          : undefined
    };
  }

  const item = effectiveMatches[0];

  if (!item.isAvailable) {
    return {
      status: "none",
      message: `${item.name} is currently unavailable.`
    };
  }

  return {
    status: "matched",
    item
  };
};

export const addItemToDraft = (
  session: ICustomerSessionDocument,
  item: IMenuItemDocument,
  quantity: number
): void => {
  clearConvertedDraftState(session);

  const categoryName = getMenuItemCategoryName(item);
  const displayName = getMenuItemDisplayName(item, categoryName);
  const existingItem = session.cartItems.find(
    (cartItem) => String(cartItem.menuItemId) === String(item._id)
  );

  if (existingItem) {
    const previousQuantity = existingItem.quantity;
    existingItem.quantity += quantity;
    existingItem.totalPrice = existingItem.quantity * existingItem.unitPrice;
    existingItem.categoryId = existingItem.categoryId ?? item.categoryId;
    existingItem.categoryName = existingItem.categoryName ?? categoryName;
    existingItem.displayName = existingItem.displayName ?? displayName;
    rememberLastModifiedCartItem(session, existingItem, previousQuantity);
    return;
  }

  const cartItem = {
    menuItemId: item._id,
    name: item.name,
    categoryId: item.categoryId,
    categoryName,
    displayName,
    quantity,
    unitPrice: item.price,
    totalPrice: item.price * quantity
  };

  session.cartItems.push(cartItem);
  rememberLastModifiedCartItem(session, cartItem, 0);
};

export const addPendingItemToDraft = async (
  session: ICustomerSessionDocument,
  restaurantId: string,
  quantity: number
): Promise<string> => {
  if (!session.pendingMenuItemId) {
    return "Please tell me which item you want to update.";
  }

  const item = await MenuItem.findOne({
    _id: session.pendingMenuItemId,
    restaurantId,
    isAvailable: true
  });

  if (!item) {
    clearPendingMenuItem(session);
    session.currentStep = "choosing_items";
    return "That item is no longer available. Please choose another item.";
  }

  if (item.categoryId && !getMenuItemCategoryName(item)) {
    const category = await MenuCategory.findOne({
      _id: item.categoryId,
      restaurantId,
      isActive: true
    });

    if (category) {
      (item as IMenuItemDocument & { categoryName?: string }).categoryName = category.name;
    }
  }

  const displayName = getMenuItemDisplayName(item, getMenuItemCategoryName(item));
  addItemToDraft(session, item, quantity);
  clearPendingMenuItem(session);
  clearPendingCategory(session);
  session.currentStep = "choosing_items";
  await cancelPendingOrderItemClarifications({
    restaurantId,
    senderPhone: session.customerPhone
  });

  return `Added ${quantity} x ${displayName} to the order draft.`;
};

export const updateRecentCartItemQuantity = (
  session: ICustomerSessionDocument,
  quantity: number,
  now = new Date()
):
  | {
      status: "updated";
      message: string;
      item: ICustomerSessionCartItem;
    }
  | {
      status: "needs_item";
      message: string;
    } => {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return {
      status: "needs_item",
      message: "Please provide a positive quantity to update."
    };
  }

  const lastModifiedAt = session.lastModifiedAt?.getTime?.() ?? 0;
  const withinCorrectionWindow =
    Boolean(session.lastModifiedMenuItemId) &&
    lastModifiedAt > 0 &&
    now.getTime() - lastModifiedAt <= quantityCorrectionWindowMs;

  if (!withinCorrectionWindow) {
    return {
      status: "needs_item",
      message: "Which item would you like me to change?"
    };
  }

  const item = session.cartItems.find(
    (cartItem) => String(cartItem.menuItemId) === String(session.lastModifiedMenuItemId)
  );

  if (!item) {
    return {
      status: "needs_item",
      message: "Which item would you like me to change?"
    };
  }

  const previousQuantity = item.quantity;
  item.quantity = quantity;
  item.totalPrice = item.unitPrice * quantity;
  rememberLastModifiedCartItem(session, item, previousQuantity);

  const displayName = getCartItemDisplayName(item);

  return {
    status: "updated",
    message: `Updated ${displayName} from ${previousQuantity} portions to ${quantity} portions.`,
    item
  };
};

export const removeItemFromDraft = (
  session: ICustomerSessionDocument,
  requestedName: string,
  quantity?: number
): string => {
  const normalizedRequestedName = normalizeComparableText(requestedName);
  const matches = session.cartItems.filter((item) => {
    const normalizedItemName = normalizeComparableText(getCartItemDisplayName(item));
    const normalizedRawName = normalizeComparableText(item.name);

    return (
      normalizedItemName.includes(normalizedRequestedName) ||
      normalizedRequestedName.includes(normalizedItemName) ||
      normalizedRawName.includes(normalizedRequestedName) ||
      normalizedRequestedName.includes(normalizedRawName)
    );
  });

  if (matches.length === 0) {
    return `I couldn't find "${requestedName}" in the draft.`;
  }

  if (matches.length > 1) {
    return `Multiple draft items matched "${requestedName}". Ask the customer to be more specific: ${matches
      .map(getCartItemDisplayName)
      .join(", ")}.`;
  }

  const matchedItem = matches[0];
  const displayName = getCartItemDisplayName(matchedItem);
  const removeQuantity = quantity ?? matchedItem.quantity;

  if (!Number.isInteger(removeQuantity) || removeQuantity <= 0) {
    return "Please provide a positive quantity to remove.";
  }

  if (removeQuantity >= matchedItem.quantity) {
    session.cartItems = session.cartItems.filter(
      (item) => String(item.menuItemId) !== String(matchedItem.menuItemId)
    );
    return `${displayName} removed from the draft.`;
  }

  matchedItem.quantity -= removeQuantity;
  matchedItem.totalPrice = matchedItem.quantity * matchedItem.unitPrice;

  return `Removed ${removeQuantity} x ${displayName} from the draft.`;
};

export const getDraftSubtotal = (session: ICustomerSessionDocument): number => {
  return session.cartItems.reduce((sum, item) => sum + item.totalPrice, 0);
};

export const getMissingDraftFields = (session: ICustomerSessionDocument): string[] => {
  const missing: string[] = [];

  if (session.cartItems.length === 0) {
    missing.push("items");
  }

  if (session.pendingMenuItemId) {
    missing.push("quantity");
  }

  if (!session.orderType) {
    missing.push("orderType");
  }

  if (session.orderType === "delivery" && !session.deliveryAddress?.trim()) {
    missing.push("deliveryAddress");
  }

  if (
    session.orderType === "delivery" &&
    !session.deliveryFeeResolved &&
    session.deliveryFeeSource !== "manual_confirmation"
  ) {
    missing.push("deliveryFee");
  }

  if (!session.customerName?.trim()) {
    missing.push("customerName");
  }

  return missing;
};

export const findMenuItemMatchInCategory = async (
  restaurantId: string,
  categoryId: string,
  requestedName: string
): Promise<MenuItemMatchResult> => {
  const normalizedRequestedName = normalizeComparableText(
    requestedName.replace(/\b(with|from)\b/gi, " ")
  );
  const category = await MenuCategory.findOne({
    _id: categoryId,
    restaurantId,
    isActive: true
  });

  if (!category) {
    return {
      status: "none",
      message: "That menu category is no longer available."
    };
  }

  const items = await MenuItem.find({
    restaurantId,
    categoryId
  });
  const matches = items.filter((item) => {
    const normalizedItemName = normalizeComparableText(item.name);
    const normalizedWithoutCategory = normalizeComparableText(
      item.name.replace(new RegExp(escapeRegExp(category.name), "ig"), " ")
    );

    return (
      normalizedItemName.includes(normalizedRequestedName) ||
      normalizedRequestedName.includes(normalizedItemName) ||
      normalizedWithoutCategory.includes(normalizedRequestedName) ||
      normalizedRequestedName.includes(normalizedWithoutCategory)
    );
  });

  for (const item of matches) {
    (item as IMenuItemDocument & { categoryName?: string }).categoryName = category.name;
  }

  if (matches.length === 0) {
    return {
      status: "none",
      message: `I couldn't find "${requestedName}" under ${category.name}.`
    };
  }

  if (matches.length > 1) {
    return {
      status: "multiple",
      message: `Please choose one ${category.name} option: ${matches
        .map((item) => item.name)
        .join(", ")}.`,
      matches,
      category: {
        id: String(category._id),
        name: category.name
      }
    };
  }

  const item = matches[0];

  if (!item.isAvailable) {
    return {
      status: "none",
      message: `${item.name} is currently unavailable.`
    };
  }

  return {
    status: "matched",
    item
  };
};

export const getDraftMissingFieldCode = (missingFields: string[]): string => {
  if (missingFields.includes("customerName")) {
    return "CUSTOMER_NAME_REQUIRED";
  }

  if (missingFields.includes("quantity")) {
    return "ORDER_ITEM_QUANTITY_REQUIRED";
  }

  return "ORDER_DRAFT_INCOMPLETE";
};

export const buildDraftView = (
  session: ICustomerSessionDocument,
  restaurant: IRestaurantDocument
) => {
  const orderType = session.orderType;
  const subtotal = getDraftSubtotal(session);
  const deliveryFeeResolution = orderType
    ? orderService.resolveDeliveryFee(restaurant, orderType, session.deliveryAddress, subtotal)
    : null;
  const deliveryFee =
    orderType === "delivery"
      ? session.deliveryFee ?? deliveryFeeResolution?.amount
      : 0;
  const resolvedDeliveryFee = typeof deliveryFee === "number" ? deliveryFee : null;
  const deliveryFeePending =
    orderType === "delivery" &&
    !session.deliveryFeeResolved &&
    (session.deliveryFeeSource ?? deliveryFeeResolution?.source) === "manual_confirmation";
  const missingFields = getMissingDraftFields(session);

  return {
    items: session.cartItems.map((item) => ({
      name: getCartItemDisplayName(item),
      rawName: item.name,
      categoryId: item.categoryId ? String(item.categoryId) : undefined,
      categoryName: item.categoryName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice
    })),
    customerName: session.customerName,
    orderType,
    deliveryAddress: session.deliveryAddress,
    pendingItem: session.pendingMenuItemName
      ? {
          name: session.pendingMenuItemName,
          missing: "quantity"
        }
      : undefined,
    pendingCategory: session.pendingCategoryName
      ? {
          id: session.pendingCategoryId ? String(session.pendingCategoryId) : undefined,
          name: session.pendingCategoryName
        }
      : undefined,
    subtotal,
    deliveryFee: resolvedDeliveryFee,
    deliveryFeePending,
    deliveryFeeLabel: deliveryFeePending ? "To be communicated" : undefined,
    deliveryFeeSource: session.deliveryFeeSource ?? deliveryFeeResolution?.source,
    deliveryFeeResolved:
      orderType === "pickup" ? true : orderType === "delivery" ? session.deliveryFeeResolved : false,
    foodTotal: subtotal,
    total: resolvedDeliveryFee === null ? (deliveryFeePending ? subtotal : null) : subtotal + resolvedDeliveryFee,
    missingFields,
    readyToConfirm: missingFields.length === 0,
    convertedOrderId: session.convertedOrderId ? String(session.convertedOrderId) : undefined
  };
};

export const submitOrderDraft = async (
  restaurant: IRestaurantDocument,
  customerPhone: string
): Promise<{ order: IOrderDocument; idempotent: boolean; draft: ICustomerSessionDocument }> => {
  const restaurantId = String(restaurant._id);
  const draft = await getOrCreateDraft(restaurantId, customerPhone);

  if (draft.convertedOrderId) {
    const existingOrder = await Order.findOne({
      _id: draft.convertedOrderId,
      restaurantId,
      customerPhone: draft.customerPhone
    });

    if (existingOrder) {
      return {
        order: existingOrder,
        idempotent: true,
        draft
      };
    }

    clearConvertedDraftState(draft);
  }

  const missingFields = getMissingDraftFields(draft);

  if (missingFields.length > 0) {
    const error = new BadRequestError(`The order draft is missing: ${missingFields.join(", ")}.`);
    error.code = getDraftMissingFieldCode(missingFields);
    throw error;
  }

  const order = await orderService.createOrder(restaurantId, {
    customerName: draft.customerName,
    customerPhone: draft.customerPhone,
    items: draft.cartItems.map((item) => ({
      menuItemId: String(item.menuItemId),
      quantity: item.quantity
    })),
    orderType: draft.orderType!,
    deliveryAddress: draft.deliveryAddress,
    deliveryFee: draft.deliveryFee,
    deliveryFeeSource: draft.deliveryFeeSource,
    paymentMethod: "unknown",
    paymentStatus: "unpaid",
    sourceDraftId: String(draft._id)
  });

  resetDraftState(draft);
  draft.convertedOrderId = order._id;
  draft.convertedAt = new Date();
  await draft.save();

  return {
    order,
    idempotent: false,
    draft
  };
};

export const buildStateAwareFollowUpMessage = (
  step: ICustomerSessionDocument["currentStep"]
): string | null => {
  switch (step) {
    case "collecting_quantity":
      return "Are you still there? I just need the number of portions you would like.";
    case "choosing_order_type":
      return "Are you still there? Should I prepare the order for pickup or delivery?";
    case "selecting_item_from_category":
      return "Are you still there? Please choose one of the options I listed.";
    case "collecting_address":
      return "Are you still there? Please send the delivery location when you are ready.";
    case "collecting_name":
      return "Are you still there? I just need the name for the order.";
    case "confirming_order":
      return "Your order is ready to be submitted. Would you like me to send it to the restaurant?";
    default:
      return null;
  }
};

export const buildFollowUpKey = (session: ICustomerSessionDocument): string => {
  return `${session.currentStep}:${session.conversationVersion ?? 0}`;
};
