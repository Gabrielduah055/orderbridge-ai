import { Order } from "../models/order.model";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { updateOrderStatus } from "./order.service";
import { notifyOwnerOfCompletedOrder } from "./orderSideEffects.service";
import { enqueueWasenderMessage } from "./wasenderQueue.service";

const SCHEDULER_INTERVAL_MS = 60_000;
const DEFAULT_DELAY_MINUTES = 45;

// Statuses that are terminal — no point sending a follow-up
const skipStatuses = [
  "cancelled",
  "rejected",
  "expired",
  "collecting_details",
  "awaiting_delivery_fee",
  "awaiting_customer_confirmation",
  "awaiting_restaurant_confirmation"
] as const;

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
    // Fix A: use $ne: false so existing restaurants (field = undefined) are included
    const restaurants = await Restaurant.find({
      postDeliveryFollowUpEnabled: { $ne: false },
      wasenderSessionId: { $exists: true, $ne: "" },
      wasenderApiToken: { $exists: true, $ne: "" }
    }).select(
      "_id name ownerPhone postDeliveryFollowUpDelayMinutes wasenderSessionId +wasenderApiToken"
    );

    if (restaurants.length === 0) {
      return;
    }

    const restaurantMap = new Map<string, IRestaurantDocument>(
      restaurants.map((r) => [String(r._id), r])
    );

    const now = new Date();

    // Fix B: trigger on receiptSentAt (not order status)
    // Once the receipt reaches the customer, the follow-up clock starts
    const orders = await Order.find({
      restaurantId: { $in: Array.from(restaurantMap.keys()) },
      receiptSentAt: { $exists: true, $ne: null },
      deliveryFollowUpSentAt: { $exists: false },
      status: { $nin: [...skipStatuses] }
    }).select(
      "_id restaurantId customerPhone customerName orderNumber orderType " +
        "deliveryAddress total status completedAt receiptSentAt " +
        "deliveryFollowUpSentAt ownerCompletionNotifiedAt"
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

        // Use receiptSentAt as the start of the delay window
        const elapsed = now.getTime() - order.receiptSentAt!.getTime();

        if (elapsed < delayMs) {
          continue;
        }

        const orderId = String(order._id);

        // Option C — Auto-complete: mark order as completed if not already done
        if (order.status !== "completed") {
          try {
            await updateOrderStatus(orderId, "completed");
            console.info("[postDeliveryFollowUp] Order auto-completed", {
              restaurantId: String(restaurant._id),
              orderId,
              orderNumber: order.orderNumber
            });
          } catch (completionError) {
            console.error(
              `[postDeliveryFollowUp] Could not auto-complete order ${orderId}:`,
              completionError
            );
            // Still proceed to send follow-up even if auto-complete failed
          }
        }

        // Bug 3 — Notify owner that order is done
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

        // Bug 2 — Send follow-up to customer
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
          idempotencyKey: `delivery-follow-up:${orderId}`,
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
