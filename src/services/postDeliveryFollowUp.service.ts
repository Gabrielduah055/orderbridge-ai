import { Order } from "../models/order.model";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import { normalizeGhanaPhone } from "../utils/phone.util";
import {
  notifyOwnerOfCompletedOrder
} from "./orderSideEffects.service";
import { enqueueWasenderMessage } from "./wasenderQueue.service";

const SCHEDULER_INTERVAL_MS = 60_000;
const DEFAULT_DELAY_MINUTES = 45;

// Statuses that mean the order has been handed off to the customer
const completedStatuses = ["completed", "out_for_delivery", "ready"] as const;

const buildCustomerDeliveryFollowUpMessage = (
  restaurantName: string,
  customerName?: string
): string => {
  const greeting = customerName ? `Hi ${customerName}` : "Hi there";

  return [
    `${greeting} 👋`,
    "",
    `This is a follow-up from ${restaurantName}.`,
    "Did you receive your order? We hope everything was great! 😊",
    "",
    "We'd love to hear your feedback — feel free to reply with a quick review or any suggestions. Your input helps us serve you better!"
  ].join("\n");
};

const runPostDeliveryFollowUpPass = async (): Promise<void> => {
  try {
    const restaurants = await Restaurant.find({
      postDeliveryFollowUpEnabled: true,
      wasenderSessionId: { $exists: true, $ne: "" },
      wasenderApiToken: { $exists: true, $ne: "" }
    }).select(
      "_id name ownerPhone postDeliveryFollowUpDelayMinutes wasenderSessionId wasenderApiToken"
    );

    if (restaurants.length === 0) {
      return;
    }

    const restaurantMap = new Map<string, IRestaurantDocument>(
      restaurants.map((r) => [String(r._id), r])
    );

    const now = new Date();

    // Find completed orders that haven't had a follow-up sent yet
    const orders = await Order.find({
      restaurantId: { $in: Array.from(restaurantMap.keys()) },
      status: { $in: [...completedStatuses] },
      deliveryFollowUpSentAt: { $exists: false }
    }).select(
      "_id restaurantId customerPhone customerName orderNumber orderType " +
        "deliveryAddress total completedAt updatedAt deliveryFollowUpSentAt ownerCompletionNotifiedAt"
    );

    for (const order of orders) {
      try {
        const restaurant = restaurantMap.get(String(order.restaurantId));

        if (!restaurant) {
          continue;
        }

        const delayMinutes =
          restaurant.postDeliveryFollowUpDelayMinutes ?? DEFAULT_DELAY_MINUTES;
        const delayMs = delayMinutes * 60 * 1000;

        // Use completedAt if set, otherwise fall back to updatedAt
        const completionTime = order.completedAt ?? order.updatedAt;
        const elapsedMs = now.getTime() - completionTime.getTime();

        if (elapsedMs < delayMs) {
          continue;
        }

        const orderId = String(order._id);

        // ── Bug 3: Notify owner that order is done (if not already done) ──
        if (!order.ownerCompletionNotifiedAt) {
          try {
            await notifyOwnerOfCompletedOrder(restaurant, order);
            order.ownerCompletionNotifiedAt = now;
          } catch (ownerError) {
            console.error(
              `[postDeliveryFollowUp] Failed to notify owner for order ${orderId}:`,
              ownerError
            );
          }
        }

        // ── Bug 2: Send follow-up to customer asking for receipt confirmation ──
        const idempotencyKey = `delivery-follow-up:${orderId}`;

        await enqueueWasenderMessage({
          restaurantId: String(restaurant._id),
          sessionId: restaurant.wasenderSessionId,
          to: normalizeGhanaPhone(order.customerPhone),
          type: "text",
          text: buildCustomerDeliveryFollowUpMessage(
            restaurant.name,
            order.customerName
          ),
          apiKey: restaurant.wasenderApiToken,
          idempotencyKey,
          metadata: {
            kind: "delivery_follow_up",
            orderId,
            orderNumber: order.orderNumber,
            recipientType: "customer"
          }
        });

        order.deliveryFollowUpSentAt = now;
        await order.save();

        console.info("[postDeliveryFollowUp] Follow-up queued", {
          restaurantId: String(restaurant._id),
          orderId,
          orderNumber: order.orderNumber,
          customerPhone: order.customerPhone
        });
      } catch (orderError) {
        console.error(
          `[postDeliveryFollowUp] Error processing order ${String(order._id)}:`,
          orderError
        );
      }
    }
  } catch (error) {
    console.error("[postDeliveryFollowUp] Scheduler pass failed:", error);
  }
};

export const startPostDeliveryFollowUpScheduler = (): void => {
  console.log(
    `[postDeliveryFollowUp] Scheduler started (check every ${SCHEDULER_INTERVAL_MS / 1000}s)`
  );
  void runPostDeliveryFollowUpPass();
  setInterval(() => void runPostDeliveryFollowUpPass(), SCHEDULER_INTERVAL_MS);
};
