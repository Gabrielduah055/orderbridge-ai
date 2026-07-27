import { type IOrderDocument } from "../models/order.model";
import { type IRestaurantDocument } from "../models/Restaurant";
import { generateOrderReceipt } from "./receipt.service";
import { formatGhanaCedi } from "./order.service";
import { sendDocumentMessage, sendTextMessage, type WasenderSendResult } from "./wasender.service";

export type SideEffectStepStatus = "success" | "failed" | "skipped" | "not_attempted";

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

const getSendFailureReason = (result: WasenderSendResult): string => {
  return result.error || (result.status ? `Wasender status ${result.status}` : "Wasender send failed");
};

const formatTitleCase = (value: string): string => {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
};

const getOrderReference = (order: IOrderDocument): string => {
  return order.orderNumber ?? String(order._id);
};

const getPublicReceiptUrl = (receiptUrl?: string): string | null => {
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

  return [
    "New order awaiting your confirmation",
    "",
    `Restaurant: ${restaurant.name}`,
    `Order: ${getOrderReference(order)}`,
    `Customer: ${order.customerName || "Guest"}`,
    `Phone: ${order.customerPhone}`,
    `Type: ${formatTitleCase(order.orderType)}`,
    ...deliveryAddress,
    "",
    "Items:",
    items,
    "",
    `Total: ${formatGhanaCedi(order.total)}`,
    `Payment: ${formatTitleCase(order.paymentMethod)} / ${formatTitleCase(order.paymentStatus)}`,
    "Status: Awaiting confirmation",
    "",
    "Reply:",
    `ACCEPT ${getOrderReference(order)}`,
    "or",
    `REJECT ${getOrderReference(order)}`
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

  const result = await sendTextMessage(
    restaurant.wasenderSessionId,
    restaurant.ownerPhone,
    buildOwnerNewOrderNotification(restaurant, order),
    {
      apiKey: restaurant.wasenderApiToken
    }
  );

  if (!result.success) {
    order.ownerNotificationFailedAt = new Date();
    order.ownerNotificationFailureReason = getSendFailureReason(result);
    await order.save();

    console.error("Owner order notification failed", {
      restaurantId: String(restaurant._id),
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      recipientType: "owner",
      status: result.status,
      error: result.error
    });

    return {
      ownerNotification: "failed"
    };
  }

  order.ownerNotifiedAt = new Date();
  order.ownerNotificationFailedAt = undefined;
  order.ownerNotificationFailureReason = undefined;
  await order.save();

  console.info("Owner order notification sent", {
    restaurantId: String(restaurant._id),
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    recipientType: "owner",
    status: result.status
  });

  return {
    ownerNotification: "success"
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

  const result = await sendTextMessage(
    restaurant.wasenderSessionId,
    order.customerPhone,
    buildCustomerOrderRejectedMessage(restaurant, order),
    {
      apiKey: restaurant.wasenderApiToken
    }
  );

  if (!result.success) {
    order.customerNotificationFailedAt = new Date();
    order.customerNotificationFailureReason = getSendFailureReason(result);
    await order.save();

    return {
      customerNotification: "failed"
    };
  }

  order.rejectionNotificationSentAt = new Date();
  order.customerNotificationFailedAt = undefined;
  order.customerNotificationFailureReason = undefined;
  await order.save();

  return {
    customerNotification: "success"
  };
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
      const receipt = await generateOrderReceipt(String(order._id));
      receiptOrder = receipt.order;
      result.receiptGeneration = "success";
    } catch (error) {
      order.receiptGenerationFailedAt = new Date();
      order.receiptGenerationFailureReason = getErrorMessage(error);
      await order.save();
      result.receiptGeneration = "failed";
    }
  }

  const publicReceiptUrl = getPublicReceiptUrl(receiptOrder.receiptUrl);
  const canSendReceipt = Boolean(publicReceiptUrl);

  if (!receiptOrder.customerConfirmedNotificationSentAt) {
    const textResult = await sendTextMessage(
      restaurant.wasenderSessionId,
      receiptOrder.customerPhone,
      buildCustomerOrderConfirmedMessage(restaurant, receiptOrder, canSendReceipt),
      {
        apiKey: restaurant.wasenderApiToken
      }
    );

    if (textResult.success) {
      receiptOrder.customerConfirmedNotificationSentAt = new Date();
      receiptOrder.customerNotificationFailedAt = undefined;
      receiptOrder.customerNotificationFailureReason = undefined;
      result.customerNotification = "success";
    } else {
      receiptOrder.customerNotificationFailedAt = new Date();
      receiptOrder.customerNotificationFailureReason = getSendFailureReason(textResult);
      result.customerNotification = "failed";
    }

    await receiptOrder.save();
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
    }

    return result;
  }

  const documentResult = await sendDocumentMessage(
    restaurant.wasenderSessionId,
    receiptOrder.customerPhone,
    publicReceiptUrl,
    `Receipt for ${getOrderReference(receiptOrder)}`,
    {
      apiKey: restaurant.wasenderApiToken
    }
  );

  if (!documentResult.success) {
    receiptOrder.receiptDeliveryFailedAt = new Date();
    receiptOrder.receiptDeliveryFailureReason = getSendFailureReason(documentResult);
    await receiptOrder.save();
    result.receiptDelivery = "failed";
    return result;
  }

  receiptOrder.receiptSentAt = new Date();
  receiptOrder.receiptDeliveryFailedAt = undefined;
  receiptOrder.receiptDeliveryFailureReason = undefined;
  await receiptOrder.save();
  result.receiptDelivery = "success";

  return result;
};
