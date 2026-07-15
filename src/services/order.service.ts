import { Types } from "mongoose";
import { MenuItem, type IMenuItemDocument } from "../models/MenuItem";
import {
  Order,
  type IOrderDocument,
  type IOrderItem,
  type OrderStatus,
  type OrderType,
  type PaymentMethod,
  type PaymentStatus
} from "../models/order.model";
import { Restaurant } from "../models/Restaurant";
import { BadRequestError, NotFoundError } from "../utils/httpErrors";
import { generateOrderReceipt } from "./receipt.service";
import { sendTextMessage } from "./wasender.service";

interface CreateOrderItemInput {
  menuItemId: string;
  quantity: number;
}

export interface CreateOrderInput {
  customerName?: string;
  customerPhone: string;
  items: CreateOrderItemInput[];
  orderType: OrderType;
  deliveryAddress?: string;
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  notes?: string;
}

export interface UpdateOrderStatusResult {
  order: IOrderDocument;
  warning?: string;
}

const ensureValidObjectId = (id: string, fieldName: string): void => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError(`Invalid ${fieldName}`);
  }
};

const ensurePositiveQuantity = (quantity: number): void => {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new BadRequestError("Quantity must be positive");
  }
};

const getRestaurantOrThrow = async (restaurantId: string) => {
  ensureValidObjectId(restaurantId, "restaurantId");
  const restaurant = await Restaurant.findById(restaurantId).select("+wasenderApiToken");

  if (!restaurant) {
    throw new NotFoundError("Restaurant not found");
  }

  return restaurant;
};

const formatCurrency = (value: number): string => {
  return `GHS ${value.toFixed(2)}`;
};

export const buildOwnerOrderNotification = (order: IOrderDocument): string => {
  const items = order.items
    .map((item) => `- ${item.quantity} x ${item.name} (${formatCurrency(item.totalPrice)})`)
    .join("\n");
  const deliveryAddress =
    order.orderType === "delivery" && order.deliveryAddress
      ? `\nDelivery address: ${order.deliveryAddress}`
      : "";

  return [
    "New customer order confirmed",
    `Order: ${order.orderNumber ?? String(order._id)}`,
    `Customer: ${order.customerName || "Guest"} (${order.customerPhone})`,
    `Type: ${order.orderType}`,
    "Items:",
    items,
    `Total: ${formatCurrency(order.total)}`,
    deliveryAddress
  ]
    .filter(Boolean)
    .join("\n");
};

const notifyOwnerOfNewOrder = async (
  restaurant: Awaited<ReturnType<typeof getRestaurantOrThrow>>,
  order: IOrderDocument
): Promise<void> => {
  if (!restaurant.ownerPhone) {
    return;
  }

  const result = await sendTextMessage(
    restaurant.wasenderSessionId,
    restaurant.ownerPhone,
    buildOwnerOrderNotification(order),
    {
      apiKey: restaurant.wasenderApiToken
    }
  );

  if (!result.success) {
    console.error("Owner order notification failed", {
      restaurantId: String(restaurant._id),
      orderId: String(order._id),
      status: result.status,
      error: result.error,
      data: result.data
    });
  }
};

const getOrderOrThrow = async (orderId: string): Promise<IOrderDocument> => {
  ensureValidObjectId(orderId, "orderId");
  const order = await Order.findById(orderId);

  if (!order) {
    throw new NotFoundError("Order not found");
  }

  return order;
};

const normalizeOrderItems = (items: CreateOrderItemInput[]): CreateOrderItemInput[] => {
  const quantityByItemId = new Map<string, number>();

  for (const item of items) {
    ensureValidObjectId(item.menuItemId, "menuItemId");
    ensurePositiveQuantity(item.quantity);

    const normalizedItemId = String(new Types.ObjectId(item.menuItemId));
    quantityByItemId.set(
      normalizedItemId,
      (quantityByItemId.get(normalizedItemId) ?? 0) + item.quantity
    );
  }

  return Array.from(quantityByItemId.entries()).map(([menuItemId, quantity]) => ({
    menuItemId,
    quantity
  }));
};

