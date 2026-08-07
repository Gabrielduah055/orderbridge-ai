import { Order, type IOrderDocument } from "../models/order.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import {
  completeOrderThroughFeedback,
  feedbackCompletionEligibleStatuses
} from "./orderCompletion.service";
import {
  buildOrderFeedbackQueueMetadata,
  buildOrderFeedbackReminderMessage,
  getOrderAutoCompleteHours,
  getOrderFeedbackReminderHours,
  getOrderFeedbackReminderIdempotencyKey,
  getQueuedOrderFeedbackStaleReason,
  scheduleOrderFeedbackFollowUp,
  type OrderFeedbackEnqueue
} from "./orderFeedbackQueue.service";
import { enqueueWasenderMessage } from "./wasenderQueue.service";

const ORDER_FEEDBACK_SCHEDULER_INTERVAL_MS = 60_000;
export const ORDER_FEEDBACK_BATCH_SIZE = 50;
export const ORDER_FEEDBACK_MAX_MESSAGES_PER_PASS = 25;
export const ORDER_FEEDBACK_RESTAURANT_BATCH_SIZE = 100;
let schedulerStarted = false;
let schedulerBusy = false;
let schedulerPassLogged = false;

type FeedbackRestaurant = Pick<
  IRestaurantDocument,
  | "_id"
  | "name"
  | "status"
  | "wasenderSessionId"
  | "wasenderApiToken"
>;

export interface OrderFeedbackSchedulerDependencies {
  loadRestaurants?: () => Promise<FeedbackRestaurant[]>;
  findSchedulingCandidates?: (
    restaurantId: string,
    limit: number
  ) => Promise<IOrderDocument[]>;
  findReminderCandidates?: (
    restaurantId: string,
    now: Date,
    limit: number
  ) => Promise<IOrderDocument[]>;
  findAutoCompletionCandidates?: (
    restaurantId: string,
    now: Date,
    limit: number
  ) => Promise<IOrderDocument[]>;
  enqueueMessage?: OrderFeedbackEnqueue;
  scheduleFollowUp?: typeof scheduleOrderFeedbackFollowUp;
  queueReminder?: typeof queueOrderFeedbackReminder;
  completeOrder?: typeof completeOrderThroughFeedback;
  cancelStaleMessages?: (limit: number) => Promise<number>;
  logError?: (message: string, context: Record<string, unknown>) => void;
}

export interface OrderFeedbackSchedulerPassResult {
  restaurantsChecked: number;
  ordersChecked: number;
  followUpsScheduled: number;
  remindersQueued: number;
  ordersAutomaticallyCompleted: number;
  staleMessagesCancelled: number;
  errors: number;
}

const loadActiveRestaurants = async (): Promise<FeedbackRestaurant[]> => {
  return Restaurant.find({
    status: { $in: ["trial", "active"] },
    wasenderSessionId: { $exists: true, $ne: "" },
    wasenderApiToken: { $exists: true, $ne: "" }
  })
    .sort({ _id: 1 })
    .limit(ORDER_FEEDBACK_RESTAURANT_BATCH_SIZE)
    .select("+wasenderApiToken");
};

export const findOrderFeedbackSchedulingCandidates = async (
  restaurantId: string,
  limit = ORDER_FEEDBACK_BATCH_SIZE
): Promise<IOrderDocument[]> => {
  return Order.find({
    restaurantId,
    status: { $in: feedbackCompletionEligibleStatuses },
    feedbackReceivedAt: { $exists: false },
    $and: [
      {
        $or: [
          { feedbackFollowUpStatus: "not_scheduled" },
          { feedbackFollowUpStatus: { $exists: false } }
        ]
      },
      {
        $or: [
          { customerConfirmedNotificationSentAt: { $exists: true } },
          { receiptSentAt: { $exists: true } }
        ]
      }
    ]
  })
    .sort({ customerConfirmedNotificationSentAt: 1, receiptSentAt: 1 })
    .limit(Math.max(1, Math.min(limit, ORDER_FEEDBACK_BATCH_SIZE)));
};

