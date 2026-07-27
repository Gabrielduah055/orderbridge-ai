import { CustomerSession, type ICustomerSessionDocument } from "../models/customerSession.model";
import { Order, type IOrderDocument } from "../models/order.model";
import { MenuCategory } from "../models/MenuCategory";
import { MenuItem, type IMenuItemDocument } from "../models/MenuItem";
import type { IRestaurantDocument } from "../models/Restaurant";
import * as orderService from "./order.service";
import { BadRequestError } from "../utils/httpErrors";

const sessionTtlMs = 2 * 60 * 60 * 1000;

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");
const normalizeComparableText = (value: string): string => normalizeText(value).toLowerCase();

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
    };

export const getDraftExpiry = (): Date => new Date(Date.now() + sessionTtlMs);

export const resetDraftState = (session: ICustomerSessionDocument): void => {
  session.cartItems = [];
  session.currentStep = "idle";
  session.orderType = null;
  session.deliveryAddress = undefined;
};

export const clearConvertedDraftState = (session: ICustomerSessionDocument): void => {
  session.convertedOrderId = undefined;
  session.convertedAt = undefined;
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
  }).select("_id");
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

  if (matches.length === 0) {
    return {
      status: "none",
      message: `I couldn't find "${requestedName}" on the menu. Try calling get_menu to see available items.`
    };
  }

  if (matches.length > 1) {
    return {
      status: "multiple",
      message: `Multiple items matched "${requestedName}". Ask the customer to be more specific: ${matches
        .map((item) => item.name)
        .join(", ")}.`,
      matches
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

export const addItemToDraft = (
  session: ICustomerSessionDocument,
  item: IMenuItemDocument,
  quantity: number
): void => {
  clearConvertedDraftState(session);

  const existingItem = session.cartItems.find(
    (cartItem) => String(cartItem.menuItemId) === String(item._id)
  );

  if (existingItem) {
    existingItem.quantity += quantity;
    existingItem.totalPrice = existingItem.quantity * existingItem.unitPrice;
    return;
  }

  session.cartItems.push({
    menuItemId: item._id,
    name: item.name,
    quantity,
    unitPrice: item.price,
    totalPrice: item.price * quantity
  });
};

export const removeItemFromDraft = (
  session: ICustomerSessionDocument,
  requestedName: string,
  quantity?: number
): string => {
  const normalizedRequestedName = normalizeComparableText(requestedName);
  const matches = session.cartItems.filter((item) => {
    const normalizedItemName = normalizeComparableText(item.name);

    return (
      normalizedItemName.includes(normalizedRequestedName) ||
      normalizedRequestedName.includes(normalizedItemName)
    );
  });

  if (matches.length === 0) {
    return `I couldn't find "${requestedName}" in the draft.`;
  }

  if (matches.length > 1) {
    return `Multiple draft items matched "${requestedName}". Ask the customer to be more specific: ${matches
      .map((item) => item.name)
      .join(", ")}.`;
  }

  const matchedItem = matches[0];
  const removeQuantity = quantity ?? matchedItem.quantity;

  if (!Number.isInteger(removeQuantity) || removeQuantity <= 0) {
    return "Please provide a positive quantity to remove.";
  }

  if (removeQuantity >= matchedItem.quantity) {
    session.cartItems = session.cartItems.filter(
      (item) => String(item.menuItemId) !== String(matchedItem.menuItemId)
    );
    return `${matchedItem.name} removed from the draft.`;
  }

  matchedItem.quantity -= removeQuantity;
  matchedItem.totalPrice = matchedItem.quantity * matchedItem.unitPrice;

  return `Removed ${removeQuantity} x ${matchedItem.name} from the draft.`;
};

export const getDraftSubtotal = (session: ICustomerSessionDocument): number => {
  return session.cartItems.reduce((sum, item) => sum + item.totalPrice, 0);
};

export const getMissingDraftFields = (session: ICustomerSessionDocument): string[] => {
  const missing: string[] = [];

  if (session.cartItems.length === 0) {
    missing.push("items");
  }

  if (!session.orderType) {
    missing.push("orderType");
  }

  if (session.orderType === "delivery" && !session.deliveryAddress?.trim()) {
    missing.push("deliveryAddress");
  }

  if (!session.customerName?.trim()) {
    missing.push("customerName");
  }

  return missing;
};

export const buildDraftView = (
  session: ICustomerSessionDocument,
  _restaurant: IRestaurantDocument
) => {
  const orderType = session.orderType;
  const subtotal = getDraftSubtotal(session);
  const deliveryFee = orderType ? orderService.calculateDeliveryFee(orderType) : 0;
  const missingFields = getMissingDraftFields(session);

  return {
    items: session.cartItems.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice
    })),
    customerName: session.customerName,
    orderType,
    deliveryAddress: session.deliveryAddress,
    subtotal,
    deliveryFee,
    total: subtotal + deliveryFee,
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
    throw new BadRequestError(`The order draft is missing: ${missingFields.join(", ")}.`);
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