const getMenuItemsForOrder = async (
  restaurantId: string,
  items: CreateOrderItemInput[]
): Promise<Map<string, IMenuItemDocument>> => {
  const menuItemIds = items.map((item) => item.menuItemId);
  const menuItems = await MenuItem.find({
    _id: {
      $in: menuItemIds
    },
    restaurantId
  });

  if (menuItems.length !== menuItemIds.length) {
    throw new BadRequestError("All menu items must exist and belong to this restaurant");
  }

  const menuItemById = new Map(menuItems.map((item) => [String(item._id), item]));

  for (const item of menuItems) {
    if (!item.isAvailable) {
      throw new BadRequestError(`${item.name} is currently unavailable`);
    }
  }

  return menuItemById;
};

export const calculateDeliveryFee = (orderType: OrderType): number => {
  return orderType === "delivery" ? 10 : 0;
};

export const buildOrderItems = async (
  restaurantId: string,
  inputItems: CreateOrderItemInput[]
): Promise<IOrderItem[]> => {
  if (inputItems.length === 0) {
    throw new BadRequestError("Order must include at least one item");
  }

  const normalizedItems = normalizeOrderItems(inputItems);
  const menuItemById = await getMenuItemsForOrder(restaurantId, normalizedItems);

  return normalizedItems.map((item) => {
    const menuItem = menuItemById.get(item.menuItemId);

    if (!menuItem) {
      throw new BadRequestError("Menu item could not be matched");
    }

    return {
      menuItemId: menuItem._id,
      name: menuItem.name,
      quantity: item.quantity,
      unitPrice: menuItem.price,
      totalPrice: menuItem.price * item.quantity
    };
  });
};

export const createOrder = async (
  restaurantId: string,
  input: CreateOrderInput
): Promise<IOrderDocument> => {
  const restaurant = await getRestaurantOrThrow(restaurantId);

  if (input.orderType === "delivery") {
    if (!restaurant.deliveryEnabled) {
      throw new BadRequestError("Delivery is not enabled for this restaurant");
    }

    if (!input.deliveryAddress?.trim()) {
      throw new BadRequestError("Delivery address is required for delivery orders");
    }
  }

  const items = await buildOrderItems(restaurantId, input.items);
  const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
  const deliveryFee = calculateDeliveryFee(input.orderType);
  const total = subtotal + deliveryFee;

  const order = await Order.create({
    restaurantId,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    items,
    subtotal,
    deliveryFee,
    total,
    orderType: input.orderType,
    deliveryAddress: input.orderType === "delivery" ? input.deliveryAddress : undefined,
    status: "pending",
    paymentMethod: input.paymentMethod ?? "unknown",
    paymentStatus: input.paymentStatus ?? "unpaid",
    notes: input.notes
  });

  await notifyOwnerOfNewOrder(restaurant, order);

  return order;
};

export const getOrdersByRestaurant = async (
  restaurantId: string
): Promise<IOrderDocument[]> => {
  await getRestaurantOrThrow(restaurantId);

  return Order.find({ restaurantId }).sort({ createdAt: -1 });
};

export const getOrderById = async (orderId: string): Promise<IOrderDocument> => {
  return getOrderOrThrow(orderId);
};

export const updateOrderStatus = async (
  orderId: string,
  status: OrderStatus
): Promise<UpdateOrderStatusResult> => {
  const order = await getOrderOrThrow(orderId);
  order.status = status;
  await order.save();

  if (status !== "confirmed" || order.receiptUrl) {
    return {
      order
    };
  }

  try {
    const receipt = await generateOrderReceipt(orderId);

    return {
      order: receipt.order
    };
  } catch (error) {
    console.error("Receipt generation failed after order confirmation", error);

    return {
      order,
      warning: "Order was confirmed, but receipt generation failed."
    };
  }
};
