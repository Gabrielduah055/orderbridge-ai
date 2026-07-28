import { Types } from "mongoose";
import { CustomerSession, type ICustomerSessionDocument } from "../models/customerSession.model";
import { MenuCategory } from "../models/MenuCategory";
import { MenuItem, type IMenuItemDocument } from "../models/MenuItem";
import { Order, type IOrderDocument, type OrderType } from "../models/order.model";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import * as orderService from "./order.service";
import { parseExplicitQuantity } from "./orderDraft.service";
import { BadRequestError, NotFoundError } from "../utils/httpErrors";
import { normalizeGhanaPhone } from "../utils/phone.util";

interface CustomerMessageInput {
  restaurantId: string;
  customerPhone: string;
  customerName?: string;
  message: string;
}

interface CustomerAgentResponse {
  success: boolean;
  message: string;
  data?: {
    session?: ICustomerSessionDocument;
    cart?: ICustomerSessionDocument["cartItems"];
    menu?: unknown;
    order?: IOrderDocument;
    orderEvent?: "submitted" | "confirmed" | "rejected";
    notifyOwner?: boolean;
    notifyCustomer?: boolean;
    receiptRequired?: boolean;
  };
}

type MenuItemMatchResult =
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

const sessionTtlMs = 2 * 60 * 60 * 1000;
const pickupAliases = ["pickup", "takeaway"];
const deliveryAliases = ["delivery"];
const confirmationAliases = ["yes", "confirm", "place order"];
const cancellationAliases = ["cancel", "stop"];

const ensureValidObjectId = (id: string, fieldName: string): void => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError(`Invalid ${fieldName}`);
  }
};

const normalizeText = (value: string): string => {
  return value.trim().replace(/\s+/g, " ");
};

const normalizeComparableText = (value: string): string => {
  return normalizeText(value).toLowerCase();
};

const getRestaurantOrThrow = async (restaurantId: string): Promise<IRestaurantDocument> => {
  ensureValidObjectId(restaurantId, "restaurantId");
  const restaurant = await Restaurant.findById(restaurantId);

  if (!restaurant) {
    throw new NotFoundError("Restaurant not found");
  }

  return restaurant;
};

const getSessionExpiry = (): Date => {
  return new Date(Date.now() + sessionTtlMs);
};

const resetSessionState = (session: ICustomerSessionDocument): void => {
  session.cartItems = [];
  session.pendingMenuItemId = undefined;
  session.pendingMenuItemName = undefined;
  session.currentStep = "idle";
  session.orderType = null;
  session.deliveryAddress = undefined;
  session.deliveryFee = undefined;
  session.deliveryFeeSource = undefined;
  session.deliveryFeeResolved = false;
};

const getOrCreateSession = async (
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
      expiresAt: getSessionExpiry()
    });
  }

  if (session.expiresAt <= new Date()) {
    resetSessionState(session);
  }

  if (customerName) {
    session.customerName = customerName;
  }

  session.expiresAt = getSessionExpiry();
  return session.save();
};

const touchSession = async (
  session: ICustomerSessionDocument,
  message: string
): Promise<ICustomerSessionDocument> => {
  session.lastMessage = message;
  session.expiresAt = getSessionExpiry();
  return session.save();
};

const getMenuForRestaurant = async (restaurantId: string) => {
  const categories = await MenuCategory.find({
    restaurantId,
    isActive: true
  }).sort({ sortOrder: 1, createdAt: 1 });
  const items = await MenuItem.find({
    restaurantId,
    isAvailable: true
  }).sort({ createdAt: -1 });

  return categories.map((category) => ({
    id: category._id,
    name: category.name,
    items: items
      .filter((item) => String(item.categoryId) === String(category._id))
      .map((item) => ({
        id: item._id,
        name: item.name,
        description: item.description,
        price: item.price
      }))
  }));
};

const formatCurrency = (value: number): string => {
  return `GHS ${value}`;
};

const getCartSubtotal = (session: ICustomerSessionDocument): number => {
  return session.cartItems.reduce((sum, item) => sum + item.totalPrice, 0);
};

const buildCartSummary = (session: ICustomerSessionDocument): string => {
  if (session.cartItems.length === 0) {
    return "Your cart is empty.";
  }

  const lines = session.cartItems.map(
    (item) => `${item.quantity} x ${item.name} - ${formatCurrency(item.totalPrice)}`
  );

  return `${lines.join("\n")}\nSubtotal: ${formatCurrency(getCartSubtotal(session))}`;
};

