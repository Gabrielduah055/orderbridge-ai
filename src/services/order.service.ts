import { Types } from "mongoose";
import { MenuCategory } from "../models/MenuCategory";
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
import type { IRestaurantDocument } from "../models/Restaurant";
import { BadRequestError, NotFoundError } from "../utils/httpErrors";
import { normalizeGhanaPhone } from "../utils/phone.util";
import {
  cancelQueuedOrderFeedbackMessages
} from "./orderCompletion.service";
import { updateCustomerProfileFromCompletedOrder } from "./customerProfile.service";

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
  deliveryFee?: number;
  deliveryFeeSource?: string;
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  notes?: string;
  sourceDraftId?: string;
}

export interface UpdateOrderStatusResult {
  order: IOrderDocument;
  warning?: string;
}

export interface RestaurantOrderDecisionResult {
  order: IOrderDocument;
  idempotent: boolean;
}

export interface DeliveryFeeResolution {
  amount: number | null;
  source: "pickup" | "flat_fee" | "free_delivery_threshold" | "zone" | "manual_confirmation" | "not_configured";
  resolved: boolean;
  zoneName?: string;
}

export const getPendingOrderExpiryMinutes = (): number => {
  const configured = Number(process.env.PENDING_ORDER_EXPIRY_MINUTES);

  return Number.isFinite(configured) && configured > 0 ? configured : 60;
};

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

