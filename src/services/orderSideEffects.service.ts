import { type IOrderDocument } from "../models/order.model";
import { type IRestaurantDocument } from "../models/Restaurant";
import { generateOrderReceipt } from "./receipt.service";
import { formatGhanaCedi } from "./order.service";
import { enqueueWasenderMessage } from "./wasenderQueue.service";

export type SideEffectStepStatus = "success" | "queued" | "failed" | "skipped" | "not_attempted";

export interface OrderSideEffectResult {
  ownerNotification?: SideEffectStepStatus;
  customerNotification?: SideEffectStepStatus;
  receiptGeneration?: SideEffectStepStatus;
  receiptDelivery?: SideEffectStepStatus;
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
};

const formatTitleCase = (value: string): string => {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
};

const getOrderReference = (order: IOrderDocument): string => {
  return order.orderNumber ?? String(order._id);
};

export const getPublicReceiptUrl = (receiptUrl?: string): string | null => {
  if (!receiptUrl) {
    return null;
  }

  if (/^https?:\/\//i.test(receiptUrl)) {
    return receiptUrl;
  }

  const publicUrl = process.env.APP_PUBLIC_URL?.replace(/\/$/, "");

  if (!publicUrl) {
    return null;
  }

  return `${publicUrl}${receiptUrl.startsWith("/") ? receiptUrl : `/${receiptUrl}`}`;
};

export const buildOwnerNewOrderNotification = (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): string => {
  const items = order.items
    .map(
      (item) =>
        `${item.quantity} x ${item.name} - ${formatGhanaCedi(item.totalPrice)}`
    )
    .join("\n");
  const deliveryAddress =
    order.orderType === "delivery" && order.deliveryAddress
      ? [`Address: ${order.deliveryAddress}`]
      : [];
  const deliveryLines =
    order.orderType === "delivery"
      ? [
          order.deliveryFeePending
            ? "Delivery fee: Pending confirmation"
            : `Delivery fee: ${formatGhanaCedi(order.deliveryFee ?? 0)}`,
          `Food total: ${formatGhanaCedi(order.subtotal)}`
        ]
      : [];

  return [
    "New order awaiting your confirmation",
    "",
    `Restaurant: ${restaurant.name}`,
    `Order: ${getOrderReference(order)}`,
    `Customer: ${order.customerName || "Customer"}`,
    `Phone: ${order.customerPhone}`,
    `Type: ${formatTitleCase(order.orderType)}`,
    ...deliveryAddress,
    "",
    "Items:",
    items,
    "",
    ...deliveryLines,
    `Total: ${formatGhanaCedi(order.total)}`,
    `Payment: ${formatTitleCase(order.paymentMethod)} / ${formatTitleCase(order.paymentStatus)}`,
    "Status: Awaiting confirmation",
    "",
    "Reply to this message with:",
    "",
    "Accept",
    "Reject"
  ].join("\n");
};

export const buildCustomerOrderConfirmedMessage = (
  restaurant: IRestaurantDocument,
  order: IOrderDocument,
  receiptAttached: boolean
): string => {
  const receiptLine = receiptAttached ? " Your receipt is attached." : "";

  return `Good news${order.customerName ? `, ${order.customerName}` : ""}. ${restaurant.name} has accepted order ${getOrderReference(order)} and will begin preparing it.${receiptLine}`;
};

export const buildCustomerOrderRejectedMessage = (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): string => {
  const reason = order.restaurantRejectionReason?.trim();

  return reason
    ? `${restaurant.name} could not accept order ${getOrderReference(order)} at this time. The restaurant gave this reason: ${reason}.`
    : `${restaurant.name} could not accept order ${getOrderReference(order)}.`;
};

