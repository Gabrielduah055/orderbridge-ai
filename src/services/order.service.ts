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
import type { IRestaurantDocument } from "../models/Restaurant";
import { BadRequestError, NotFoundError } from "../utils/httpErrors";
import { normalizeGhanaPhone } from "../utils/phone.util";
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
  const deliveryFeeResolution =
    input.orderType === "delivery"
      ? resolveDeliveryFee(restaurant, input.orderType, input.deliveryAddress, subtotal)
      : resolveDeliveryFee(restaurant, input.orderType, undefined, subtotal);

  if (!deliveryFeeResolution.resolved || deliveryFeeResolution.amount === null) {
    throw new BadRequestError("Delivery fee is not resolved for this order");
  }

  const deliveryFee = input.deliveryFee ?? deliveryFeeResolution.amount;
  const total = subtotal + deliveryFee;

  try {
    return await Order.create({
      restaurantId,
      customerName: input.customerName,
      customerPhone: normalizeGhanaPhone(input.customerPhone),
      items,
      subtotal,
      deliveryFee,
      deliveryFeeSource: input.deliveryFeeSource ?? deliveryFeeResolution.source,
      deliveryFeeResolvedAt: new Date(),
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
  order.customerPhone = normalizeGhanaPhone(order.customerPhone);
  order.status = status;

  if (status === "completed") {
    order.completedAt = order.completedAt ?? new Date();
  }

  await order.save();

  if (status === "completed") {
    await updateCustomerProfileFromCompletedOrder(order);
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

  order.status = "rejected";
  order.restaurantRejectedAt = order.restaurantRejectedAt ?? new Date();
  order.restaurantRejectionReason = reason?.trim() || order.restaurantRejectionReason;
  await order.save();

  return {
    order,
    idempotent: false
  };
};
