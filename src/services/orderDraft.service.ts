import { CustomerSession, type ICustomerSessionDocument } from "../models/customerSession.model";
import { MenuItem, type IMenuItemDocument } from "../models/MenuItem";
import type { IRestaurantDocument } from "../models/Restaurant";
import * as orderService from "./order.service";

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

export const findMenuItemMatch = async (
  restaurantId: string,
  requestedName: string
): Promise<MenuItemMatchResult> => {
  const normalizedRequestedName = normalizeComparableText(requestedName);
  const items = await MenuItem.find({ restaurantId });
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
  requestedName: string
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

  session.cartItems = session.cartItems.filter(
    (item) => String(item.menuItemId) !== String(matches[0].menuItemId)
  );
  return `${matches[0].name} removed from the draft.`;
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
    readyToConfirm: missingFields.length === 0
  };
};