const buildOrderSummary = (session: ICustomerSessionDocument): string => {
  const orderType = session.orderType ?? "pickup";
  const subtotal = getCartSubtotal(session);
  const deliveryFeePending =
    orderType === "delivery" && !session.deliveryFeeResolved && session.deliveryFeeSource === "manual_confirmation";
  const deliveryFee = orderType === "delivery" ? session.deliveryFee ?? 0 : 0;
  const total = deliveryFeePending ? subtotal : subtotal + deliveryFee;
  const addressLine =
    orderType === "delivery" && session.deliveryAddress
      ? `\nDelivery address: ${session.deliveryAddress}`
      : "";

  const deliveryLine =
    orderType === "delivery"
      ? deliveryFeePending
        ? "\nDelivery fee: To be communicated"
        : `\nDelivery fee: ${formatCurrency(deliveryFee)}`
      : "";

  return `${buildCartSummary(session)}\nOrder type: ${orderType}${addressLine}${deliveryLine}\n${
    deliveryFeePending ? "Food total" : "Total"
  }: ${formatCurrency(total)}`;
};

const isGreetingMessage = (message: string): boolean => {
  return /^(hi|hello|hey|good morning|good afternoon|good evening|start)\b/.test(message);
};

const isShowMenuMessage = (message: string): boolean => {
  return ["show menu", "menu", "what do you have"].includes(message);
};

const isShowCartMessage = (message: string): boolean => {
  return ["cart", "show cart", "my order"].includes(message);
};

const isCheckoutMessage = (message: string): boolean => {
  return ["checkout", "confirm order", "done"].includes(message);
};

const getRequestedOrderType = (message: string): OrderType | null => {
  if (pickupAliases.includes(message)) {
    return "pickup";
  }

  if (deliveryAliases.includes(message)) {
    return "delivery";
  }

  return null;
};

const parseAddItemMessage = (
  message: string
): { itemName: string; quantity: number | null; orderType?: OrderType; deliveryAddress?: string } | null => {
  const normalizedMessage = message.replace(
    /^(?:(?:awesome|great|okay|ok|please|pls|yes|yeah|yh|sure|alright)[,!.]?\s+)+/i,
    ""
  );
  const deliveryMatch = normalizedMessage.match(
    /^(?:please\s+)?deliver\s+(.+?)\s+to\s+(.+)$/i
  );
  const match =
    deliveryMatch ??
    normalizedMessage.match(
      /^(?:i want|i need|i would like|i'd like|add|can i get|give me|make it)\s+(.+)$/i
    );

  if (!match) {
    return null;
  }

  const quantity = parseExplicitQuantity(message);
  const rawItemName = deliveryMatch ? match[1] : match[1];
  const itemName = normalizeText(
    rawItemName
      .replace(/^\d+\s+/, "")
      .replace(/^(one|two|three|four|five|six|seven|eight|nine|ten)\s+/i, "")
      .replace(/^(a|an)\s+(plate|pack|portion|bowl|serving|box)\s+of\s+/i, "")
      .replace(/^(plate|pack|packs|plates|portions|bowls|servings|boxes)\s+of\s+/i, "")
      .replace(/^(plate|pack|packs|plates|portions|bowls|servings|boxes)\s+/i, "")
  );

  if (!itemName) {
    return null;
  }

  return {
    itemName,
    quantity,
    orderType: deliveryMatch ? "delivery" : undefined,
    deliveryAddress: deliveryMatch ? normalizeText(match[2]) : undefined
  };
};

const parseRemoveItemMessage = (message: string): string | null => {
  const match = message.match(/^remove\s+(.+)$/i);

  return match ? normalizeText(match[1]) : null;
};

const findMenuItemMatch = async (
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
      message: `I couldn't find "${requestedName}" on the menu. You can reply "show menu" to see available items.`
    };
  }

  if (matches.length > 1) {
    return {
      status: "multiple",
      message: `I found multiple items matching "${requestedName}". Please be more specific: ${matches
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

const addItemToCart = (
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

const clearPendingItem = (session: ICustomerSessionDocument): void => {
  session.pendingMenuItemId = undefined;
  session.pendingMenuItemName = undefined;
};

const removeItemFromCart = (
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
    return `I couldn't find "${requestedName}" in your cart.`;
  }

  if (matches.length > 1) {
    return `I found multiple cart items matching "${requestedName}". Please be more specific: ${matches
      .map((item) => item.name)
      .join(", ")}.`;
  }

  session.cartItems = session.cartItems.filter(
    (item) => String(item.menuItemId) !== String(matches[0].menuItemId)
  );
  return `${matches[0].name} has been removed from your cart.\n${buildCartSummary(session)}`;
};

const buildResponse = (
  message: string,
  session: ICustomerSessionDocument,
  extraData: CustomerAgentResponse["data"] = {}
): CustomerAgentResponse => {
  return {
    success: true,
    message,
    data: {
      session,
      cart: session.cartItems,
      ...extraData
    }
  };
};