export const findOrderFeedbackReminderCandidates = async (
  restaurantId: string,
  now = new Date(),
  limit = ORDER_FEEDBACK_BATCH_SIZE
): Promise<IOrderDocument[]> => {
  const cutoff = new Date(
    now.getTime() - getOrderFeedbackReminderHours() * 60 * 60_000
  );

  return Order.find({
    restaurantId,
    status: { $in: feedbackCompletionEligibleStatuses },
    feedbackFollowUpStatus: "requested",
    feedbackRequestSentAt: { $lte: cutoff },
    feedbackReminderSentAt: { $exists: false },
    feedbackReceivedAt: { $exists: false }
  })
    .sort({ feedbackRequestSentAt: 1 })
    .limit(Math.max(1, Math.min(limit, ORDER_FEEDBACK_BATCH_SIZE)));
};

export const findOrderFeedbackAutoCompletionCandidates = async (
  restaurantId: string,
  now = new Date(),
  limit = ORDER_FEEDBACK_BATCH_SIZE
): Promise<IOrderDocument[]> => {
  const cutoff = new Date(
    now.getTime() - getOrderAutoCompleteHours() * 60 * 60_000
  );

  return Order.find({
    restaurantId,
    status: { $in: feedbackCompletionEligibleStatuses },
    feedbackFollowUpStatus: "requested",
    feedbackRequestSentAt: { $lte: cutoff },
    feedbackReceivedAt: { $exists: false }
  })
    .sort({ feedbackRequestSentAt: 1 })
    .limit(Math.max(1, Math.min(limit, ORDER_FEEDBACK_BATCH_SIZE)));
};

export const cancelStaleQueuedOrderFeedbackMessages = async (
  limit = ORDER_FEEDBACK_BATCH_SIZE
): Promise<number> => {
  const messages = await OutboundMessage.find({
    status: "pending",
    "metadata.kind": {
      $in: ["order_feedback_request", "order_feedback_reminder"]
    }
  })
    .sort({ nextAttemptAt: 1, createdAt: 1 })
    .limit(Math.max(1, Math.min(limit, ORDER_FEEDBACK_BATCH_SIZE)))
    .select("+apiKey");
  let cancelled = 0;

  for (const message of messages) {
    try {
      const staleReason = await getQueuedOrderFeedbackStaleReason(message);

      if (!staleReason) {
        continue;
      }

      const result = await OutboundMessage.updateOne(
        { _id: message._id, status: "pending" },
        {
          $set: {
            status: "cancelled",
            lastError: `Stale order feedback message: ${staleReason}`
          }
        }
      );
      cancelled += result.modifiedCount;
    } catch (error) {
      console.error("Order feedback stale-message check failed", {
        queueMessageId: String(message._id),
        error:
          error instanceof Error
            ? error.message
            : "Unknown feedback stale-message error"
      });
    }
  }

  return cancelled;
};

export const queueOrderFeedbackReminder = async (
  restaurant: FeedbackRestaurant,
  selectedOrder: IOrderDocument,
  enqueueMessage: OrderFeedbackEnqueue,
  now = new Date()
): Promise<boolean> => {
  const restaurantId = String(restaurant._id);
  const orderId = String(selectedOrder._id);
  const order = await Order.findOne({
    _id: orderId,
    restaurantId,
    status: { $in: feedbackCompletionEligibleStatuses },
    feedbackFollowUpStatus: "requested",
    feedbackReceivedAt: { $exists: false },
    feedbackReminderSentAt: { $exists: false }
  });

  if (!order?.feedbackRequestSentAt) {
    return false;
  }

  const dueAt = new Date(
    order.feedbackRequestSentAt.getTime() +
      getOrderFeedbackReminderHours() * 60 * 60_000
  );

  if (dueAt > now) {
    return false;
  }

  const idempotencyKey = getOrderFeedbackReminderIdempotencyKey(
    orderId,
    order.feedbackFollowUpVersion
  );
  const existing = await OutboundMessage.exists({
    restaurantId,
    idempotencyKey
  });

  if (existing) {
    return false;
  }

  await enqueueMessage({
    restaurantId,
    sessionId: restaurant.wasenderSessionId,
    to: order.customerPhone,
    type: "text",
    text: buildOrderFeedbackReminderMessage(restaurant, order),
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey,
    nextAttemptAt: now,
    metadata: buildOrderFeedbackQueueMetadata(
      order,
      "order_feedback_reminder",
      order.feedbackFollowUpVersion
    )
  });

  return true;
};