export const notifyOwnerOfSubmittedOrder = async (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): Promise<OrderSideEffectResult> => {
  if (order.ownerNotifiedAt) {
    console.info("Owner order notification skipped", {
      restaurantId: String(restaurant._id),
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      reason: "already_sent"
    });

    return {
      ownerNotification: "skipped"
    };
  }

  const queued = await enqueueWasenderMessage({
    restaurantId: String(restaurant._id),
    sessionId: restaurant.wasenderSessionId,
    to: restaurant.ownerPhone,
    type: "text",
    text: buildOwnerNewOrderNotification(restaurant, order),
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey: `owner-order-notification:${String(order._id)}`,
    metadata: {
      kind: "owner_order_notification",
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      recipientType: "owner"
    }
  });

  console.info("Owner order notification queued", {
    restaurantId: String(restaurant._id),
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    queueMessageId: String(queued._id),
    recipientType: "owner"
  });

  return {
    ownerNotification: "queued"
  };
};

export const notifyCustomerOfRejectedOrder = async (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): Promise<OrderSideEffectResult> => {
  if (order.rejectionNotificationSentAt) {
    return {
      customerNotification: "skipped"
    };
  }

  await enqueueWasenderMessage({
    restaurantId: String(restaurant._id),
    sessionId: restaurant.wasenderSessionId,
    to: order.customerPhone,
    type: "text",
    text: buildCustomerOrderRejectedMessage(restaurant, order),
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey: `customer-order-rejected:${String(order._id)}`,
    metadata: {
      kind: "customer_order_rejected_notification",
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      recipientType: "customer"
    }
  });

  return {
    customerNotification: "queued"
  };
};

export const buildOwnerOrderCompletedNotification = (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): string => {
  const ref = getOrderReference(order);
  const customerName = order.customerName || "Customer";
  const orderTypeLine =
    order.orderType === "delivery"
      ? `Type: Delivery${order.deliveryAddress ? ` — ${order.deliveryAddress}` : ""}`
      : "Type: Pickup";

  return [
    `✅ Order ${ref} has been completed.`,
    "",
    `Customer: ${customerName}`,
    `Phone: ${order.customerPhone}`,
    orderTypeLine,
    `Total: ${formatGhanaCedi(order.total)}`,
    "",
    "The customer has been sent a follow-up to confirm receipt and leave feedback."
  ].join("\n");
};

export const notifyOwnerOfCompletedOrder = async (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): Promise<OrderSideEffectResult> => {
  if (order.ownerCompletionNotifiedAt) {
    console.info("Owner completion notification skipped", {
      restaurantId: String(restaurant._id),
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      reason: "already_sent"
    });

    return { ownerNotification: "skipped" };
  }

  await enqueueWasenderMessage({
    restaurantId: String(restaurant._id),
    sessionId: restaurant.wasenderSessionId,
    to: restaurant.ownerPhone,
    type: "text",
    text: buildOwnerOrderCompletedNotification(restaurant, order),
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey: `owner-order-completed:${String(order._id)}`,
    metadata: {
      kind: "owner_order_completed_notification",
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      recipientType: "owner"
    }
  });

  console.info("Owner completion notification queued", {
    restaurantId: String(restaurant._id),
    orderId: String(order._id),
    orderNumber: order.orderNumber
  });

  return { ownerNotification: "queued" };
};

