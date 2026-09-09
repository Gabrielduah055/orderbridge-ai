import { type IOrderDocument } from "../models/order.model";
import { type IRestaurantDocument } from "../models/Restaurant";
import { generateOrderReceipt } from "./receipt.service";
import {
  formatGhanaCedi,
  getTrustedRestaurantRejectionReason
} from "./order.service";
import { enqueueWasenderMessage } from "./wasenderQueue.service";
import { queueMarketingConsentRequest } from "./customerMarketingOnboarding.service";
import { resolveCurrentWhatsappRecipient } from "./customerIdentity.service";

/** Delay in milliseconds before sending the marketing opt-in message after receipt delivery. */
const MARKETING_CONSENT_DELAY_MS = 2 * 60 * 1_000; // 2 minutes

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

const getCustomerQueueStatus = (message: {
  status?: string;
}): SideEffectStepStatus => {
  if (message.status === "pending" || message.status === "sending") {
    return "queued";
  }

  if (message.status === "sent") {
    return "success";
  }

  return "failed";
};

const logMissingCustomerRecipient = (
  restaurant: IRestaurantDocument,
  order: IOrderDocument,
  kind: string
): void => {
  console.warn("Customer WhatsApp notification skipped", {
    restaurantId: String(restaurant._id),
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    kind,
    reason: "no_current_whatsapp_recipient"
  });
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

export const buildOwnerCustomerCancellationNotification = (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): string =>
  [
    "Customer cancelled an order",
    "",
    `Restaurant: ${restaurant.name}`,
    `Order: ${getOrderReference(order)}`,
    `Customer: ${order.customerName || "Customer"}`,
    `Phone: ${order.customerPhone}`,
    "Status: Cancelled",
    "",
    "Please stop preparing or dispatching this order."
  ].join("\n");

export const buildOwnerCustomerCancellationRequestNotification = (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): string =>
  [
    "⚠️ CANCELLATION REQUEST",
    "",
    `${order.customerName || "Customer"} wants to cancel ${getOrderReference(order)}.`,
    "",
    `Restaurant: ${restaurant.name}`,
    `Current status: ${formatTitleCase(order.status)}`,
    "",
    "Please approve or decline the cancellation request."
  ].join("\n");

export const buildCustomerCancellationResolutionNotification = (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): string => {
  const approved = order.customerCancellationRequestStatus === "approved";
  const reason = order.customerCancellationResolutionReason?.trim();

  return [
    approved
      ? `${restaurant.name} approved your cancellation request for ${getOrderReference(order)}. The order has been cancelled.`
      : `${restaurant.name} could not approve your cancellation request for ${getOrderReference(order)}. The order remains ${formatTitleCase(order.status)}.`,
    ...(reason ? ["", `Reason: ${reason}`] : [])
  ].join("\n");
};

export const buildOwnerOrderAmendedNotification = (
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
    "Customer updated an order awaiting confirmation",
    "",
    `Restaurant: ${restaurant.name}`,
    `Order: ${getOrderReference(order)}`,
    `Customer: ${order.customerName || "Customer"}`,
    `Phone: ${order.customerPhone}`,
    `Type: ${formatTitleCase(order.orderType)}`,
    ...deliveryAddress,
    "",
    "Updated items:",
    items,
    "",
    order.deliveryFeePending
      ? "Delivery fee: Pending confirmation"
      : `Delivery fee: ${formatGhanaCedi(order.deliveryFee ?? 0)}`,
    `Total: ${formatGhanaCedi(order.total)}`,
    "Status: Awaiting confirmation",
    "",
    "Please review the updated order before accepting or rejecting it."
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
  const reason = getTrustedRestaurantRejectionReason(
    order.restaurantRejectionReason
  );

  return reason
    ? `${restaurant.name} could not accept order ${getOrderReference(order)}.\n\nReason:\n${reason}`
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
      amendmentVersion: 0,
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

export const notifyOwnerOfCustomerCancellation = async (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): Promise<OrderSideEffectResult> => {
  if (order.ownerCancellationNotifiedAt) {
    return { ownerNotification: "skipped" };
  }

  await enqueueWasenderMessage({
    restaurantId: String(restaurant._id),
    sessionId: restaurant.wasenderSessionId,
    to: restaurant.ownerPhone,
    type: "text",
    text: buildOwnerCustomerCancellationNotification(restaurant, order),
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey: `owner-order-cancelled:${String(order._id)}`,
    metadata: {
      kind: "owner_order_cancelled_notification",
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      recipientType: "owner"
    }
  });

  return { ownerNotification: "queued" };
};

export const notifyOwnerOfCustomerCancellationRequest = async (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): Promise<OrderSideEffectResult> => {
  if (
    order.customerCancellationRequestStatus !== "pending" ||
    order.ownerCancellationRequestNotifiedAt
  ) {
    return { ownerNotification: "skipped" };
  }

  await enqueueWasenderMessage({
    restaurantId: String(restaurant._id),
    sessionId: restaurant.wasenderSessionId,
    to: restaurant.ownerPhone,
    type: "text",
    text: buildOwnerCustomerCancellationRequestNotification(restaurant, order),
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey: `owner-order-cancellation-request:${String(order._id)}`,
    metadata: {
      kind: "owner_order_cancellation_request_notification",
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      recipientType: "owner"
    }
  });

  return { ownerNotification: "queued" };
};

export const notifyCustomerOfCancellationResolution = async (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): Promise<OrderSideEffectResult> => {
  const decision = order.customerCancellationRequestStatus;
  if (
    (decision !== "approved" && decision !== "declined") ||
    order.customerCancellationResolutionNotifiedAt
  ) {
    return { customerNotification: "skipped" };
  }

  const recipientAddress = await resolveCurrentWhatsappRecipient({
    restaurantId: String(restaurant._id),
    customerKey: order.customerKey,
    fallbackAddress: order.customerPhone
  });

  if (!recipientAddress) {
    logMissingCustomerRecipient(
      restaurant,
      order,
      "customer_order_cancellation_resolution_notification"
    );
    return { customerNotification: "failed" };
  }

  const queued = await enqueueWasenderMessage({
    restaurantId: String(restaurant._id),
    sessionId: restaurant.wasenderSessionId,
    to: recipientAddress,
    type: "text",
    text: buildCustomerCancellationResolutionNotification(restaurant, order),
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey: `customer-order-cancellation-resolution:${String(order._id)}:${decision}`,
    metadata: {
      kind: "customer_order_cancellation_resolution_notification",
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      cancellationDecision: decision,
      recipientType: "customer",
      customerPhone: recipientAddress,
      ...(order.customerKey ? { customerKey: order.customerKey } : {})
    }
  });

  return { customerNotification: getCustomerQueueStatus(queued) };
};

export const notifyOwnerOfCustomerAmendment = async (
  restaurant: IRestaurantDocument,
  order: IOrderDocument
): Promise<OrderSideEffectResult> => {
  const amendmentVersion = order.customerAmendmentVersion ?? 0;

  if (
    amendmentVersion < 1 ||
    (order.ownerAmendmentNotifiedVersion ?? 0) >= amendmentVersion
  ) {
    return { ownerNotification: "skipped" };
  }

  await enqueueWasenderMessage({
    restaurantId: String(restaurant._id),
    sessionId: restaurant.wasenderSessionId,
    to: restaurant.ownerPhone,
    type: "text",
    text: buildOwnerOrderAmendedNotification(restaurant, order),
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey: `owner-order-amended:${String(order._id)}:${amendmentVersion}`,
    metadata: {
      kind: "owner_order_amended_notification",
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      amendmentVersion,
      recipientType: "owner"
    }
  });

  return { ownerNotification: "queued" };
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

  const recipientAddress = await resolveCurrentWhatsappRecipient({
    restaurantId: String(restaurant._id),
    customerKey: order.customerKey,
    fallbackAddress: order.customerPhone
  });

  if (!recipientAddress) {
    logMissingCustomerRecipient(
      restaurant,
      order,
      "customer_order_rejected_notification"
    );
    return { customerNotification: "failed" };
  }

  const queued = await enqueueWasenderMessage({
    restaurantId: String(restaurant._id),
    sessionId: restaurant.wasenderSessionId,
    to: recipientAddress,
    type: "text",
    text: buildCustomerOrderRejectedMessage(restaurant, order),
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey: `customer-order-rejected:${String(order._id)}`,
    metadata: {
      kind: "customer_order_rejected_notification",
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      recipientType: "customer",
      customerPhone: recipientAddress,
      ...(order.customerKey ? { customerKey: order.customerKey } : {})
    }
  });

  return {
    customerNotification: getCustomerQueueStatus(queued)
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
  const recipientAddress = await resolveCurrentWhatsappRecipient({
    restaurantId: String(restaurant._id),
    customerKey: receiptOrder.customerKey,
    fallbackAddress: receiptOrder.customerPhone
  });

  if (!recipientAddress) {
    if (!receiptOrder.customerConfirmedNotificationSentAt) {
      result.customerNotification = "failed";
    }
    if (!receiptOrder.receiptSentAt) {
      result.receiptDelivery = "failed";
      receiptOrder.receiptDeliveryFailedAt = new Date();
      receiptOrder.receiptDeliveryFailureReason =
        "no_current_whatsapp_recipient";
      await receiptOrder.save();
    }
    logMissingCustomerRecipient(
      restaurant,
      receiptOrder,
      "customer_order_confirmed_notification_and_receipt"
    );
    return result;
  }

  if (!receiptOrder.customerConfirmedNotificationSentAt) {
    const queuedNotification = await enqueueWasenderMessage({
      restaurantId: String(restaurant._id),
      sessionId: restaurant.wasenderSessionId,
      to: recipientAddress,
      type: "text",
      text: buildCustomerOrderConfirmedMessage(restaurant, receiptOrder, canSendReceipt),
      apiKey: restaurant.wasenderApiToken,
      idempotencyKey: `customer-order-confirmed:${String(receiptOrder._id)}`,
      metadata: {
        kind: "customer_order_confirmed_notification",
        orderId: String(receiptOrder._id),
        orderNumber: receiptOrder.orderNumber,
        recipientType: "customer",
        customerPhone: recipientAddress,
        ...(receiptOrder.customerKey
          ? { customerKey: receiptOrder.customerKey }
          : {})
      }
    });
    result.customerNotification = getCustomerQueueStatus(queuedNotification);
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
    to: recipientAddress,
    type: "document",
    documentUrl: publicReceiptUrl,
    caption: `Receipt for ${getOrderReference(receiptOrder)}`,
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey: `receipt-delivery:${String(receiptOrder._id)}`,
    metadata: {
      kind: "receipt_delivery",
      orderId: String(receiptOrder._id),
      orderNumber: receiptOrder.orderNumber,
      recipientType: "customer",
      customerPhone: recipientAddress,
      ...(receiptOrder.customerKey
        ? { customerKey: receiptOrder.customerKey }
        : {})
    }
  });
  result.receiptDelivery = getCustomerQueueStatus(queuedReceipt);

  if (result.receiptDelivery !== "queued") {
    return result;
  }

  console.info("Receipt queued", {
    restaurantId: String(restaurant._id),
    orderId: String(receiptOrder._id),
    orderNumber: receiptOrder.orderNumber,
    queueMessageId: String(queuedReceipt._id)
  });

  // After the receipt is successfully queued, schedule the marketing opt-in
  // message with a short delay so it arrives after the receipt, not alongside it.
  tryQueueMarketingConsentAfterReceipt(
    restaurant,
    receiptOrder,
    recipientAddress
  ).catch(
    (error) => {
      console.error("Marketing consent request after receipt failed", {
        restaurantId: String(restaurant._id),
        orderId: String(receiptOrder._id),
        orderNumber: receiptOrder.orderNumber,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  );

  return result;
};

/**
 * Schedules the marketing opt-in message to be sent after a short delay
 * following successful receipt delivery. The core queueMarketingConsentRequest
 * function handles all deduplication (already prompted, already opted in/out)
 * so calling this multiple times is safe.
 */
const tryQueueMarketingConsentAfterReceipt = async (
  restaurant: IRestaurantDocument,
  order: IOrderDocument,
  recipientAddress?: string
): Promise<void> => {
  const nextAttemptAt = new Date(Date.now() + MARKETING_CONSENT_DELAY_MS);
  await queueMarketingConsentRequest(
    {
      restaurantId: String(restaurant._id),
      customerPhone: recipientAddress ?? order.customerPhone,
      customerKey: order.customerKey,
      source: "post_order",
      orderId: String(order._id)
    },
    {
      // Pass a custom enqueueMessage so we can inject the nextAttemptAt delay.
      enqueueMessage: (input) =>
        enqueueWasenderMessage({ ...input, nextAttemptAt })
    }
  );
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