export const runOrderFeedbackSchedulerPass = async (
  now = new Date(),
  dependencies: OrderFeedbackSchedulerDependencies = {}
): Promise<OrderFeedbackSchedulerPassResult> => {
  const loadRestaurants = dependencies.loadRestaurants ?? loadActiveRestaurants;
  const findSchedulingCandidates =
    dependencies.findSchedulingCandidates ??
    findOrderFeedbackSchedulingCandidates;
  const findReminderCandidates =
    dependencies.findReminderCandidates ?? findOrderFeedbackReminderCandidates;
  const findAutoCompletionCandidates =
    dependencies.findAutoCompletionCandidates ??
    findOrderFeedbackAutoCompletionCandidates;
  const enqueueMessage = dependencies.enqueueMessage ?? enqueueWasenderMessage;
  const scheduleFollowUp =
    dependencies.scheduleFollowUp ?? scheduleOrderFeedbackFollowUp;
  const queueReminder =
    dependencies.queueReminder ?? queueOrderFeedbackReminder;
  const completeOrder =
    dependencies.completeOrder ?? completeOrderThroughFeedback;
  const cancelStaleMessages =
    dependencies.cancelStaleMessages ??
    cancelStaleQueuedOrderFeedbackMessages;
  const logError =
    dependencies.logError ??
    ((message: string, context: Record<string, unknown>) =>
      console.error(message, context));
  const restaurants = await loadRestaurants();
  const result: OrderFeedbackSchedulerPassResult = {
    restaurantsChecked: restaurants.length,
    ordersChecked: 0,
    followUpsScheduled: 0,
    remindersQueued: 0,
    ordersAutomaticallyCompleted: 0,
    staleMessagesCancelled: 0,
    errors: 0
  };
  let messagesQueued = 0;

  try {
    result.staleMessagesCancelled = await cancelStaleMessages(
      ORDER_FEEDBACK_BATCH_SIZE
    );
  } catch (error) {
    result.errors += 1;
    logError("Order feedback stale-message cancellation failed", {
      error:
        error instanceof Error
          ? error.message
          : "Unknown feedback cancellation error"
    });
  }

  for (const restaurant of restaurants) {
    const restaurantId = String(restaurant._id);
    const remainingBatch = Math.max(
      0,
      ORDER_FEEDBACK_BATCH_SIZE - result.ordersChecked
    );

    if (remainingBatch === 0) {
      break;
    }

    try {
      const candidates = await findSchedulingCandidates(
        restaurantId,
        remainingBatch
      );

      for (const order of candidates) {
        if (
          result.ordersChecked >= ORDER_FEEDBACK_BATCH_SIZE ||
          messagesQueued >= ORDER_FEEDBACK_MAX_MESSAGES_PER_PASS
        ) {
          break;
        }

        result.ordersChecked += 1;

        try {
          const scheduled = await scheduleFollowUp(
            restaurantId,
            String(order._id),
            { enqueueMessage },
            now
          );

          if (scheduled.scheduled) {
            result.followUpsScheduled += 1;
            messagesQueued += 1;
          }
        } catch (error) {
          result.errors += 1;
          logError("Order feedback scheduling failed", {
            restaurantId,
            orderId: String(order._id),
            error:
              error instanceof Error
                ? error.message
                : "Unknown feedback scheduling error"
          });
        }
      }
    } catch (error) {
      result.errors += 1;
      logError("Order feedback scheduling lookup failed", {
        restaurantId,
        error:
          error instanceof Error
            ? error.message
            : "Unknown feedback scheduling lookup error"
      });
    }

    if (
      result.ordersChecked < ORDER_FEEDBACK_BATCH_SIZE &&
      messagesQueued < ORDER_FEEDBACK_MAX_MESSAGES_PER_PASS
    ) {
      try {
        const reminders = await findReminderCandidates(
          restaurantId,
          now,
          ORDER_FEEDBACK_BATCH_SIZE - result.ordersChecked
        );

        for (const order of reminders) {
          if (
            result.ordersChecked >= ORDER_FEEDBACK_BATCH_SIZE ||
            messagesQueued >= ORDER_FEEDBACK_MAX_MESSAGES_PER_PASS
          ) {
            break;
          }

          result.ordersChecked += 1;

          try {
            if (
              await queueReminder(
                restaurant,
                order,
                enqueueMessage,
                now
              )
            ) {
              result.remindersQueued += 1;
              messagesQueued += 1;
            }
          } catch (error) {
            result.errors += 1;
            logError("Order feedback reminder failed", {
              restaurantId,
              orderId: String(order._id),
              error:
                error instanceof Error
                  ? error.message
                  : "Unknown feedback reminder error"
            });
          }
        }
      } catch (error) {
        result.errors += 1;
        logError("Order feedback reminder lookup failed", {
          restaurantId,
          error:
            error instanceof Error
              ? error.message
              : "Unknown feedback reminder lookup error"
        });
      }
    }

    if (result.ordersChecked < ORDER_FEEDBACK_BATCH_SIZE) {
      try {
        const autoCompletionCandidates =
          await findAutoCompletionCandidates(
            restaurantId,
            now,
            ORDER_FEEDBACK_BATCH_SIZE - result.ordersChecked
          );

        for (const order of autoCompletionCandidates) {
          if (result.ordersChecked >= ORDER_FEEDBACK_BATCH_SIZE) {
            break;
          }

          result.ordersChecked += 1;

          try {
            const completed = await completeOrder({
              restaurantId,
              orderId: String(order._id),
              completionSource: "automatic_timeout",
              completionConfirmedByCustomer: false,
              completedAt: now
            });

            if (!completed.idempotent) {
              result.ordersAutomaticallyCompleted += 1;
            }
          } catch (error) {
            const code =
              error && typeof error === "object" && "code" in error
                ? String((error as { code?: unknown }).code)
                : "";

            if (code === "ORDER_AUTO_COMPLETION_BLOCKED") {
              continue;
            }

            result.errors += 1;
            logError("Order automatic feedback completion failed", {
              restaurantId,
              orderId: String(order._id),
              error:
                error instanceof Error
                  ? error.message
                  : "Unknown automatic completion error"
            });
          }
        }
      } catch (error) {
        result.errors += 1;
        logError("Order automatic feedback completion lookup failed", {
          restaurantId,
          error:
            error instanceof Error
              ? error.message
              : "Unknown automatic completion lookup error"
        });
      }
    }
  }

  return result;
};