export const notifyCustomerOfConfirmedOrderAndSendReceipt = async (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): Promise<OrderSideEffectResult> => {
  const result: OrderSideEffectResult = {
    customerNotification: order.customerConfirmedNotificationSentAt ? "skipped" : "not_attempted",
    receiptGeneration: order.receiptGeneratedAt ? "skipped" : "not_attempted",
    receiptDelivery: order.receiptSentAt ? "skipped" : "not_attempted"
  };

  let receiptOrder = order;

  if (!order.receiptUrl) {
    try {
      console.info("Receipt generation started", {
        restaurantId: String(restaurant._id),
        orderId: String(order._id),
        orderNumber: order.orderNumber
      });
      const receipt = await generateOrderReceipt(String(order._id));
      receiptOrder = receipt.order;
      result.receiptGeneration = "success";
      console.info("Receipt generation succeeded", {
        restaurantId: String(restaurant._id),
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        receiptUrl: receipt.receiptUrl
      });
    } catch (error) {
      order.receiptGenerationFailedAt = new Date();
      order.receiptGenerationFailureReason = getErrorMessage(error);
      await order.save();
      result.receiptGeneration = "failed";
      console.error("Receipt generation failed", {
        restaurantId: String(restaurant._id),
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        error: order.receiptGenerationFailureReason
      });
    }
  }

  const publicReceiptUrl = getPublicReceiptUrl(receiptOrder.receiptUrl);
  const canSendReceipt = Boolean(publicReceiptUrl);

  if (!receiptOrder.customerConfirmedNotificationSentAt) {
    await enqueueWasenderMessage({
      restaurantId: String(restaurant._id),
      sessionId: restaurant.wasenderSessionId,
      to: receiptOrder.customerPhone,
      type: "text",
      text: buildCustomerOrderConfirmedMessage(restaurant, receiptOrder, canSendReceipt),
      apiKey: restaurant.wasenderApiToken,
      idempotencyKey: `customer-order-confirmed:${String(receiptOrder._id)}`,
      metadata: {
        kind: "customer_order_confirmed_notification",
        orderId: String(receiptOrder._id),
        orderNumber: receiptOrder.orderNumber,
        recipientType: "customer"
      }
    });
    result.customerNotification = "queued";
  }

  if (receiptOrder.receiptSentAt) {
    result.receiptDelivery = "skipped";
    return result;
  }

  if (!publicReceiptUrl) {
    result.receiptDelivery =
      result.receiptGeneration === "failed" ? "not_attempted" : "failed";

    if (result.receiptDelivery === "failed") {
      receiptOrder.receiptDeliveryFailedAt = new Date();
      receiptOrder.receiptDeliveryFailureReason = "Receipt public URL is not available";
      await receiptOrder.save();
      console.error("Receipt document failed", {
        restaurantId: String(restaurant._id),
        orderId: String(receiptOrder._id),
        orderNumber: receiptOrder.orderNumber,
        error: receiptOrder.receiptDeliveryFailureReason,
        hasAppPublicUrl: Boolean(process.env.APP_PUBLIC_URL?.trim())
      });
    }

    return result;
  }

  const queuedReceipt = await enqueueWasenderMessage({
    restaurantId: String(restaurant._id),
    sessionId: restaurant.wasenderSessionId,
    to: receiptOrder.customerPhone,
    type: "document",
    documentUrl: publicReceiptUrl,
    caption: `Receipt for ${getOrderReference(receiptOrder)}`,
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey: `receipt-delivery:${String(receiptOrder._id)}`,
    metadata: {
      kind: "receipt_delivery",
      orderId: String(receiptOrder._id),
      orderNumber: receiptOrder.orderNumber,
      recipientType: "customer"
    }
  });
  console.info("Receipt queued", {
    restaurantId: String(restaurant._id),
    orderId: String(receiptOrder._id),
    orderNumber: receiptOrder.orderNumber,
    queueMessageId: String(queuedReceipt._id)
  });
  result.receiptDelivery = "queued";

  return result;
};

export const retryAcceptedOrderReceiptDelivery = async (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): Promise<OrderSideEffectResult> => {
  if (!["accepted", "confirmed", "preparing", "ready", "completed"].includes(order.status)) {
    return {
      receiptGeneration: "skipped",
      receiptDelivery: "skipped"
    };
  }

  if (order.receiptSentAt) {
    return {
      receiptGeneration: order.receiptGeneratedAt ? "skipped" : "not_attempted",
      receiptDelivery: "skipped"
    };
  }

  return notifyCustomerOfConfirmedOrderAndSendReceipt(restaurant, order);
};