export const formatGhanaCedi = (value: number): string => {
  return `GHS ${value.toFixed(2)}`;
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

const normalizeComparableText = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();
const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

const getDisplayOrderItemName = (item: IMenuItemDocument, categoryName?: string): string => {
  const itemName = normalizeText(item.name);
  const normalizedItemName = normalizeComparableText(itemName);
  const normalizedCategoryName = categoryName ? normalizeComparableText(categoryName) : "";

  if (!normalizedCategoryName || normalizedItemName.includes(normalizedCategoryName)) {
    return itemName;
  }

  return `${itemName} ${normalizeText(categoryName!)}`;
};

export const resolveDeliveryFee = (
  restaurant: Pick<IRestaurantDocument, "deliveryPricing">,
  orderType: OrderType,
  deliveryAddress?: string,
  subtotal = 0
): DeliveryFeeResolution => {
  if (orderType === "pickup") {
    return {
      amount: 0,
      source: "pickup",
      resolved: true
    };
  }

  const pricing = restaurant.deliveryPricing;

  if (!pricing) {
    return {
      amount: null,
      source: "not_configured",
      resolved: false
    };
  }

  if (
    pricing.freeDeliveryThreshold !== undefined &&
    subtotal >= pricing.freeDeliveryThreshold
  ) {
    return {
      amount: 0,
      source: "free_delivery_threshold",
      resolved: true
    };
  }

  if (pricing.type === "flat" && typeof pricing.flatFee === "number") {
    return {
      amount: pricing.flatFee,
      source: "flat_fee",
      resolved: true
    };
  }

  if (pricing.type === "zone_based" && deliveryAddress?.trim()) {
    const normalizedAddress = normalizeComparableText(deliveryAddress);
    const zone = pricing.zones?.find((candidate) => {
      const names = [candidate.name, ...(candidate.aliases ?? [])].map(normalizeComparableText);

      return names.some((name) => normalizedAddress.includes(name));
    });

    if (zone) {
      return {
        amount: zone.fee,
        source: "zone",
        resolved: true,
        zoneName: zone.name
      };
    }
  }

  return {
    amount: null,
    source: pricing.type === "manual_confirmation" ? "manual_confirmation" : "not_configured",
    resolved: false
  };
};

export const calculateDeliveryFee = (orderType: OrderType): number => {
  return orderType === "delivery" ? 0 : 0;
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
  const categoryIds = Array.from(
    new Set(
      Array.from(menuItemById.values())
        .map((item) => String(item.categoryId))
        .filter(Boolean)
    )
  );
  const categories = await MenuCategory.find({
    _id: {
      $in: categoryIds
    },
    restaurantId
  });
  const categoryNameById = new Map(categories.map((category) => [String(category._id), category.name]));

  return normalizedItems.map((item) => {
    const menuItem = menuItemById.get(item.menuItemId);

    if (!menuItem) {
      throw new BadRequestError("Menu item could not be matched");
    }

    return {
      menuItemId: menuItem._id,
      name: getDisplayOrderItemName(menuItem, categoryNameById.get(String(menuItem.categoryId))),
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
  const customerName = input.customerName?.trim();

  if (!customerName) {
    throw new BadRequestError("Customer name is required before submitting the order", "CUSTOMER_NAME_REQUIRED");
  }

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
  const deliveryFeeResolution =
    input.orderType === "delivery"
      ? resolveDeliveryFee(restaurant, input.orderType, input.deliveryAddress, subtotal)
      : resolveDeliveryFee(restaurant, input.orderType, undefined, subtotal);

  const deliveryFeePending =
    input.orderType === "delivery" &&
    !deliveryFeeResolution.resolved &&
    deliveryFeeResolution.source === "manual_confirmation";

  if (
    !deliveryFeePending &&
    (!deliveryFeeResolution.resolved || deliveryFeeResolution.amount === null)
  ) {
    throw new BadRequestError("Delivery fee is not resolved for this order");
  }

  const resolvedDeliveryFee = input.deliveryFee ?? deliveryFeeResolution.amount ?? 0;
  const deliveryFee = deliveryFeePending ? null : resolvedDeliveryFee;
  const total = deliveryFeePending ? subtotal : subtotal + resolvedDeliveryFee;

  try {
    return await Order.create({
      restaurantId,
      customerName,
      customerPhone: input.customerPhone,
      items,
      subtotal,
      deliveryFee,
      deliveryFeeSource: input.deliveryFeeSource ?? deliveryFeeResolution.source,
      deliveryFeePending,
      deliveryFeeResolvedAt: deliveryFeePending ? undefined : new Date(),
      total,
      orderType: input.orderType,
      deliveryAddress: input.orderType === "delivery" ? input.deliveryAddress : undefined,
      status: "awaiting_restaurant_confirmation",
      paymentMethod: input.paymentMethod ?? "unknown",
      paymentStatus: input.paymentStatus ?? "unpaid",
      notes: input.notes,
      sourceDraftId: input.sourceDraftId,
      customerConfirmedAt: new Date()
    });
  } catch (error) {
    if (
      input.sourceDraftId &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    ) {
      const existingOrder = await Order.findOne({
        restaurantId,
        sourceDraftId: input.sourceDraftId
      });

      if (existingOrder) {
        return existingOrder;
      }
    }

    throw error;
  }
};

export const getOrderAgeMs = (order: Pick<IOrderDocument, "customerConfirmedAt" | "createdAt">): number => {
  return Date.now() - (order.customerConfirmedAt ?? order.createdAt).getTime();
};

export const isPendingOrderActionable = (
  order: Pick<IOrderDocument, "status" | "customerConfirmedAt" | "createdAt">,
  now = new Date(),
  expiryMinutes = getPendingOrderExpiryMinutes()
): boolean => {
  if (order.status !== "awaiting_restaurant_confirmation" && order.status !== "pending") {
    return false;
  }

  const ageMs = now.getTime() - (order.customerConfirmedAt ?? order.createdAt).getTime();

  return ageMs <= expiryMinutes * 60 * 1000;
};

export const formatRelativeOrderAge = (
  order: Pick<IOrderDocument, "customerConfirmedAt" | "createdAt">,
  now = new Date()
): string => {
  const ageMs = Math.max(0, now.getTime() - (order.customerConfirmedAt ?? order.createdAt).getTime());
  const minutes = Math.floor(ageMs / 60_000);

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }

  if (hours < 48) {
    return "yesterday";
  }

  const days = Math.floor(hours / 24);

  return `${days} days ago`;
};

export const expireOldPendingOrders = async (
  restaurantId?: string,
  now = new Date(),
  expiryMinutes = getPendingOrderExpiryMinutes()
): Promise<number> => {
  const cutoff = new Date(now.getTime() - expiryMinutes * 60 * 1000);
  const result = await Order.updateMany(
    {
      ...(restaurantId ? { restaurantId } : {}),
      status: { $in: ["awaiting_restaurant_confirmation", "pending"] },
      $or: [
        { customerConfirmedAt: { $lte: cutoff } },
        { customerConfirmedAt: { $exists: false }, createdAt: { $lte: cutoff } }
      ]
    },
    {
      $set: {
        status: "expired"
      }
    }
  );

  return result.modifiedCount;
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
  const hadActiveFeedbackFollowUp = Boolean(
    order.feedbackFollowUpStatus &&
      order.feedbackFollowUpStatus !== "not_scheduled"
  );
  order.customerPhone = normalizeGhanaPhone(order.customerPhone);
  order.status = status;

  if (status === "completed") {
    order.completedAt = order.completedAt ?? new Date();
    order.completionSource = order.completionSource ?? "owner_manual";
    order.completionConfirmedByCustomer =
      order.completionConfirmedByCustomer ?? false;
    order.feedbackFollowUpStatus = "cancelled";
  } else if (["rejected", "cancelled", "expired"].includes(status)) {
    order.feedbackFollowUpStatus = "cancelled";
  }

  await order.save();

  if (status === "completed" && !order.completionProfileUpdatedAt) {
    await updateCustomerProfileFromCompletedOrder(order);
    order.completionProfileUpdatedAt = new Date();
    await order.save();
  }

  if (
    ["completed", "rejected", "cancelled", "expired"].includes(status) &&
    hadActiveFeedbackFollowUp
  ) {
    await cancelQueuedOrderFeedbackMessages(
      String(order.restaurantId),
      String(order._id),
      `Order changed to ${status}`
    );
  }

  return {
    order
  };
};

export const confirmRestaurantOrder = async (
  orderId: string
): Promise<RestaurantOrderDecisionResult> => {
  const order = await getOrderOrThrow(orderId);

  if (order.status === "accepted" || order.status === "confirmed") {
    return {
      order,
      idempotent: true
    };
  }

  if (order.status !== "awaiting_restaurant_confirmation" && order.status !== "pending") {
    throw new BadRequestError("Only pending orders can be confirmed by the restaurant");
  }

  if (!isPendingOrderActionable(order)) {
    order.status = "expired";
    await order.save();
    throw new BadRequestError("This order has expired and cannot be accepted.");
  }

  order.status = "accepted";
  order.restaurantConfirmedAt = order.restaurantConfirmedAt ?? new Date();
  await order.save();

  return {
    order,
    idempotent: false
  };
};

export const rejectRestaurantOrder = async (
  orderId: string,
  reason?: string
): Promise<RestaurantOrderDecisionResult> => {
  const order = await getOrderOrThrow(orderId);

  if ((order.status === "cancelled" || order.status === "rejected") && order.restaurantRejectedAt) {
    return {
      order,
      idempotent: true
    };
  }

  if (order.status !== "awaiting_restaurant_confirmation" && order.status !== "pending") {
    throw new BadRequestError("Only pending orders can be rejected by the restaurant");
  }

  if (!isPendingOrderActionable(order)) {
    order.status = "expired";
    await order.save();
    throw new BadRequestError("This order has expired and cannot be rejected.");
  }

  order.status = "rejected";
  order.feedbackFollowUpStatus = "cancelled";
  order.restaurantRejectedAt = order.restaurantRejectedAt ?? new Date();
  order.restaurantRejectionReason = reason?.trim() || order.restaurantRejectionReason;
  await order.save();
  await cancelQueuedOrderFeedbackMessages(
    String(order.restaurantId),
    String(order._id),
    "Order rejected"
  );

  return {
    order,
    idempotent: false
  };
};
