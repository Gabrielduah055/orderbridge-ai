import { Types } from "mongoose";
import { CustomerSession, type ICustomerSessionDocument } from "../models/customerSession.model";
import { MenuCategory } from "../models/MenuCategory";
import { MenuItem, type IMenuItemDocument } from "../models/MenuItem";
import { type IOrderDocument, type OrderType } from "../models/order.model";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import * as orderService from "./order.service";
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
  session.currentStep = "idle";
  session.orderType = null;
  session.deliveryAddress = undefined;
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
  const deliveryFee = orderService.calculateDeliveryFee(orderType);
  const total = subtotal + deliveryFee;
  const addressLine =
    orderType === "delivery" && session.deliveryAddress
      ? `\nDelivery address: ${session.deliveryAddress}`
      : "";

  return `${buildCartSummary(session)}\nOrder type: ${orderType}${addressLine}\nDelivery fee: ${formatCurrency(
    deliveryFee
  )}\nTotal: ${formatCurrency(total)}`;
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
): { itemName: string; quantity: number } | null => {
  const normalizedMessage = message.replace(
    /^(?:(?:awesome|great|okay|ok|please|pls|yes|yeah|yh|sure|alright)[,!.]?\s+)+/i,
    ""
  );
  const match = normalizedMessage.match(
    /^(?:i want|i need|i would like|i'd like|add|can i get|give me)\s+(?:(\d+)\s+)?(.+)$/i
  );

  if (!match) {
    return null;
  }

  const quantity = match[1] ? Number(match[1]) : 1;
  const itemName = normalizeText(match[2]);

  if (!Number.isInteger(quantity) || quantity <= 0 || !itemName) {
    return null;
  }

  return {
    itemName,
    quantity
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
    await session.save();
    return buildResponse("Okay, I cancelled your current order.", session);
  }

  if (session.currentStep === "collecting_address") {
    session.deliveryAddress = message;
    session.currentStep = "confirming_order";
    await session.save();
    return buildResponse(
      `${buildOrderSummary(session)}\nReply "yes" to confirm or "cancel" to cancel.`,
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
      paymentMethod: "unknown",
      paymentStatus: "unpaid"
    });

    resetSessionState(session);
    await session.save();

    return buildResponse(
      `Your order has been placed. Order ID: ${String(order._id)}. Total: ${formatCurrency(
        order.total
      )}.`,
      session,
      {
        order
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
      return buildResponse("Please send your delivery address.", session);
    }

    session.currentStep = "confirming_order";
    session.deliveryAddress = undefined;
    await session.save();
    return buildResponse(
      `${buildOrderSummary(session)}\nReply "yes" to confirm or "cancel" to cancel.`,
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
    const match = await findMenuItemMatch(input.restaurantId, addItemRequest.itemName);

    if (match.status !== "matched") {
      return buildResponse(match.message, session);
    }

    addItemToCart(session, match.item, addItemRequest.quantity);
    session.currentStep = "choosing_items";
    await session.save();

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