export const handleCustomerMessage = async (
  input: CustomerMessageInput
): Promise<CustomerAgentResponse> => {
  const restaurant = await getRestaurantOrThrow(input.restaurantId);
  const customerPhone = normalizeGhanaPhone(input.customerPhone);
  const message = normalizeText(input.message);
  const normalizedMessage = normalizeComparableText(message);
  const session = await getOrCreateSession(
    input.restaurantId,
    customerPhone,
    input.customerName
  );

  await touchSession(session, message);

  if (cancellationAliases.includes(normalizedMessage)) {
    resetSessionState(session);
    session.convertedOrderId = undefined;
    session.convertedAt = undefined;
    await session.save();
    return buildResponse("Okay, I cancelled your current order.", session);
  }

  if (session.currentStep === "collecting_quantity" && session.pendingMenuItemId) {
    const quantity = parseExplicitQuantity(message);

    if (!quantity) {
      return buildResponse(
        `I still need the number of portions, please. Would you like 1, 2, or more?`,
        session
      );
    }

    const item = await MenuItem.findOne({
      _id: session.pendingMenuItemId,
      restaurantId: input.restaurantId,
      isAvailable: true
    });

    if (!item) {
      clearPendingItem(session);
      session.currentStep = "choosing_items";
      await session.save();
      return buildResponse("That item is no longer available. Please choose another item.", session);
    }

    addItemToCart(session, item, quantity);
    clearPendingItem(session);
    session.currentStep = "choosing_items";
    await session.save();

    return buildResponse(
      `${quantity} x ${item.name} added.\n${buildCartSummary(
        session
      )}\nWould you like anything else? Reply "checkout" when you're done.`,
      session
    );
  }

  if (session.currentStep === "collecting_name") {
    session.customerName = message;
    session.currentStep = "confirming_order";
    await session.save();

    return buildResponse(
      `Thank you, ${message}. Please review your order:\n${buildOrderSummary(
        session
      )}\nShould I send this to the restaurant?`,
      session
    );
  }

  if (confirmationAliases.includes(normalizedMessage) && session.convertedOrderId) {
    const existingOrder = await Order.findOne({
      _id: session.convertedOrderId,
      restaurantId: input.restaurantId,
      customerPhone: session.customerPhone
    });

    if (existingOrder) {
      return buildResponse(
        `Your order has already been submitted to the restaurant for confirmation. Order: ${
          existingOrder.orderNumber ?? String(existingOrder._id)
        }.`,
        session,
        {
          order: existingOrder,
          orderEvent: "submitted",
          notifyOwner: true,
          receiptRequired: false
        }
      );
    }
  }

  if (session.currentStep === "collecting_address") {
    session.deliveryAddress = message;
    const fee = orderService.resolveDeliveryFee(
      restaurant,
      "delivery",
      session.deliveryAddress,
      getCartSubtotal(session)
    );

    session.deliveryFee = fee.amount ?? undefined;
    session.deliveryFeeSource = fee.source;
    session.deliveryFeeResolved = fee.resolved;

    if (!fee.resolved && fee.source !== "manual_confirmation") {
      session.currentStep = "awaiting_delivery_fee";
      await session.save();

      return buildResponse(
        `Let me confirm the delivery fee for ${session.deliveryAddress} before completing your order.`,
        session
      );
    }

    if (!session.customerName?.trim()) {
      session.currentStep = "collecting_name";
      await session.save();
      return buildResponse("Before I submit your order, may I have your name please?", session);
    }

    session.currentStep = "confirming_order";
    await session.save();
    return buildResponse(
      `${buildOrderSummary(session)}\nShould I send this to the restaurant?`,
      session
    );
  }

  if (session.currentStep === "confirming_order" && confirmationAliases.includes(normalizedMessage)) {
    const order = await orderService.createOrder(input.restaurantId, {
      customerName: session.customerName,
      customerPhone: session.customerPhone,
      items: session.cartItems.map((item) => ({
        menuItemId: String(item.menuItemId),
        quantity: item.quantity
      })),
      orderType: session.orderType ?? "pickup",
      deliveryAddress: session.deliveryAddress,
      deliveryFee: session.deliveryFee,
      deliveryFeeSource: session.deliveryFeeSource,
      paymentMethod: "unknown",
      paymentStatus: "unpaid",
      sourceDraftId: String(session._id)
    });

    resetSessionState(session);
    session.convertedOrderId = order._id;
    session.convertedAt = new Date();
    await session.save();

    return buildResponse(
      `Thank you${session.customerName ? `, ${session.customerName}` : ""}. Your order has been sent to the restaurant for confirmation. I'll update you once they accept it. Order: ${
        order.orderNumber ?? String(order._id)
      }. Total: ${formatCurrency(
        order.total
      )}.`,
      session,
      {
        order,
        orderEvent: "submitted",
        notifyOwner: true,
        receiptRequired: false
      }
    );
  }

  if (session.currentStep === "choosing_order_type") {
    const requestedOrderType = getRequestedOrderType(normalizedMessage);

    if (!requestedOrderType) {
      return buildResponse("Please reply with pickup or delivery.", session);
    }

    if (requestedOrderType === "delivery" && !restaurant.deliveryEnabled) {
      return buildResponse("Delivery is not available right now. Pickup is available.", session);
    }

    session.orderType = requestedOrderType;

    if (requestedOrderType === "delivery") {
      session.currentStep = "collecting_address";
      await session.save();
      return buildResponse("Where should we deliver it?", session);
    }

    session.currentStep = "confirming_order";
    session.deliveryAddress = undefined;
    session.deliveryFee = 0;
    session.deliveryFeeSource = "pickup";
    session.deliveryFeeResolved = true;

    if (!session.customerName?.trim()) {
      session.currentStep = "collecting_name";
      await session.save();
      return buildResponse("Before I submit your order, may I have your name please?", session);
    }

    await session.save();
    return buildResponse(
      `${buildOrderSummary(session)}\nShould I send this to the restaurant?`,
      session
    );
  }

  if (isGreetingMessage(normalizedMessage)) {
    return buildResponse(
      `Welcome to ${restaurant.name}. You can reply "show menu" to see our menu or tell me what you want to order.`,
      session
    );
  }

  if (isShowMenuMessage(normalizedMessage)) {
    const menu = await getMenuForRestaurant(input.restaurantId);
    return buildResponse("Here is the menu.", session, { menu });
  }

  if (isShowCartMessage(normalizedMessage)) {
    return buildResponse(buildCartSummary(session), session);
  }

  const removeItemName = parseRemoveItemMessage(message);

  if (removeItemName) {
    const responseMessage = removeItemFromCart(session, removeItemName);
    await session.save();
    return buildResponse(responseMessage, session);
  }

  if (isCheckoutMessage(normalizedMessage)) {
    if (session.cartItems.length === 0) {
      return buildResponse("Your cart is empty. Please add items before checkout.", session);
    }

    session.currentStep = "choosing_order_type";
    await session.save();
    return buildResponse(`${buildCartSummary(session)}\nIs this for pickup or delivery?`, session);
  }

  const addItemRequest = parseAddItemMessage(message);

  if (addItemRequest) {
    session.convertedOrderId = undefined;
    session.convertedAt = undefined;
    const match = await findMenuItemMatch(input.restaurantId, addItemRequest.itemName);

    if (match.status !== "matched") {
      return buildResponse(match.message, session);
    }

    if (!addItemRequest.quantity) {
      session.pendingMenuItemId = match.item._id;
      session.pendingMenuItemName = match.item.name;
      session.currentStep = "collecting_quantity";
      await session.save();

      return buildResponse(`Sure. How many portions of ${match.item.name} would you like?`, session);
    }

    addItemToCart(session, match.item, addItemRequest.quantity);
    clearPendingItem(session);
    session.currentStep = "choosing_items";

    if (addItemRequest.orderType === "delivery") {
      session.orderType = "delivery";
      session.deliveryAddress = addItemRequest.deliveryAddress;
      const fee = orderService.resolveDeliveryFee(
        restaurant,
        "delivery",
        session.deliveryAddress,
        getCartSubtotal(session)
      );
      session.deliveryFee = fee.amount ?? undefined;
      session.deliveryFeeSource = fee.source;
      session.deliveryFeeResolved = fee.resolved;
      session.currentStep = fee.resolved || fee.source === "manual_confirmation" ? "choosing_items" : "awaiting_delivery_fee";
    }

    await session.save();

    if (addItemRequest.orderType === "delivery" && !session.deliveryFeeResolved && session.deliveryFeeSource !== "manual_confirmation") {
      return buildResponse(
        `Added ${addItemRequest.quantity} x ${match.item.name}. Let me confirm the delivery fee for ${session.deliveryAddress} before completing your order.`,
        session
      );
    }

    return buildResponse(
      `${addItemRequest.quantity} x ${match.item.name} added to your cart.\n${buildCartSummary(
        session
      )}\nWould you like anything else? Reply "checkout" when you're done.`,
      session
    );
  }

  return buildResponse(
    'I can help with menu and orders. Try "show menu", "add jollof rice", "cart", or "checkout".',
    session
  );
};