export const startOrderFeedbackScheduler = (): void => {
  if (schedulerStarted) {
    return;
  }

  schedulerStarted = true;
  console.log(
    `[orderFeedback] Scheduler started (check every ${ORDER_FEEDBACK_SCHEDULER_INTERVAL_MS / 1000}s)`
  );

  const runPass = (): void => {
    if (schedulerBusy) {
      return;
    }

    schedulerBusy = true;
    void runOrderFeedbackSchedulerPass()
      .then((result) => {
        if (
          !schedulerPassLogged ||
          result.followUpsScheduled > 0 ||
          result.remindersQueued > 0 ||
          result.ordersAutomaticallyCompleted > 0 ||
          result.staleMessagesCancelled > 0 ||
          result.errors > 0
        ) {
          console.info("[orderFeedback] Scheduler pass", {
            eligibleRestaurants: result.restaurantsChecked,
            ordersChecked: result.ordersChecked,
            followUpsScheduled: result.followUpsScheduled,
            remindersQueued: result.remindersQueued,
            ordersAutomaticallyCompleted: result.ordersAutomaticallyCompleted,
            staleMessagesCancelled: result.staleMessagesCancelled,
            errors: result.errors
          });
          schedulerPassLogged = true;
        }
      })
      .catch((error) => {
        console.error("Order feedback scheduler pass failed", {
          error:
            error instanceof Error
              ? error.message
              : "Unknown order feedback scheduler error"
        });
      })
      .finally(() => {
        schedulerBusy = false;
      });
  };

  runPass();
  const timer = setInterval(
    runPass,
    ORDER_FEEDBACK_SCHEDULER_INTERVAL_MS
  );
  timer.unref?.();
};
