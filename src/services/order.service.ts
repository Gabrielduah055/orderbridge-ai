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
  idempotent?: boolean;
}

export interface RestaurantOrderDecisionResult {
  order: IOrderDocument;
  idempotent: boolean;
}

export interface AmendCustomerSubmittedOrderInput {
  itemName?: string;
  menuItemId?: string;
  newQuantity?: number;
  orderType?: OrderType;
  deliveryAddress?: string;
}

export interface AmendCustomerSubmittedOrderResult {
  order: IOrderDocument;
  amendmentVersion: number;
}

export type CustomerCancellationMode = "cancelled" | "requested";

export interface CustomerCancellationResult extends UpdateOrderStatusResult {
  mode: CustomerCancellationMode;
}

export interface ResolveCustomerCancellationRequestInput {
  decision: "approve" | "decline";
  resolvedByPhone: string;
  reason?: string;
}

export interface ResolveCustomerCancellationRequestResult
  extends UpdateOrderStatusResult {
  decision: "approved" | "declined";
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

const getOrderOrThrow = async (
  orderId: string,
  restaurantId?: string
): Promise<IOrderDocument> => {
  ensureValidObjectId(orderId, "orderId");
  if (restaurantId) {
    ensureValidObjectId(restaurantId, "restaurantId");
  }
  const order = restaurantId
    ? await Order.findOne({ _id: orderId, restaurantId })
    : await Order.findById(orderId);

  if (!order) {
    throw new NotFoundError("Order not found");
  }

  return order;
};

export const staffOrderProgressStatuses = [
  "preparing",
  "ready",
  "out_for_delivery",
  "completed"
] as const;

export type StaffOrderProgressStatus = (typeof staffOrderProgressStatuses)[number];

const allowedStaffOrderTransitions: Record<StaffOrderProgressStatus, readonly StaffOrderProgressStatus[]> = {
  preparing: ["ready", "out_for_delivery", "completed"],
  ready: ["out_for_delivery", "completed"],
  out_for_delivery: ["completed"],
  completed: []
};

const rejectionReasonPlaceholders = new Set([
  "restaurant is unable to fulfill this order at this time",
  "restaurant is unable to fulfil this order at this time",
  "unable to fulfill this order at this time",
  "unable to fulfil this order at this time",
  "no reason provided",
  "reason not provided",
  "not specified",
  "unspecified",
  "n/a",
  "none"
]);

export const getTrustedRestaurantRejectionReason = (
  reason?: string
): string | undefined => {
  const normalized = reason?.trim().replace(/\s+/g, " ") ?? "";
  const normalizedKey = normalized.toLowerCase().replace(/[.!]+$/, "");

  if (
    normalized.length < 3 ||
    normalized.length > 500 ||
    rejectionReasonPlaceholders.has(normalizedKey)
  ) {
    return undefined;
  }

  return normalized;
};

export const normalizeRestaurantRejectionReason = (reason?: string): string => {
  const normalized = getTrustedRestaurantRejectionReason(reason);

  if (!normalized) {
    throw new BadRequestError(
      "Please provide a meaningful reason for rejecting the order.",
      "ORDER_REJECTION_REASON_REQUIRED"
    );
  }

  return normalized;
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

export const customerAmendableOrderStatuses = [
  "awaiting_restaurant_confirmation",
  "pending"
] as const;

export const customerDirectCancellationStatuses: readonly OrderStatus[] = [
  "awaiting_restaurant_confirmation",
  "pending"
];

export const customerCancellationRequestStatuses: readonly OrderStatus[] = [
  "confirmed",
  "accepted",
  "preparing",
  "ready",
  "out_for_delivery"
];

export const amendCustomerSubmittedOrder = async (
  restaurantId: string,
  orderId: string,
  customerPhone: string,
  input: AmendCustomerSubmittedOrderInput
): Promise<AmendCustomerSubmittedOrderResult> => {
  const restaurant = await getRestaurantOrThrow(restaurantId);
  const order = await getOrderOrThrow(orderId, restaurantId);
  const normalizedCustomerPhone = normalizeGhanaPhone(customerPhone);

  if (normalizeGhanaPhone(order.customerPhone) !== normalizedCustomerPhone) {
    throw new BadRequestError("That order is not available for this customer", "ORDER_FORBIDDEN");
  }

  if (!customerAmendableOrderStatuses.includes(order.status as (typeof customerAmendableOrderStatuses)[number])) {
    throw new BadRequestError(
      "This order can no longer be updated because the restaurant has already acted on it.",
      "ORDER_NOT_AMENDABLE"
    );
  }

  const hasItemChange = typeof input.newQuantity === "number";
  let items = order.items.map((item) => ({
    menuItemId: item.menuItemId,
    name: item.name,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    totalPrice: item.totalPrice
  }));

  if (hasItemChange) {
    const normalizedItemName = normalizeComparableText(input.itemName ?? "");
    const matches = normalizedItemName
      ? items.filter((item) => {
          const savedName = normalizeComparableText(item.name);
          return savedName.includes(normalizedItemName) || normalizedItemName.includes(savedName);
        })
      : [];

    if (matches.length > 1) {
      throw new BadRequestError(
        "More than one order item matched that name. Please be more specific.",
        "MULTIPLE_ORDER_ITEMS_FOUND"
      );
    }

    if (matches.length === 1) {
      const matchedId = String(matches[0].menuItemId);
      items =
        input.newQuantity === 0
          ? items.filter((item) => String(item.menuItemId) !== matchedId)
          : items.map((item) =>
              String(item.menuItemId) === matchedId
                ? { ...item, quantity: input.newQuantity as number }
                : item
            );
    } else if (input.newQuantity === 0) {
      throw new BadRequestError(
        "That item is not in the submitted order.",
        "ORDER_ITEM_NOT_FOUND"
      );
    } else if (input.menuItemId) {
      items.push({
        menuItemId: new Types.ObjectId(input.menuItemId),
        name: input.itemName ?? "Menu item",
        quantity: input.newQuantity as number,
        unitPrice: 0,
        totalPrice: 0
      });
    } else {
      throw new BadRequestError(
        "That item is not in the submitted order.",
        "ORDER_ITEM_NOT_FOUND"
      );
    }

    if (items.length === 0) {
      throw new BadRequestError(
        "A submitted order must contain at least one item. Cancel the order instead.",
        "ORDER_ITEMS_REQUIRED"
      );
    }
  }

  const refreshedItems = hasItemChange
    ? await buildOrderItems(
        restaurantId,
        items.map((item) => ({
          menuItemId: String(item.menuItemId),
          quantity: item.quantity
        }))
      )
    : order.items;
  const subtotal = refreshedItems.reduce((sum, item) => sum + item.totalPrice, 0);
  const orderType = input.orderType ?? order.orderType;

  if (input.deliveryAddress && orderType !== "delivery") {
    throw new BadRequestError(
      "Change the order type to delivery before setting a delivery address.",
      "DELIVERY_ORDER_TYPE_REQUIRED"
    );
  }

  const deliveryAddress =
    orderType === "delivery"
      ? input.deliveryAddress?.trim() || order.deliveryAddress?.trim()
      : undefined;

  if (orderType === "delivery") {
    if (!restaurant.deliveryEnabled) {
      throw new BadRequestError("Delivery is not enabled for this restaurant");
    }

    if (!deliveryAddress) {
      throw new BadRequestError(
        "Delivery address is required for delivery orders",
        "DELIVERY_ADDRESS_REQUIRED"
      );
    }
  }

  const deliveryFeeResolution = resolveDeliveryFee(
    restaurant,
    orderType,
    deliveryAddress,
    subtotal
  );
  const deliveryFeePending =
    orderType === "delivery" &&
    !deliveryFeeResolution.resolved &&
    deliveryFeeResolution.source === "manual_confirmation";

  if (
    !deliveryFeePending &&
    (!deliveryFeeResolution.resolved || deliveryFeeResolution.amount === null)
  ) {
    throw new BadRequestError("Delivery fee is not resolved for this order");
  }

  const deliveryFee = deliveryFeePending ? null : deliveryFeeResolution.amount ?? 0;
  const amendmentVersion = (order.customerAmendmentVersion ?? 0) + 1;
  const unsetFields: Record<string, 1> = {};
  if (!deliveryAddress) unsetFields.deliveryAddress = 1;
  if (deliveryFeePending) unsetFields.deliveryFeeResolvedAt = 1;

  const amendedOrder = await Order.findOneAndUpdate(
    {
      _id: orderId,
      restaurantId,
      status: { $in: [...customerAmendableOrderStatuses] }
    },
    {
      $set: {
        customerPhone: normalizedCustomerPhone,
        items: refreshedItems,
        subtotal,
        deliveryFee,
        deliveryFeeSource: deliveryFeeResolution.source,
        deliveryFeePending,
        ...(deliveryFeePending ? {} : { deliveryFeeResolvedAt: new Date() }),
        total: deliveryFeePending ? subtotal : subtotal + (deliveryFee ?? 0),
        orderType,
        ...(deliveryAddress ? { deliveryAddress } : {}),
        customerAmendedAt: new Date(),
        customerAmendmentVersion: amendmentVersion
      },
      ...(Object.keys(unsetFields).length > 0 ? { $unset: unsetFields } : {})
    },
    { new: true, runValidators: true }
  );

  if (!amendedOrder) {
    throw new BadRequestError(
      "This order changed while it was being updated. Please check its latest status.",
      "ORDER_AMENDMENT_CONFLICT"
    );
  }

  return { order: amendedOrder, amendmentVersion };
};

export const updateOrderStatus = async (
  orderId: string,
  status: OrderStatus
): Promise<UpdateOrderStatusResult> => {
  const order = await getOrderOrThrow(orderId);
  return applyOrderStatusUpdate(order, status);
};

const applyOrderStatusUpdate = async (
  order: IOrderDocument,
  status: OrderStatus
): Promise<UpdateOrderStatusResult> => {
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

export const cancelCustomerOrder = async (
  restaurantId: string,
  orderId: string,
  customerPhone: string
): Promise<CustomerCancellationResult> => {
  const order = await getOrderOrThrow(orderId, restaurantId);

  if (normalizeGhanaPhone(order.customerPhone) !== normalizeGhanaPhone(customerPhone)) {
    throw new BadRequestError("That order is not available for this customer", "ORDER_FORBIDDEN");
  }

  if (order.status === "cancelled" && order.customerCancelledAt) {
    return { order, mode: "cancelled", idempotent: true };
  }

  if (
    order.status === "cancelled" &&
    order.customerCancellationRequestStatus === "approved"
  ) {
    return { order, mode: "requested", idempotent: true };
  }

  if (order.customerCancellationRequestStatus === "pending") {
    return { order, mode: "requested", idempotent: true };
  }

  if (customerDirectCancellationStatuses.includes(order.status)) {
    const hadActiveFeedbackFollowUp = Boolean(
      order.feedbackFollowUpStatus &&
        order.feedbackFollowUpStatus !== "not_scheduled"
    );
    const cancelledOrder = await Order.findOneAndUpdate(
      {
        _id: orderId,
        restaurantId,
        status: { $in: [...customerDirectCancellationStatuses] }
      },
      {
        $set: {
          status: "cancelled",
          customerCancelledAt: new Date(),
          feedbackFollowUpStatus: "cancelled"
        }
      },
      { new: true, runValidators: true }
    );

    if (!cancelledOrder) {
      throw new BadRequestError(
        "This order changed while cancellation was being processed. Please check its latest status.",
        "ORDER_CANCELLATION_CONFLICT"
      );
    }

    if (hadActiveFeedbackFollowUp) {
      await cancelQueuedOrderFeedbackMessages(
        restaurantId,
        orderId,
        "Customer cancelled order before restaurant acceptance"
      );
    }

    return { order: cancelledOrder, mode: "cancelled", idempotent: false };
  }

  if (customerCancellationRequestStatuses.includes(order.status)) {
    if (order.customerCancellationRequestStatus === "declined") {
      return { order, mode: "requested", idempotent: true };
    }

    const requestedOrder = await Order.findOneAndUpdate(
      {
        _id: orderId,
        restaurantId,
        status: { $in: [...customerCancellationRequestStatuses] },
        customerCancellationRequestStatus: { $ne: "pending" }
      },
      {
        $set: {
          customerCancellationRequestedAt: new Date(),
          customerCancellationRequestStatus: "pending"
        },
        $unset: {
          customerCancellationResolvedAt: 1,
          customerCancellationResolvedByPhone: 1,
          customerCancellationResolutionReason: 1,
          customerCancellationResolutionNotifiedAt: 1,
          customerCancellationResolutionNotificationFailedAt: 1,
          customerCancellationResolutionNotificationFailureReason: 1
        }
      },
      { new: true, runValidators: true }
    );

    if (!requestedOrder) {
      const latest = await getOrderOrThrow(orderId, restaurantId);
      if (latest.customerCancellationRequestStatus === "pending") {
        return { order: latest, mode: "requested", idempotent: true };
      }
      throw new BadRequestError(
        "This order changed while the cancellation request was being sent.",
        "ORDER_CANCELLATION_CONFLICT"
      );
    }

    return { order: requestedOrder, mode: "requested", idempotent: false };
  }

  throw new BadRequestError(
    "This order cannot be cancelled in its current state.",
    "ORDER_NOT_CANCELLABLE"
  );
};

export const resolveCustomerCancellationRequest = async (
  restaurantId: string,
  orderId: string,
  input: ResolveCustomerCancellationRequestInput
): Promise<ResolveCustomerCancellationRequestResult> => {
  const order = await getOrderOrThrow(orderId, restaurantId);
  const resolvedStatus = input.decision === "approve" ? "approved" : "declined";

  if (order.customerCancellationRequestStatus === resolvedStatus) {
    return { order, decision: resolvedStatus, idempotent: true };
  }

  if (order.customerCancellationRequestStatus !== "pending") {
    throw new BadRequestError(
      "There is no pending customer cancellation request for this order.",
      "CANCELLATION_REQUEST_NOT_PENDING"
    );
  }

  const now = new Date();
  const update = {
    $set: {
      customerCancellationRequestStatus: resolvedStatus,
      customerCancellationResolvedAt: now,
      customerCancellationResolvedByPhone: normalizeGhanaPhone(
        input.resolvedByPhone
      ),
      ...(input.reason?.trim()
        ? { customerCancellationResolutionReason: input.reason.trim() }
        : {}),
      ...(input.decision === "approve"
        ? { status: "cancelled" as const, feedbackFollowUpStatus: "cancelled" as const }
        : {})
    }
  };
  const resolvedOrder = await Order.findOneAndUpdate(
    {
      _id: orderId,
      restaurantId,
      customerCancellationRequestStatus: "pending",
      ...(input.decision === "approve"
        ? { status: { $in: [...customerCancellationRequestStatuses] } }
        : {})
    },
    update,
    { new: true, runValidators: true }
  );

  if (!resolvedOrder) {
    const latest = await getOrderOrThrow(orderId, restaurantId);
    if (latest.customerCancellationRequestStatus === resolvedStatus) {
      return { order: latest, decision: resolvedStatus, idempotent: true };
    }
    throw new BadRequestError(
      "This cancellation request changed while it was being resolved.",
      "CANCELLATION_REQUEST_CONFLICT"
    );
  }

  if (input.decision === "approve") {
    await cancelQueuedOrderFeedbackMessages(
      restaurantId,
      orderId,
      "Restaurant approved customer cancellation request"
    );
  }

  return {
    order: resolvedOrder,
    decision: resolvedStatus,
    idempotent: false
  };
};

export const updateRestaurantOrderStatus = async (
  restaurantId: string,
  orderId: string,
  status: StaffOrderProgressStatus
): Promise<UpdateOrderStatusResult> => {
  const order = await getOrderOrThrow(orderId, restaurantId);

  if (order.status === status) {
    return {
      order,
      idempotent: true
    };
  }

  const allowedTargets = allowedStaffOrderTransitions[
    order.status as StaffOrderProgressStatus
  ];
  const mayBeginProgress =
    (order.status === "accepted" || order.status === "confirmed") &&
    staffOrderProgressStatuses.includes(status);

  if (!mayBeginProgress && !allowedTargets?.includes(status)) {
    throw new BadRequestError(
      `Order ${order.orderNumber ?? String(order._id)} cannot move from ${order.status} to ${status}.`,
      "ORDER_STATUS_TRANSITION_INVALID"
    );
  }

  const result = await applyOrderStatusUpdate(order, status);
  return {
    ...result,
    idempotent: false
  };
};

export const confirmRestaurantOrder = async (
  orderId: string,
  restaurantId?: string,
  expectedAmendmentVersion?: number
): Promise<RestaurantOrderDecisionResult> => {
  const order = await getOrderOrThrow(orderId, restaurantId);

  if (order.status === "accepted" || order.status === "confirmed") {
    return {
      order,
      idempotent: true
    };
  }

  if (order.status !== "awaiting_restaurant_confirmation" && order.status !== "pending") {
    throw new BadRequestError(
      "Only pending orders can be confirmed by the restaurant.",
      "ORDER_STATUS_TRANSITION_INVALID"
    );
  }

  if (!isPendingOrderActionable(order)) {
    order.status = "expired";
    await order.save();
    throw new BadRequestError(
      "This order has expired and cannot be accepted.",
      "ORDER_EXPIRED"
    );
  }

  const acceptedOrder = await Order.findOneAndUpdate(
    {
      _id: order._id,
      ...(restaurantId ? { restaurantId } : {}),
      status: { $in: ["awaiting_restaurant_confirmation", "pending"] },
      ...(expectedAmendmentVersion === undefined
        ? {}
        : expectedAmendmentVersion === 0
          ? {
              $or: [
                { customerAmendmentVersion: 0 },
                { customerAmendmentVersion: { $exists: false } }
              ]
            }
          : { customerAmendmentVersion: expectedAmendmentVersion })
    },
    {
      $set: {
        status: "accepted",
        restaurantConfirmedAt: order.restaurantConfirmedAt ?? new Date()
      }
    },
    { new: true }
  );

  if (!acceptedOrder) {
    const currentOrder = await getOrderOrThrow(orderId, restaurantId);
    if (currentOrder.status === "accepted" || currentOrder.status === "confirmed") {
      return { order: currentOrder, idempotent: true };
    }
    if (
      expectedAmendmentVersion !== undefined &&
      (currentOrder.customerAmendmentVersion ?? 0) !== expectedAmendmentVersion
    ) {
      throw new BadRequestError(
        `That order has been updated since this message. Please review the latest ${currentOrder.orderNumber ?? "order"} update before accepting or rejecting it.`,
        "ORDER_NOTIFICATION_VERSION_STALE"
      );
    }
    throw new BadRequestError(
      "This order changed before it could be accepted.",
      "ORDER_STATUS_TRANSITION_INVALID"
    );
  }

  return {
    order: acceptedOrder,
    idempotent: false
  };
};

export const rejectRestaurantOrder = async (
  orderId: string,
  reason?: string,
  restaurantId?: string,
  expectedAmendmentVersion?: number
): Promise<RestaurantOrderDecisionResult> => {
  const normalizedReason = normalizeRestaurantRejectionReason(reason);
  const order = await getOrderOrThrow(orderId, restaurantId);

  if ((order.status === "cancelled" || order.status === "rejected") && order.restaurantRejectedAt) {
    return {
      order,
      idempotent: true
    };
  }

  if (order.status !== "awaiting_restaurant_confirmation" && order.status !== "pending") {
    throw new BadRequestError(
      "Only pending orders can be rejected by the restaurant.",
      "ORDER_STATUS_TRANSITION_INVALID"
    );
  }

  if (!isPendingOrderActionable(order)) {
    order.status = "expired";
    await order.save();
    throw new BadRequestError(
      "This order has expired and cannot be rejected.",
      "ORDER_EXPIRED"
    );
  }

  const rejectedOrder = await Order.findOneAndUpdate(
    {
      _id: order._id,
      ...(restaurantId ? { restaurantId } : {}),
      status: { $in: ["awaiting_restaurant_confirmation", "pending"] },
      ...(expectedAmendmentVersion === undefined
        ? {}
        : expectedAmendmentVersion === 0
          ? {
              $or: [
                { customerAmendmentVersion: 0 },
                { customerAmendmentVersion: { $exists: false } }
              ]
            }
          : { customerAmendmentVersion: expectedAmendmentVersion })
    },
    {
      $set: {
        status: "rejected",
        feedbackFollowUpStatus: "cancelled",
        restaurantRejectedAt: order.restaurantRejectedAt ?? new Date(),
        restaurantRejectionReason: normalizedReason
      }
    },
    { new: true }
  );

  if (!rejectedOrder) {
    const currentOrder = await getOrderOrThrow(orderId, restaurantId);
    if (
      (currentOrder.status === "cancelled" || currentOrder.status === "rejected") &&
      currentOrder.restaurantRejectedAt
    ) {
      return { order: currentOrder, idempotent: true };
    }
    if (
      expectedAmendmentVersion !== undefined &&
      (currentOrder.customerAmendmentVersion ?? 0) !== expectedAmendmentVersion
    ) {
      throw new BadRequestError(
        `That order has been updated since this message. Please review the latest ${currentOrder.orderNumber ?? "order"} update before accepting or rejecting it.`,
        "ORDER_NOTIFICATION_VERSION_STALE"
      );
    }
    throw new BadRequestError(
      "This order changed before it could be rejected.",
      "ORDER_STATUS_TRANSITION_INVALID"
    );
  }
  await cancelQueuedOrderFeedbackMessages(
    String(rejectedOrder.restaurantId),
    String(rejectedOrder._id),
    "Order rejected"
  );

  return {
    order: rejectedOrder,
    idempotent: false
  };
};
